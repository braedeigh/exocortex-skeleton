#!/usr/bin/env python3
"""Run a long job in the background, then wake the session that started it.

**What this does, in plain English.** An Observatory turn is one `claude -p`
process, and anything it starts "in the background" dies when that turn ends —
so a test suite or build that outlives the reply is killed halfway, and even
when it survives there's no Claude left to tell. This script is the door
around both halves:

  1. It starts the command in its own process session (`setsid`), so the job
     no longer belongs to the turn and keeps running after the reply ends.
  2. A small watcher process waits for it, writing all output to a log file.
  3. When the job exits, the watcher puts ONE system message into the same
     conversation — command, exit code, how long it took, the log's tail —
     through the Observatory's follow-up queue. That starts a fresh turn with
     the conversation's full history, which picks the work back up.

If the conversation is mid-reply when the job ends, the message waits in the
queue and goes in the moment that reply finishes (or within a minute, from the
cron'd safety net in scripts/coming_up_dispatcher.py). The chat shows it as a
System bubble and the journal records it as an S card, never as her words.

    ./venv/bin/python3 scripts/run_detached.py --label "full test suite" -- \
        ./venv/bin/python3 -m pytest -q

Prints one JSON line (job id, log path, job dir) and returns at once. The
conversation id comes from EXOCORTEX_CONV_ID, which every Observatory turn has
in its environment (routes/observatory.py `_spawn`); `--conv` overrides it.

What it can't survive: `systemctl restart exocortex` — that kills every process
in the service's cgroup, and `setsid` doesn't leave the cgroup. A reload is fine.

Touches: `routes/observatory.py` (queue_followup — the follow-up queue and the
System-bubble rendering), the job folders under JOBS_DIR,
`tests/test_run_detached.py`.

Prompt that produced this: "I'm wanting to make it such that running in the
background starts back up ... run a poller on the job to check on it and tell
the claude to start again if it's done?" / "happens all the time across
sessions".
"""
import argparse
import json
import os
import secrets
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Where each job's folder (meta.json + output.log) lives. Temp space by
# default: the logs matter until the woken turn has read them, not forever.
JOBS_DIR = Path(os.environ.get("EXOCORTEX_JOBS_DIR")
                or Path(tempfile.gettempdir()) / "exo-jobs")

# How much of the log's end goes into the wake-up message itself, so the woken
# turn usually knows the outcome without opening the file.
TAIL_LINES = 40
TAIL_CHARS = 4000

# The `source` stamped on the System bubble, so the chat labels it as a
# finished job rather than a reminder somebody set.
SOURCE = "run_detached"


def _write_meta(job_dir, meta):
    """Save the job's record atomically (write a temp file, then rename)."""
    tmp = job_dir / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    os.replace(tmp, job_dir / "meta.json")


def _read_meta(job_dir):
    return json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))


def launch(argv, conv_id, label=None, cwd=None):
    """Start the watcher for `argv`, detached, and return the job's record.

    The watcher is this same script re-run with `--watch <job dir>`, in a new
    process session with no terminal attached — which is what lets it outlive
    the turn that called this."""
    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True)
    meta = {
        "id": job_id, "conv_id": conv_id, "argv": list(argv),
        "label": label or shlex.join(argv)[:80],
        "cwd": str(Path(cwd or os.getcwd()).resolve()),
        "log": str(job_dir / "output.log"),
        "queued_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    _write_meta(job_dir, meta)
    watcher = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--watch", str(job_dir)],
        start_new_session=True, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"job": job_id, "log": meta["log"], "dir": str(job_dir),
            "watcher_pid": watcher.pid, "conv_id": conv_id}


def _tail(log_path):
    """The last TAIL_LINES lines of the log, capped at TAIL_CHARS."""
    try:
        text = Path(log_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    tail = "\n".join(text.rstrip("\n").splitlines()[-TAIL_LINES:])
    return tail[-TAIL_CHARS:]


def _duration(seconds):
    minutes, secs = divmod(int(round(seconds)), 60)
    return f"{minutes}m {secs}s" if minutes else f"{secs}s"


def wake_message(meta):
    """What the woken turn is told, and how the chat and journal show it.

    Returns (text, system): `text` is the model's prompt; `system` is the
    follow-up queue's System-turn dict — `display` for the chat bubble,
    `journal` for the S card."""
    outcome = (f"exit {meta['exit_code']}" if meta.get("error") is None
               else f"couldn't start: {meta['error']}")
    summary = (f"Background job finished — {meta['label']}: {outcome} "
               f"after {_duration(meta.get('seconds', 0))}")
    tail = _tail(meta["log"])
    text = (
        "[Background job finished — you started it with scripts/run_detached.py]\n"
        f"Job: {meta['label']}\n"
        f"Command: {shlex.join(meta['argv'])}  (cwd: {meta['cwd']})\n"
        f"Result: {outcome} after {_duration(meta.get('seconds', 0))}\n"
        f"Full log: {meta['log']}\n\n"
        f"Last lines of the log:\n{tail or '(empty)'}\n\n"
        "Pick up where you left off with it."
    )
    system = {"display": summary, "journal": summary, "source": SOURCE,
              "item_id": meta["id"]}
    return text, system


def watch(job_dir):
    """Run the job to completion, then queue the wake-up. Runs in the
    detached watcher process; every outcome ends up in meta.json."""
    job_dir = Path(job_dir)
    meta = _read_meta(job_dir)
    started = time.time()

    # Run the job with all its output in the log. A command that can't even
    # start (not found, bad cwd) still wakes the session, with the reason.
    meta["error"] = None
    with open(meta["log"], "wb") as log:
        try:
            proc = subprocess.Popen(meta["argv"], cwd=meta["cwd"],
                                    stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT)
        except OSError as exc:
            meta["error"] = str(exc)
            meta["exit_code"] = None
        else:
            meta["pid"] = proc.pid
            _write_meta(job_dir, meta)
            meta["exit_code"] = proc.wait()
    meta["seconds"] = round(time.time() - started, 1)
    meta["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    _write_meta(job_dir, meta)

    # Wake the conversation through the follow-up queue — once. Imported only
    # now, so a broken app import can't stop the job itself from running.
    text, system = wake_message(meta)
    try:
        from routes import observatory
        meta["wake"] = observatory.queue_followup(meta["conv_id"], text, system=system)
    except Exception as exc:        # recorded, never raised: nobody is listening
        meta["wake"] = f"failed: {exc!r}"
    _write_meta(job_dir, meta)
    return meta


def main(args=None):
    parser = argparse.ArgumentParser(
        description="Run a command detached; wake this conversation when it ends.")
    parser.add_argument("--label", help="short name for the job, shown in the chat")
    parser.add_argument("--conv", help="conversation to wake (default: EXOCORTEX_CONV_ID)")
    parser.add_argument("--cwd", help="directory to run in (default: the current one)")
    parser.add_argument("--watch", help=argparse.SUPPRESS)   # the watcher's own entry
    parser.add_argument("command", nargs=argparse.REMAINDER)
    opts = parser.parse_args(args)

    if opts.watch:
        watch(opts.watch)
        return 0

    # Refuse a launch that could never wake anyone, loudly and before starting.
    command = opts.command[1:] if opts.command[:1] == ["--"] else opts.command
    if not command:
        print(json.dumps({"error": "usage: run_detached.py [--label L] -- <command...>"}))
        return 2
    conv_id = opts.conv or os.environ.get("EXOCORTEX_CONV_ID")
    if not conv_id:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not an Observatory turn? "
                                   "pass --conv <id>"}))
        return 2
    print(json.dumps(launch(command, conv_id, label=opts.label, cwd=opts.cwd)))
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
