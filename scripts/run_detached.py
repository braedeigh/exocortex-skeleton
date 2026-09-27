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

If the watcher itself dies — the machine reboots, the service is restarted,
something kills it — nobody would ever be told. So `--sweep`, run by cron once
a minute, looks for jobs whose watcher is gone without having finished, marks
them interrupted, and wakes their session with that and the log's tail:

    * * * * * EXOCORTEX_DATA_DIR=... EXOCORTEX_CONTENT_DIR=... \
        /opt/exocortex/skeleton/venv/bin/python3 \
        /opt/exocortex/skeleton/scripts/run_detached.py --sweep

    ./venv/bin/python3 scripts/run_detached.py --label "full test suite" -- \
        ./venv/bin/python3 -m pytest -q

Sessions don't have to remember to call it. Run as `--hook`, this same file is
a PreToolUse hook that every Observatory session with Bash carries
(routes/observatory.py `_session_settings`): when the agent asks for a Bash
command with `run_in_background`, the hook rewrites it into a run_detached
launch, so the harness's own background mode — the one that dies with the
turn — is never used there.

Prints one JSON line (job id, log path, job dir) and returns at once. The
conversation id comes from EXOCORTEX_CONV_ID, which every Observatory turn has
in its environment (routes/observatory.py `_spawn`); `--conv` overrides it.

What it can't survive: a reboot, or `systemctl restart exocortex` — that kills
every process in the service's cgroup, and `setsid` doesn't leave the cgroup.
The job is lost either way; the sweep is what makes sure the session hears
about it. A reload is fine.

Touches: `routes/observatory.py` (queue_followup — the follow-up queue and the
System-bubble rendering; `_session_settings` — where the hook is wired), the
job folders under JOBS_DIR, `tests/test_run_detached.py`.

Prompt that produced this: "I'm wanting to make it such that running in the
background starts back up ... run a poller on the job to check on it and tell
the claude to start again if it's done?" / "happens all the time across
sessions" / "every time my session makes a background job it doesn't return to
the session, i have to prompt it, because it stops running".
"""
import argparse
import json
import os
import secrets
import shlex
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Where each job's folder (meta.json + output.log) lives. /var/tmp by
# default: temp space that survives a reboot (plain /tmp is wiped at boot,
# taking the log of the very job a reboot killed with it), and the system
# still clears it out after a few weeks.
JOBS_DIR = Path(os.environ.get("EXOCORTEX_JOBS_DIR") or "/var/tmp/exo-jobs")

# How long a job may sit with no watcher having checked in before the sweep
# calls it dead. The watcher checks in within a second of launch; this only
# has to be comfortably longer than that.
WATCHER_START_GRACE_SEC = 300

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


def _boot_id():
    """This boot's unique id, so a pid recorded before a reboot is never
    mistaken for a live process after it."""
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return None


def _is_watcher(pid):
    """Is `pid` alive and still one of our watchers (not a reused pid)?"""
    try:
        cmdline = Path(f"/proc/{int(pid)}/cmdline").read_bytes()
    except (OSError, TypeError, ValueError):
        return False
    return b"run_detached.py" in cmdline and b"--watch" in cmdline


def _is_alive(pid):
    try:
        os.kill(int(pid), 0)
    except (OSError, TypeError, ValueError):
        return False
    return True


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
        "queued_epoch": time.time(),
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
    if meta.get("interrupted"):
        outcome = f"interrupted — {meta['interrupted']}; it did not finish"
    elif meta.get("error") is not None:
        outcome = f"couldn't start: {meta['error']}"
    else:
        outcome = f"exit {meta['exit_code']}"
    summary = (f"Background job finished — {meta['label']}: {outcome} "
               f"after {_duration(meta.get('seconds', 0))}")
    tail = _tail(meta["log"])
    text = (
        "[Background job finished — you started it in the background, and it "
        "ran detached via scripts/run_detached.py]\n"
        f"Job: {meta['label']}\n"
        f"Command: {shlex.join(meta['argv'])}  (cwd: {meta['cwd']})\n"
        f"Result: {outcome} after {_duration(meta.get('seconds', 0))}\n"
        f"Full log: {meta['log']}\n\n"
        f"Last lines of the log:\n{tail or '(empty)'}\n\n"
        "Pick up where you left off with it. If you already dealt with this "
        "result earlier, just say so in a line."
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
    # Check in first, so the sweep can tell a live watcher from a dead one.
    meta["watcher_pid"] = os.getpid()
    meta["boot_id"] = _boot_id()
    meta["started_epoch"] = started
    _write_meta(job_dir, meta)

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

    _wake(job_dir, meta)
    return meta


def _wake(job_dir, meta):
    """Wake the job's conversation through the follow-up queue — once.

    The app is imported only here, so a broken app import can't stop a job
    from running. The outcome is recorded, never raised: nobody is listening."""
    text, system = wake_message(meta)
    try:
        from routes import observatory
        meta["wake"] = observatory.queue_followup(meta["conv_id"], text, system=system)
    except Exception as exc:
        meta["wake"] = f"failed: {exc!r}"
    _write_meta(job_dir, meta)


def _why_dead(meta, now):
    """Why this unfinished job's watcher is gone, or None if it may be alive."""
    if meta.get("finished_at") or meta.get("interrupted"):
        return None
    if not meta.get("watcher_pid"):
        age = now - (meta.get("queued_epoch") or now)
        return ("its watcher never started" if age > WATCHER_START_GRACE_SEC
                else None)
    if meta.get("boot_id") and meta["boot_id"] != _boot_id():
        return "the machine restarted while it was running"
    if not _is_watcher(meta["watcher_pid"]):
        return ("its watcher process was killed (a service restart, or a kill) "
                "while it was running")
    return None


def sweep(now=None):
    """The once-a-minute safety net: find jobs whose watcher died before the
    job finished, mark each interrupted, and wake its conversation with that.
    Returns the ids it woke."""
    now = now or time.time()
    woke = []
    if not JOBS_DIR.is_dir():
        return woke
    for job_dir in sorted(p for p in JOBS_DIR.iterdir() if p.is_dir()):
        try:
            meta = _read_meta(job_dir)
        except (OSError, ValueError):
            continue
        reason = _why_dead(meta, now)
        if reason is None:
            continue
        # Mark it BEFORE waking: a crash between the two then costs one
        # message, never the same message every minute forever.
        if meta.get("pid") and _is_alive(meta["pid"]) and "restarted" not in reason:
            reason += f" — the job itself may still be running as pid {meta['pid']}"
        meta["interrupted"] = reason
        meta["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        if meta.get("started_epoch"):
            meta["seconds"] = round(now - meta["started_epoch"], 1)
        _write_meta(job_dir, meta)
        _wake(job_dir, meta)
        woke.append(meta.get("id", job_dir.name))
    return woke


def rewrite_background_call(event, conv_id):
    """The PreToolUse hook's decision: the rewritten Bash input, or None to
    leave the call alone.

    Only a Bash call asking for `run_in_background`, in a turn that has a
    conversation to wake, is touched. It becomes a foreground call to this
    script wrapping the original command in `bash -c`, so the agent gets the
    launch line back at once. Every other field (description, timeout) is
    kept."""
    tool_input = event.get("tool_input") if isinstance(event, dict) else None
    if not (conv_id and event.get("tool_name") == "Bash"
            and isinstance(tool_input, dict) and tool_input.get("run_in_background")):
        return None
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return None
    label = (tool_input.get("description") or command)[:80]
    wrapped = shlex.join([sys.executable, str(Path(__file__).resolve()),
                          "--label", label, "--", "bash", "-c", command])
    return dict(tool_input, command=wrapped, run_in_background=False)


def hook():
    """Run as the PreToolUse hook: read the event on stdin, print the rewrite.

    Fails open — any surprise prints nothing, which leaves the agent's call
    exactly as it asked (the old behaviour), never blocks it. No permission
    decision is given, so the act-vs-ask gate keeps the final say."""
    try:
        event = json.load(sys.stdin)
        new_input = rewrite_background_call(event, os.environ.get("EXOCORTEX_CONV_ID"))
    except Exception:
        return 0
    if new_input is not None:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "updatedInput": new_input}}))
    return 0


def main(args=None):
    parser = argparse.ArgumentParser(
        description="Run a command detached; wake this conversation when it ends.")
    parser.add_argument("--label", help="short name for the job, shown in the chat")
    parser.add_argument("--conv", help="conversation to wake (default: EXOCORTEX_CONV_ID)")
    parser.add_argument("--cwd", help="directory to run in (default: the current one)")
    parser.add_argument("--watch", help=argparse.SUPPRESS)   # the watcher's own entry
    parser.add_argument("--hook", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--sweep", action="store_true",
                        help="wake the sessions of jobs whose watcher died (cron)")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    opts = parser.parse_args(args)

    if opts.hook:
        return hook()
    if opts.sweep:
        for job_id in sweep():
            print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} interrupted job {job_id}: woke its session")
        return 0
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
    # Tell the agent what just happened, in the launch line it reads back:
    # the job is off on its own, and the result arrives as a new turn.
    launched = launch(command, conv_id, label=opts.label, cwd=opts.cwd)
    launched["note"] = ("Running detached. This conversation gets a System message "
                        "with the result when it exits — no need to wait or poll; "
                        "you can end your turn. The log is readable any time.")
    print(json.dumps(launched))
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts — except the hook, which runs on every Bash call and
    # stays as light as possible.
    if "--hook" not in sys.argv[1:2]:
        import runtime_sensor
        runtime_sensor.attach()
    sys.exit(main())
