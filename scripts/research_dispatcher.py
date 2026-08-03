#!/usr/bin/env python3
"""Hand queued annotation-batch research workers to the run dispatcher.

Plain English: routes/research.py's POST /api/research/annotation-batch only
QUEUES worker sessions (marking each `"worker": True`) rather than spawning a
`claude` process per item — a batch of 6 spawned at once used to OOM this box.
This script is the other half, and it used to make the admission decision
itself: count live workers, read MemAvailable, admit one.

It doesn't anymore. That decision now lives in scripts/run_dispatcher.py, which
makes it once for EVERY background crew instead of four crews each guessing
separately. What's left here is the research crew's adapter: notice queued
worker sessions, put them in the shared queue, and know how to actually spawn
one when the dispatcher says go.

So this file is now two things:
  1. an ENQUEUER (run_once) — cheap, idempotent, safe to run as often as you
     like; it never starts anything.
  2. the research crew's SPAWNER (spawn_worker) — called BY the run dispatcher
     once a slot opens, not by this script's own main().

Still run from cron and still kicked event-driven (routes/research.py's
`_kick_dispatcher`, scripts/worker_apply_result.py's `_kick_dispatcher`) so a
batch reaches the queue within seconds instead of at the next tick:

    * * * * * EXOCORTEX_DATA_DIR=... /opt/exocortex/skeleton/venv/bin/python3 \\
        /opt/exocortex/skeleton/scripts/research_dispatcher.py

`--ending` is still accepted so existing callers don't break, but it no longer
does anything: it named the tmux session a finishing worker was about to close,
so the old slot math wouldn't undercount the headroom it was freeing. The run
dispatcher decides liveness from evidence at admit time, so there's nothing
left to correct for.

Touches: scripts/run_dispatcher.py (the queue and its `new_run` shape),
routes/research.py (what queues the sessions), scripts/worker_apply_result.py
(what closes them out).
"""
import argparse
import fcntl
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# Make the skeleton root importable regardless of where the script is invoked
# from (mirrors scripts/worker_apply_result.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
from routes.kitchen import shared  # noqa: E402
from scripts import research_ctl  # noqa: E402
from scripts import run_dispatcher as rd  # noqa: E402

LOCK_NAME = "research_dispatcher.lock"
LANE = "research"
KIND = "research_worker"
MAX_ATTEMPTS = 2
RESEARCH_DEFAULT = {"topics": [], "entries": [], "sessions": []}


# --- research.json integrity (the doctor's half) -----------------------------
# These two are no longer part of admission — the run dispatcher decides
# liveness for the QUEUE. They survive because research.json has its own copy
# of a session's status, and a worker that dies leaves that record stranded
# too. scripts/research_doctor.py's weekly sweep is the only caller: it repairs
# the research-side record, the same way the run dispatcher repairs the
# queue-side one.

def list_live_workers(tmux_fn, ending=None):
    """Names of currently-live tmux worker sessions (the `rw-` prefix),
    excluding `ending` if given."""
    result = tmux_fn("list-sessions -F '#{session_name}'")
    if result.returncode != 0:
        return set()  # no tmux server / no sessions at all
    names = [n.strip() for n in (result.stdout or "").splitlines() if n.strip()]
    return {n for n in names if n.startswith("rw-") and n != ending}


def recover_dead_workers(data, live_names):
    """Mutate `data` in place: a worker session stuck "running" whose tmux
    session isn't live and which never got an llm reply goes back to
    "queued" — or "failed" after a second dead attempt. Sessions without
    `worker: True` (research-runner/research-deep/filer) are never touched.
    Returns the recovered session ids, for the caller's log line."""
    entries = data.get("entries", [])
    recovered = []
    for s in data.get("sessions", []):
        if not s.get("worker") or s.get("status") != "running":
            continue
        if worker_tmux_name(s["id"]) in live_names:
            continue
        has_reply = any(
            e.get("session") == s["id"] and e.get("author") == "llm" for e in entries
        )
        if has_reply:
            continue
        attempts = s.get("attempts", 0) + 1
        s["attempts"] = attempts
        if attempts >= MAX_ATTEMPTS:
            s["status"] = "failed"
            s["report"] = "worker died twice — gave up"
        else:
            s["status"] = "queued"
        recovered.append(s["id"])
    return recovered


# --- pure logic (no I/O — easy to unit test) ---------------------------------

def worker_tmux_name(session_id):
    """rw-<session_id>, sanitized the same way spawn_worker names the tmux
    session it creates.

    tmux treats '.' and ':' as target separators and rewrites '_' — any of
    those would make the name we spawn differ from the name we send-keys /
    kill against, so the worker could never be prompted or self-close.
    Collapse everything but [A-Za-z0-9-] to '-'.
    """
    return re.sub(r"[^A-Za-z0-9-]", "-", f"rw-{session_id}")[:40]


def worker_target(session):
    """What this worker session is actually pointed at. A distill session has
    no entry_ids — it synthesizes a whole topic rather than answering one
    question — so its target is the topic id instead."""
    if session.get("mode") == "distill":
        return (session.get("topics") or [None])[0]
    return (session.get("entry_ids") or [None])[0]


def queued_worker_sessions(research):
    """Worker sessions waiting to run. `worker: True` is what distinguishes
    them from the research-runner/research-deep/filer sessions, which are not
    dispatcher-managed and must never be picked up here."""
    return [s for s in research.get("sessions", [])
            if s.get("worker") and s.get("status") == "queued"]


def already_queued_ids(queue_data):
    """Session ids that already have a live entry in the shared queue —
    waiting or running. Without this check the enqueuer would add the same
    session again on every tick, since the research record stays `queued`
    until the run dispatcher actually spawns it."""
    live = {"queued", "running"}
    out = set()
    for run in queue_data.get("runs", []):
        if run.get("status") in live:
            sid = (run.get("spawn") or {}).get("session_id")
            if sid:
                out.add(sid)
    return out


def runs_to_enqueue(research, queue_data, clock=None):
    """The queue entries this tick should add: one per queued worker session
    that isn't already represented. A session with no target is skipped rather
    than enqueued to fail later."""
    seen = already_queued_ids(queue_data)
    out = []
    for session in queued_worker_sessions(research):
        if session["id"] in seen:
            continue
        target = worker_target(session)
        if not target:
            continue
        out.append(rd.new_run(
            LANE, KIND,
            {"type": "tmux_worker", "session_id": session["id"],
             "mode": session.get("mode", "regular"), "target_id": target},
            mem_class="agent", clock=clock))
    return out


def describe_run(enqueued):
    if not enqueued:
        return "nothing to enqueue"
    return f"enqueued {len(enqueued)} ({', '.join(r['spawn']['session_id'] for r in enqueued)})"


# --- spawning (called by the run dispatcher, not by main()) ------------------

def spawn_worker(session_id, mode, target_id):
    """Spawn (or reuse) a named tmux Claude session for one queued worker
    session, then send it a prompt shaped for its mode:

      * `mode in ("regular", "deep")` — an annotation-batch question.
        `target_id` is the question entry id; the worker reads its CLAUDE.md
        from RESEARCH_WORKER_DIR.
      * `mode == "distill"` — a per-topic distill (see
        routes/research.py's /api/research/topic/distill). `target_id` is
        the topic id; the worker reads its CLAUDE.md from
        RESEARCH_DISTILLER_DIR and gets the topic's name looked up here (the
        session record only carries the id) so the prompt can name it.

    Either way the worker does its one job, records the result via the
    APPLY command, then closes itself. The run dispatcher calls this only
    once a slot actually opens up.
    """
    skeleton_dir = Path(__file__).resolve().parent.parent
    tmux_name = worker_tmux_name(session_id)
    apply_cmd = (
        f"EXOCORTEX_DATA_DIR={store.DATA_DIR} "
        f"{skeleton_dir}/venv/bin/python3 "
        f"{skeleton_dir}/scripts/worker_apply_result.py "
        f"--session {session_id}"
    )

    # Flip the research record to `running` here, at the moment the process is
    # actually being started. The research page reads this status, and the run
    # queue is a separate file it doesn't know about — leaving the session
    # `queued` while its worker was live would make her own page lie.
    with store.mutate("research.json", dict(RESEARCH_DEFAULT)) as data:
        for s in data.get("sessions", []):
            if s.get("id") == session_id:
                s["status"] = "running"

    if mode == "distill":
        topic_id = target_id
        data = store.read("research.json", {"topics": []})
        topic = next((t for t in data.get("topics", []) if t["id"] == topic_id), None)
        topic_name = topic["name"] if topic else topic_id
        shared.ensure_claude_session(
            tmux_name, store.RESEARCH_DISTILLER_DIR, dirs=(store.RESEARCH_DISTILLER_DIR,),
        )
        prompt = (
            f"SESSION={session_id} TOPIC={topic_id}: {topic_name} TMUX={tmux_name}\n"
            f"APPLY: {apply_cmd}\n"
            f"Do your one job: read your CLAUDE.md, distill topic '{topic_name}' "
            f"({topic_id}) into research/edge/{topic_id}.md, record via APPLY, then "
            f"close your tmux session."
        )
    else:
        question_id = target_id
        shared.ensure_claude_session(
            tmux_name, store.RESEARCH_WORKER_DIR, dirs=(store.RESEARCH_WORKER_DIR,),
        )
        prompt = (
            f"SESSION={session_id} MODE={mode} TMUX={tmux_name}\n"
            f"APPLY: {apply_cmd}\n"
            f"Do your one job: read your CLAUDE.md, research the one question in session "
            f"{session_id}, record via APPLY, then close your tmux session."
        )
    # block=True: the caller is a short-lived script, and the default
    # daemon-thread send would die with the process before ever typing.
    shared.send_prompt(tmux_name, prompt, block=True)

    # Blocking sessionId-capture tail. The caller exits right after spawning,
    # so if this doesn't happen inline it never happens at all — and without a
    # sessionId the run's token receipt has no transcript to read.
    #
    # Chose this deterministic, code-enforced capture over having the WORKER
    # record its own sessionId as part of its APPLY step: that would be a
    # *prompt*-enforced contract, which an LLM agent can simply forget on a bad
    # day — the exact failure mode research_ctl.py's docstring describes
    # retiring. Per the hard rule, any failure here (dead tmux session, a race,
    # whatever) degrades silently to "unset" rather than retrying, blocking
    # longer, or crashing the run.
    try:
        time.sleep(7)
        research_ctl.capture_session_id(tmux_name, session_id)
    except Exception:
        pass


# --- orchestration ------------------------------------------------------------

def _kick_run_dispatcher():
    """Fire the run dispatcher once, detached, right after enqueueing — so a
    fresh batch starts draining within seconds instead of at the next cron
    minute. Fire-and-forget: its own flock means an overlapping run just
    no-ops. Separated out so tests can monkeypatch it."""
    skeleton_dir = Path(__file__).resolve().parent.parent
    subprocess.Popen(
        [str(skeleton_dir / "venv" / "bin" / "python3"),
         str(skeleton_dir / "scripts" / "run_dispatcher.py")],
        env={**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def run_once(ending=None, *, clock=None, kicker=None):
    """One enqueue pass, under a non-blocking flock — if another invocation
    already holds it, this returns immediately (exit 0, no output), so
    overlapping cron ticks and kicks can't double-enqueue the same session.

    `ending` is accepted and ignored (see the module docstring). Dependencies
    are looked up at call time rather than bound as defaults so tests can
    monkeypatch the module-level functions directly.
    """
    clock = clock or datetime.now
    kicker = kicker or _kick_run_dispatcher

    lock_path = store.DATA_DIR / LOCK_NAME
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return  # another invocation is already running

        research = store.read("research.json", dict(RESEARCH_DEFAULT))
        enqueued = []
        with store.mutate(rd.QUEUE, rd.queue_default()) as queue_data:
            enqueued = runs_to_enqueue(research, queue_data, clock=clock)
            queue_data.setdefault("runs", []).extend(enqueued)

        if enqueued:
            try:
                kicker()
            except Exception:
                pass  # cron will pick it up within the minute anyway

        print(f"[{clock():%Y-%m-%d %H:%M:%S}] research-dispatcher: {describe_run(enqueued)}")


def main():
    parser = argparse.ArgumentParser(
        description="Put queued annotation-batch research workers into the shared run queue.",
    )
    parser.add_argument(
        "--ending", default=None,
        help="accepted for backward compatibility; ignored (the run dispatcher "
             "decides liveness from evidence).",
    )
    args = parser.parse_args()
    run_once(ending=args.ending)


if __name__ == "__main__":
    main()
