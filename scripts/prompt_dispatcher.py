#!/usr/bin/env python3
"""Fire due scheduled-prompt jobs into their tmux sessions.

Companion to routes/terminal.py's /api/terminal/schedule* endpoints, which
only manage the job queue (scheduled_prompts.json). This script does the
actual work: "I tell it what to put in a specific terminal, and then that
terminal guns it at that time" — e.g. queue a prompt tonight, have Claude
start working on it before she wakes up.

Meant to be run by cron every minute:

    * * * * * /usr/bin/python3 /opt/exocortex/skeleton/scripts/prompt_dispatcher.py

(The owner wires up the actual crontab — this script just needs to be runnable
by system python3 with no venv/third-party deps.)

Each run: read scheduled_prompts.json, find pending jobs whose `at` has
passed, ensure the target tmux session exists running `claude` (spawning it
cwd'd into /opt/exocortex if it's new — mirrors
routes/kitchen/shared.ensure_claude_session), type the prompt + Enter into it
(mirrors shared.send_prompt, but synchronously — no background thread, since
a one-shot cron script has nothing to stay alive for), and mark the job
sent. A job that blows up for any reason (bad session name, empty prompt,
tmux failure, ...) is marked "error" with the exception message — one bad
job never stops the rest of the batch or crashes the run.

Dependency-free (stdlib only) so cron can run it with plain system python3,
no venv required.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent

# Resolve the data dir the same way store.py does. Prefer actually importing
# store (so we get its atomic write()/read() for free and stay in lockstep
# with any future change to how DATA_DIR is resolved); fall back to
# reimplementing the same EXOCORTEX_DATA_DIR-with-default logic + a
# temp-file-then-os.replace atomic write if store can't be imported (e.g. run
# from somewhere sys.path can't find it).
try:
    sys.path.insert(0, str(REPO_ROOT))
    import store  # noqa: E402  (repo's atomic JSON layer; stdlib-only itself)
except Exception:
    store = None

if store is not None:
    DATA_DIR = store.DATA_DIR
else:
    DATA_DIR = Path(os.environ.get("EXOCORTEX_DATA_DIR", str(REPO_ROOT / "data")))

JOBS_FILE = "scheduled_prompts.json"
SESSIONS_FILE = "sessions.json"
TMUX_SOCKET = "/tmp/tmux-1000/default"
SPAWN_CWD = Path("/opt/exocortex")
SETTLE_DELAY = 4.0  # seconds to let `claude` finish loading before typing into a brand-new session
AT_FORMAT = "%Y-%m-%d %H:%M"

# Same slug-safety shape the /api/terminal/schedule/add route enforces before
# a job is ever queued — re-checked here too, since this script also trusts
# whatever is sitting in the JSON file (defense in depth: this string gets
# interpolated into a shell=True tmux command).
_SESSION_RE = re.compile(r'^[a-z0-9-]{1,30}$')


# --- Data I/O (store.py if importable, else a local atomic-write fallback) --

def _atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def read_json(name, default):
    if store is not None:
        return store.read(name, default)
    path = DATA_DIR / name
    if not path.exists():
        return default
    return json.loads(path.read_text())


def write_json(name, data):
    if store is not None:
        store.write(name, data)
        return
    _atomic_write(DATA_DIR / name, data)


# --- tmux (mirrors routes/kitchen/shared.py's tmux/ensure_claude_session/send_prompt) ---

def tmux(cmd_str):
    return subprocess.run(
        f"tmux -S {TMUX_SOCKET} {cmd_str}",
        shell=True, capture_output=True, text=True, timeout=10,
    )


def ensure_session(name):
    """Create the named tmux session running `claude` (cwd /opt/exocortex) if
    it doesn't exist yet, registering it in sessions.json so the terminal UI
    lists it. Returns True if the session was newly spawned."""
    sessions = read_json(SESSIONS_FILE, [])
    if not isinstance(sessions, list):
        sessions = []
    if name not in sessions:
        sessions.append(name)
        write_json(SESSIONS_FILE, sessions)
    check = tmux(f"has-session -t {shlex.quote(name)}")
    if check.returncode != 0:
        SPAWN_CWD.mkdir(parents=True, exist_ok=True)
        tmux(f"new-session -d -s {shlex.quote(name)} -c {shlex.quote(str(SPAWN_CWD))} 'claude'")
        return True
    return False


def send_prompt(session, text):
    """Type `text` into `session` and hit Enter — synchronous, no thread (a
    cron-run script has no reason to background this)."""
    safe = text.replace("'", "'\\''")
    tmux(f"send-keys -t {shlex.quote(session)} -l '{safe}'")
    tmux(f"send-keys -t {shlex.quote(session)} Enter")


# --- Job selection + dispatch ------------------------------------------------

def _parse_at(value):
    return datetime.strptime(value, AT_FORMAT)


def due_jobs(jobs, now):
    """Pending jobs whose `at` has passed (<= now). A job with an unparsable
    `at` is not "due" — it's surfaced as an error by process_due_jobs instead."""
    out = []
    for job in jobs:
        if not isinstance(job, dict) or job.get("status") != "pending":
            continue
        try:
            at = _parse_at(job.get("at", ""))
        except (TypeError, ValueError):
            continue
        if at <= now:
            out.append(job)
    return out


def process_due_jobs(now=None):
    """Read scheduled_prompts.json, dispatch every due pending job, write the
    result back (only if something changed). Returns the full data dict.

    Each job is handled inside its own try/except: a bad session name, empty
    prompt, unparsable `at`, or tmux failure marks that job "error" (with an
    `error` message) and moves on — it never aborts the batch."""
    now = now or datetime.now()
    data = read_json(JOBS_FILE, {"jobs": []})
    jobs = data.setdefault("jobs", [])
    changed = False

    for job in jobs:
        if not isinstance(job, dict) or job.get("status") != "pending":
            continue
        try:
            at = _parse_at(job.get("at", ""))
        except (TypeError, ValueError) as e:
            job["status"] = "error"
            job["error"] = f"bad 'at' value: {e}"
            changed = True
            continue
        if at > now:
            continue  # not due yet

        try:
            session = job.get("session", "")
            prompt = job.get("prompt", "")
            if not _SESSION_RE.match(session or ""):
                raise ValueError(f"invalid session name: {session!r}")
            if not (prompt or "").strip():
                raise ValueError("empty prompt")
            newly_spawned = ensure_session(session)
            if newly_spawned:
                time.sleep(SETTLE_DELAY)  # let `claude` finish loading before we type
            send_prompt(session, prompt)
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)
        else:
            job["status"] = "sent"
            job["sent_at"] = now.strftime(AT_FORMAT)
            job.pop("error", None)
        changed = True

    if changed:
        write_json(JOBS_FILE, data)
    return data


def main():
    process_due_jobs()


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    main()
