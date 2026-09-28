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
  - data/bot_chats/index — records this process as the turn's host
    (`turn_proc`, so a host that dies is noticed at once by
    observatory.mark_dead_turns), clears `running`, records cost and any
    error — including a job it can't read or an agent it can't start.
  - peermail.py, through observatory.drain_inbox — at the end of the turn,
    starts the next one if messages are waiting for this session.
  - continuation.py, through observatory.after_turn — a Coding session past
    its context cap is asked for its handoff when its turn ends.
"""
import json
import os
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
            # The agent AND whatever it started — a test run, a dev server
            # (observatory._kill_turn walks the process tree).
            observatory._kill_turn(proc)
            return


def _give_up(store, conv_id, msg):
    """End a turn that never got going, and say why. Nobody else can: the web
    request already returned "the host is away", so if this process fails
    before the turn loop, it is the only one that knows — and a session left
    flagged `running` with no error is the silent death this host exists to
    end. Uses the store alone, not routes.observatory: failing to import that
    is one of the ways to end up here."""
    print(msg, file=sys.stderr)
    try:
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if isinstance(entry, dict) and entry.get("running"):
                entry["running"] = False
                entry["last_error"] = msg
                entry.pop("turn_proc", None)
    except Exception as e:
        print(f"could not record the failure either: {e}", file=sys.stderr)


def _job_from_path(job_path):
    """The conversation id and data dir a job file stands for, read off where
    it sits — `<data dir>/bot_chats/.turns/<conv id>.json`, see
    observatory._turn_job_path. The fallback for a job too broken to say so
    itself."""
    if job_path.parent.name == ".turns" and job_path.parent.parent.name == "bot_chats":
        return job_path.stem, job_path.parent.parent.parent
    return None, None


def main():
    if len(sys.argv) != 2:
        print("usage: turn_host.py <job-file.json>", file=sys.stderr)
        return 2
    job_path = Path(sys.argv[1]).resolve()
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
        conv_id = job["conv_id"]
        config = job["config"]
        text = job["text"]
        resume_sid = job.get("resume_sid")
        log_path = Path(job["log_path"])
        live_path = Path(job["live_path"]) if job.get("live_path") else None
        if not isinstance(config, dict):
            raise TypeError("config is not an object")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        # A job that can't be read still names its conversation by where it
        # sits, so the card turns red instead of saying "running" forever.
        conv_id, data_dir = _job_from_path(job_path)
        if conv_id:
            import store
            store.DATA_DIR = data_dir
            _give_up(store, conv_id, f"the turn's job file was unreadable: {e!r}")
        else:
            print(f"unreadable job: {e!r}", file=sys.stderr)
        return 2
    finally:
        # The prompt is in there; it doesn't outlive the read.
        try:
            job_path.unlink()
        except OSError:
            pass

    import store
    # Where to read and write is dictated by the job, not re-derived from this
    # process's environment: the host must land in the same data dir as the
    # worker that started it, whatever that worker resolved. Applied BEFORE
    # routes.observatory is imported so nothing caches the wrong root.
    if job.get("data_dir"):
        store.DATA_DIR = Path(job["data_dir"])
    if job.get("content_dir"):
        store.CONTENT_DIR = Path(job["content_dir"])

    try:
        from routes import observatory
        if job.get("claude_bin"):
            observatory.CLAUDE_BIN = job["claude_bin"]
        # Write down that THIS process is the turn's host, before anything
        # that could kill it runs. From here on, if it dies — OOM, a crash, a
        # kill — observatory.mark_dead_turns can tell, and turns the card red
        # at once instead of letting a stale heartbeat age out over ten
        # minutes into grey.
        observatory._record_turn_proc(conv_id, "host", os.getpid())

        # Measure this process too (runtime_sensor.py). A turn spends most of
        # its life here rather than in the web worker, so a sensor that only
        # watched gunicorn would report the send path and then go blind for
        # the whole reply — `_run_turn`, the transcript writes, the index
        # mutates all happen in THIS process. Started after the data dir is
        # settled above, so its sidecar lands in the same place everything
        # else this host writes does.
        import runtime_sensor
        runtime_sensor.start()

        # If the send that spawned us was being traced, continue it here under
        # the same id (runtime_trace.py). This is the only action in the app
        # that crosses a process boundary, so without this the trace would end
        # at the spawn — one row short of the whole reply.
        import runtime_trace
        traced = job.get("trace_id")
        if traced:
            runtime_trace.begin(f"{traced}.turn", entry=f"turn {conv_id}",
                                kind="turn", parent_id=traced)
    except Exception as e:
        _give_up(store, conv_id, f"the turn host failed to start: {e!r}")
        return 1

    try:
        proc, stderr_f = observatory._spawn(
            config, text, resume_sid, cwd_override=config.get("cwd"))
    except Exception as e:
        # Any failure to start the agent, not only a missing binary (OSError):
        # a bad value in the config is a TypeError, and it strands the flag
        # just the same.
        _give_up(store, conv_id, f"could not start claude: {e}")
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
        # Start whatever was waiting on this turn to end — her approval's
        # retry cue, a Coming up reminder. This is the moment the
        # conversation frees up, so this is where the queue moves; the next
        # turn gets its own host process, so this one can still exit.
        # First the end-of-turn bookkeeping: archive a session that handed
        # off, or ask one past its context cap for its handoff (continuation.py)
        # — that ask is a follow-up, so it has to be queued before the drains.
        try:
            observatory.after_turn(conv_id)
        except Exception as e:
            print(f"after-turn check failed: {e}", file=sys.stderr)
        try:
            observatory.drain_followups(conv_id)
        except Exception as e:
            print(f"follow-up drain failed: {e}", file=sys.stderr)
        # ...and whatever is in its mailbox (peermail.py): messages sent while
        # it ran that couldn't be handed in, or the one that interrupted it.
        # If the follow-up above already started a turn, this finds the
        # session busy and leaves them for that turn to hand in.
        try:
            observatory.drain_inbox(conv_id)
        except Exception as e:
            print(f"mailbox drain failed: {e}", file=sys.stderr)
        # Write the last window down before the process goes. The sensor's
        # background thread is a daemon and dies with `main` returning, so a
        # turn shorter than one cycle would otherwise leave no trace of having
        # run at all — which is exactly the short turn most worth seeing.
        runtime_sensor.stop()
        if runtime_trace.current() is not None:
            runtime_trace.finish()
    return 0


if __name__ == "__main__":
    sys.exit(main())
