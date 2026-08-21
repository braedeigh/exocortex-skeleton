#!/usr/bin/env python3
"""turn_host.py — the process a turn actually lives in.

Plain English: when you send a message to a session, something has to hold the
agent's hand for the whole reply — start it, read what it says line by line,
write that into the transcript, and mark the session finished at the end. That
job used to be done by a thread inside the web server. This script is that job,
moved out into a process of its own.

WHY IT MOVED. A thread inside the web server dies the instant the web server's
worker process exits, and a worker exits far more often than anyone assumed:
on a `systemctl reload` (the documented way to deploy a Python change) and on
gunicorn's own `--max-requests` recycling, which fires on a request counter and
therefore goes off most often while the Observatory is being used hardest. When
that thread died, the agent itself kept running — orphaned, still thinking,
still costing money — but nothing was reading its output, so the transcript
just stopped. No error was ever written, so the session's card went grey rather
than red: indistinguishable from a reply that finished normally. Counted across
every silent death still on disk at the time of writing: 10 of 11, matched to
the second against the systemd journal, 7 reloads and 3 recycles.

Started with `start_new_session=True` (setsid), so it belongs to no web worker
and survives both of those. It does NOT survive `systemctl restart`, which
empties the whole service cgroup — that's what scripts/live_turns.py refuses
deploys for, and why restart is reserved for unit-file changes.

    turn_host.py <job-file.json>

The job file carries the conversation id, its resolved config, the prompt text,
the resume id and where to write. The prompt goes in a file rather than argv
for the same reasons the agent's own prompt does: no length limit, and nothing
readable in `ps`. This deletes it as soon as it has been read.

Touches:
  - routes/observatory.py — `_spawn_host` writes the job and launches this;
    `_spawn` and `_run_turn` are imported from there rather than reimplemented,
    so there is exactly one turn loop and it cannot drift.
  - the session's `.jsonl` transcript and its `.live` delta sidecar.
  - data/bot_chats/index — clears `running`, records cost and any error.
"""
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# How often to ask the index whether she has pressed Stop. `_run_turn` also
# checks the flag, but only when a message-granular event arrives — which can
# be minutes apart across a long tool call, and Stop that takes minutes reads
# as broken. This is the fast path; the two agree because both mark the kill in
# `_stop_requested` first, which is what tells the turn its death was
# deliberate rather than a crash.
_STOP_POLL_SEC = 2.0


def _watch_for_stop(observatory, store, conv_id, proc, done):
    while not done.wait(_STOP_POLL_SEC):
        if proc.poll() is not None:
            return
        try:
            entry = store.read("bot_chats/index", {}).get(conv_id)
        except Exception:
            continue          # a contended read is not a stop
        if isinstance(entry, dict) and entry.get("stop_requested"):
            observatory._stop_requested.add(conv_id)
            try:
                proc.kill()
            except OSError:
                pass
            return


def main():
    if len(sys.argv) != 2:
        print("usage: turn_host.py <job-file.json>", file=sys.stderr)
        return 2
    job_path = Path(sys.argv[1])
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"unreadable job: {e}", file=sys.stderr)
        return 2
    finally:
        # The prompt is in there; it doesn't outlive the read.
        try:
            job_path.unlink()
        except OSError:
            pass

    conv_id = job["conv_id"]
    config = job["config"]
    text = job["text"]
    resume_sid = job.get("resume_sid")
    log_path = Path(job["log_path"])
    live_path = Path(job["live_path"]) if job.get("live_path") else None

    import store
    # Where to read and write is dictated by the job, not re-derived from this
    # process's environment: the host must land in the same data dir as the
    # worker that started it, whatever that worker resolved. Applied BEFORE
    # routes.observatory is imported so nothing caches the wrong root.
    if job.get("data_dir"):
        store.DATA_DIR = Path(job["data_dir"])
    if job.get("content_dir"):
        store.CONTENT_DIR = Path(job["content_dir"])
    from routes import observatory
    if job.get("claude_bin"):
        observatory.CLAUDE_BIN = job["claude_bin"]

    try:
        proc, stderr_f = observatory._spawn(
            config, text, resume_sid, cwd_override=config.get("cwd"))
    except OSError as e:
        # Nobody else can clear this. The web request already returned "the
        # host is away", so if the agent never starts, THIS is the only process
        # that knows — and a session left flagged `running` forever is the
        # exact failure this whole change exists to end.
        msg = f"could not start claude: {e}"
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if isinstance(entry, dict):
                entry["running"] = False
                entry["last_error"] = msg
        print(msg, file=sys.stderr)
        return 1

    observatory._running_procs[conv_id] = proc
    done = threading.Event()
    threading.Thread(
        target=_watch_for_stop,
        args=(observatory, store, conv_id, proc, done),
        daemon=True,
    ).start()
    try:
        # One turn loop, shared with the in-worker fallback path. Everything
        # that matters — the transcript, the resume id saved on first sight,
        # the heartbeat, the cost, the error flag, clearing `running` — happens
        # in here, which is why moving where it runs changed so little.
        observatory._run_turn(proc, stderr_f, conv_id, log_path, resume_sid,
                              live_path=live_path)
    finally:
        done.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
