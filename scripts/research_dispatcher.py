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

WHERE A WORKER RUNS NOW (09-24). It used to be a named tmux pane (`rw-<sid>`)
that nobody could open from the app, whose Claude session id had to be
scraped out of the process table after a seven-second sleep so its tokens
could be counted. A worker is now an Observatory conversation in the
`research` lane (routes/research_room.py) — visible on the Research page
while it runs, readable after, stopped with the same Stop button as any
session. spawn_worker MINTS that conversation and stamps the research record
with its `conv_id` and the queue's `run_id`; the conversation carries
`research_session_id` back. Both links are written at spawn, by code, so the
trace closes without a sleep and without trusting the worker to report its
own id. The kickoff prompt is written to a file and the run dispatcher's own
observatory-turn runner (scripts/spinoff_runner.py, detached from cron's
cgroup) posts it — so the worker never leaves the memory-admission queue.

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

Touches: scripts/run_dispatcher.py (the queue and its `new_run` shape, and
the runner that posts the kickoff), routes/research_room.py (the mint),
scripts/research_ctl.py (set_session — the conv/run stamp), routes/research.py
(what queues the sessions), scripts/worker_apply_result.py (what closes them
out).
"""
import argparse
import fcntl
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Make the skeleton root importable regardless of where the script is invoked
# from (mirrors scripts/worker_apply_result.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
from routes import research_room  # noqa: E402
from scripts import research_ctl  # noqa: E402
from scripts import run_dispatcher as rd  # noqa: E402

LOCK_NAME = "research_dispatcher.lock"
LANE = "research"
KIND = "research_worker"
# The queue's spawn type for a research worker. "tmux_worker" was the old
# name; a run queued under it before the move is spawned and probed the same
# way (run_dispatcher treats both), so nothing waiting at deploy time is lost.
SPAWN_TYPE = "research_worker"
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


def recover_dead_workers(data, live_names, index=None):
    """Mutate `data` in place: a worker session stuck "running" with nothing
    alive behind it and no llm reply goes back to "queued" — or "failed"
    after a second dead attempt. Sessions without `worker: True`
    (research-runner/research-deep/filer) are never touched. Returns the
    recovered session ids, for the caller's log line.

    What counts as alive depends on the record's generation: a room worker
    (one with a `conv_id`) is alive while its Observatory conversation says
    `running`; a legacy record is alive while its tmux pane is. `index` is
    bot_chats/index.json, read here when not handed in."""
    entries = data.get("entries", [])
    recovered = []
    for s in data.get("sessions", []):
        if not s.get("worker") or s.get("status") != "running":
            continue
        if s.get("conv_id"):
            if index is None:
                index = store.read("bot_chats/index", {}) or {}
            entry = index.get(s["conv_id"]) if isinstance(index, dict) else None
            if isinstance(entry, dict) and entry.get("running"):
                continue
        elif worker_tmux_name(s["id"]) in live_names:
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
    """rw-<session_id>, sanitized the way the tmux era named a worker's pane.

    Nothing spawns a pane any more; this survives so the run dispatcher's
    probe and scripts/research_doctor.py can still recognise a LEGACY record
    (one with no `conv_id`) by the pane it would have had. tmux treats '.'
    and ':' as target separators and rewrites '_', so everything but
    [A-Za-z0-9-] collapses to '-'.
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
            {"type": SPAWN_TYPE, "session_id": session["id"],
             "mode": session.get("mode", "regular"), "target_id": target},
            mem_class="agent", clock=clock))
    return out


def describe_run(enqueued):
    if not enqueued:
        return "nothing to enqueue"
    return f"enqueued {len(enqueued)} ({', '.join(r['spawn']['session_id'] for r in enqueued)})"


# --- spawning (called by the run dispatcher, not by main()) ------------------

def worker_title(session, mode, target_id, research):
    """What the worker's card says on the Research page: the question it's
    answering, or the topic it's distilling. Falls back to the session id so
    a card is never blank."""
    if mode == "distill":
        topic = next((t for t in research.get("topics", []) if t.get("id") == target_id), None)
        name = topic.get("name") if topic else target_id
        return f"Distill: {name}"[:60]
    question = next((e for e in research.get("entries", []) if e.get("id") == target_id), None)
    text = " ".join(((question or {}).get("text") or "").split())
    return text[:60] if text else f"Research {session.get('id') if session else target_id}"


def worker_skill_file(mode):
    """The job description for a mode — the CLAUDE.md of the folder that used
    to be the worker's cwd. It now rides on the conversation as its system
    prompt (routes/observatory.py's system_prompt_file), so the session stands
    in the research room and still knows its one job."""
    folder = store.RESEARCH_DISTILLER_DIR if mode == "distill" else store.RESEARCH_WORKER_DIR
    return Path(folder) / "CLAUDE.md"


def worker_prompt(session_id, mode, target_id, topic_name, apply_cmd):
    """The kickoff a worker is sent — the same text the tmux era typed, minus
    the pane to close: SESSION/MODE (or TOPIC), the exact APPLY command, and
    the one-job sentence."""
    if mode == "distill":
        return (
            f"SESSION={session_id} TOPIC={target_id}: {topic_name}\n"
            f"APPLY: {apply_cmd}\n"
            f"Do your one job: follow your distiller instructions (in your system "
            f"prompt), distill topic '{topic_name}' ({target_id}) into "
            f"research/edge/{target_id}.md, record via APPLY, then stop."
        )
    return (
        f"SESSION={session_id} MODE={mode}\n"
        f"APPLY: {apply_cmd}\n"
        f"Do your one job: follow your worker instructions (in your system prompt), "
        f"research the one question in session {session_id}, record via APPLY, "
        f"then stop."
    )


def kickoff_path(name):
    """Where a worker's kickoff text waits for the runner — beside the queue,
    in the same folder routes/run_queue.py uses for her own queued turns."""
    folder = store.DATA_DIR / rd.KICKOFF_DIR
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{name}.txt"


def spawn_worker(session_id, mode, target_id, run_id=None):
    """Stand up one admitted research worker as a research-room conversation.

    Mints the Observatory conversation (lane `research`, `origin: "research"`,
    `research_session_id` = this session), stamps the research record with
    the conversation id and the run id, and writes the kickoff prompt to a
    file. It does NOT start the turn: the caller — run_dispatcher.spawn_run —
    hands the conversation and the file to the observatory-turn runner, so a
    worker is admitted, started and reaped through the same door as every
    other background run.

      * `mode in ("regular", "deep")` — an annotation-batch question;
        `target_id` is the question entry id, the skill is
        RESEARCH_WORKER_DIR/CLAUDE.md.
      * `mode == "distill"` — a per-topic distill (routes/research.py's
        /api/research/topic/distill); `target_id` is the topic id, the skill
        is RESEARCH_DISTILLER_DIR/CLAUDE.md, and the topic's name is looked up
        here so the prompt can say it.

    Returns {"conv_id", "text_file", "prompt"}.
    """
    skeleton_dir = Path(__file__).resolve().parent.parent
    apply_cmd = (
        f"EXOCORTEX_DATA_DIR={store.DATA_DIR} "
        f"{skeleton_dir}/venv/bin/python3 "
        f"{skeleton_dir}/scripts/worker_apply_result.py "
        f"--session {session_id}"
    )

    # Flip the research record to `running` here, at the moment the worker is
    # actually being stood up. The research page reads this status, and the
    # run queue is a separate file it doesn't know about — leaving the session
    # `queued` while its worker was live would make her own page lie.
    with store.mutate("research.json", dict(RESEARCH_DEFAULT)) as data:
        for s in data.get("sessions", []):
            if s.get("id") == session_id:
                s["status"] = "running"

    research = store.read("research.json", dict(RESEARCH_DEFAULT))
    session = next((s for s in research.get("sessions", []) if s.get("id") == session_id), None)
    topic = next((t for t in research.get("topics", []) if t.get("id") == target_id), None)
    topic_name = topic["name"] if topic else target_id

    # Mint the conversation, then close the trace from the research side.
    # Two writes to two files, conversation first: a research record naming a
    # conversation that doesn't exist is the worse of the two half-states.
    conv_id = research_room.mint_research_conversation(
        session_id,
        worker_title(session, mode, target_id, research),
        model=(session or {}).get("model"),
        system_prompt_file=worker_skill_file(mode),
    )
    research_ctl.set_session(session_id, conv_id=conv_id, run_id=run_id)

    prompt = worker_prompt(session_id, mode, target_id, topic_name, apply_cmd)
    text_file = kickoff_path(run_id or conv_id)
    store.write_text_file(text_file, prompt)
    return {"conv_id": conv_id, "text_file": str(text_file), "prompt": prompt}


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
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    main()
