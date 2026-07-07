#!/usr/bin/env python3
"""Admit queued annotation-batch research workers as memory allows.

Companion to routes/research.py's POST /api/research/annotation-batch, which
only QUEUES sessions (marking each `"worker": True`) rather than spawning a
Claude process for every item — a batch of 6 spawned immediately used to OOM
the 3.7GB VPS, since each `claude` process runs ~400MB. This script is the
other half: it admits workers one at a time, only when there's actual memory
headroom, checking in on stuck ones along the way.

Meant to be run by cron every minute AND kicked once, fire-and-forget, right
after a batch is queued (routes/research.py's `_kick_dispatcher`) and right
after a worker finishes applying its result (scripts/worker_apply_result.py's
`_kick_dispatcher`) — so the queue actually drains instead of sitting idle
until the next cron tick:

    * * * * * EXOCORTEX_DATA_DIR=... /opt/exocortex/skeleton/venv/bin/python3 \\
        /opt/exocortex/skeleton/scripts/research_dispatcher.py

    EXOCORTEX_DATA_DIR=... /opt/exocortex/skeleton/venv/bin/python3 \\
        scripts/research_dispatcher.py [--ending <tmux_name>]

`--ending` names the tmux session the *caller* is about to close (a worker
that just called APPLY, right before it kills its own tmux session) — it's
excluded from the live-worker count so the dispatcher doesn't undercount the
headroom that session is about to free.

Each invocation, under a non-blocking flock (so overlapping cron ticks and
kicks can't race each other — if another run already holds the lock, this
exits immediately, silently, code 0):

  1. Read research.json. Worker sessions = sessions with `worker == True`
     (this excludes the research-runner/research-deep/filer sessions, which
     aren't dispatcher-managed).
  2. List live worker tmux sessions (the `rw-` prefix), via shared.tmux.
  3. RECOVERY: a worker session stuck "running" whose tmux session isn't
     live and which never got an llm reply goes back to "queued" — or
     "failed" after a second dead attempt. One store.mutate for all of it.
  4. SLOTS: MemAvailable from /proc/meminfo drives how many workers we could
     admit right now (hard cap 3 concurrent, 1GB kept free, ~450MB budgeted
     per worker).
  5. ADMIT AT MOST ONE per invocation — the oldest queued worker, if slots
     allow — then spawns it exactly as the old routes/research.py
     `_spawn_worker` did. One admission per run is deliberate: it lets a
     freshly-spawned process's memory settle before the next MemAvailable
     reading, rather than trusting a stale number to admit several at once.
  6. Prints one concise log line describing what happened.

Structured as small functions with injectable dependencies (meminfo reader,
tmux lister, spawner, clock) so tests can drive the logic without touching
tmux or the real clock; `main()` / `run_once()` wire up the real ones.
"""
import argparse
import fcntl
import os
import re
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
from routes.kitchen import shared  # noqa: E402

LOCK_NAME = "research_dispatcher.lock"
MAX_CONCURRENT = 3
FLOOR_MB = 1024      # kept free, never spent on a worker
PER_WORKER_MB = 450  # budget per worker (each `claude` process is ~400MB)
MAX_ATTEMPTS = 2


# --- meminfo / tmux (the real dependencies main() wires up) -----------------

def read_meminfo_mb():
    """Real MemAvailable reader, kB -> MB, from /proc/meminfo."""
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable not found in /proc/meminfo")


def list_live_workers(tmux_fn, ending=None):
    """Names of currently-live tmux worker sessions (the `rw-` prefix),
    excluding `ending` (the caller's own about-to-close session)."""
    result = tmux_fn("list-sessions -F '#{session_name}'")
    if result.returncode != 0:
        return set()  # no tmux server / no sessions at all
    names = [n.strip() for n in (result.stdout or "").splitlines() if n.strip()]
    return {n for n in names if n.startswith("rw-") and n != ending}


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


def compute_slots(avail_mb, live_count):
    """Admission budget for this run: hard-capped at MAX_CONCURRENT workers,
    FLOOR_MB kept free, PER_WORKER_MB budgeted per worker."""
    return min(MAX_CONCURRENT - live_count, (avail_mb - FLOOR_MB) // PER_WORKER_MB)


def admit_one(data, slots):
    """If there's room and a queued worker session waiting, promote the
    oldest (by `created`, id tiebreak) to "running". Mutates `data` in
    place. Returns the promoted session dict, or None. At most one — never
    more, even if slots allow several (see module docstring)."""
    if slots < 1:
        return None
    queued = [s for s in data.get("sessions", []) if s.get("worker") and s.get("status") == "queued"]
    if not queued:
        return None
    queued.sort(key=lambda s: (s.get("created", ""), s["id"]))
    chosen = queued[0]
    chosen["status"] = "running"
    return chosen


def describe_run(recovered, admitted):
    bits = []
    if recovered:
        bits.append(f"recovered {len(recovered)} ({', '.join(recovered)})")
    if admitted:
        bits.append(f"admitted {admitted['id']}")
    return "; ".join(bits) if bits else "nothing to do"


# --- spawning (moved here from routes/research.py's old _spawn_worker) ------

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
    APPLY command, then closes itself. Previously routes/research.py spawned
    this straight from the endpoint; now the dispatcher calls it only once a
    slot actually opens up.
    """
    skeleton_dir = Path(__file__).resolve().parent.parent
    tmux_name = worker_tmux_name(session_id)
    apply_cmd = (
        f"EXOCORTEX_DATA_DIR={store.DATA_DIR} "
        f"{skeleton_dir}/venv/bin/python3 "
        f"{skeleton_dir}/scripts/worker_apply_result.py "
        f"--session {session_id}"
    )
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
    # block=True: this script exits right after run_once — the default
    # daemon-thread send would die with the process before ever typing.
    shared.send_prompt(tmux_name, prompt, block=True)


# --- orchestration ------------------------------------------------------------

def run_once(ending=None, *, meminfo=None, tmux_fn=None, spawner=None, clock=None):
    """One dispatcher pass, under a non-blocking flock on
    store.DATA_DIR / "research_dispatcher.lock" — if another invocation
    already holds it, this returns immediately (exit 0, no output).

    meminfo/tmux_fn/spawner/clock default to the real dependencies, looked
    up by name at call time (not bound as default-argument values) so tests
    can monkeypatch the module-level functions directly, the same way
    test_prompt_dispatcher.py patches `dispatcher.tmux`."""
    meminfo = meminfo or read_meminfo_mb
    tmux_fn = tmux_fn or shared.tmux
    spawner = spawner or spawn_worker
    clock = clock or datetime.now

    lock_path = store.DATA_DIR / LOCK_NAME
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return  # another invocation is already running

        live_names = list_live_workers(tmux_fn, ending=ending)

        with store.mutate("research.json", {"topics": [], "entries": [], "sessions": []}) as data:
            recovered = recover_dead_workers(data, live_names)

        avail_mb = meminfo()
        slots = compute_slots(avail_mb, len(live_names))

        with store.mutate("research.json", {"topics": [], "entries": [], "sessions": []}) as data:
            admitted = admit_one(data, slots)

        if admitted:
            # A distill session has no entry_ids (nothing to research — it
            # synthesizes a topic instead), so its "target" for spawn_worker
            # is the topic id, not a question id.
            if admitted.get("mode") == "distill":
                target_id = (admitted.get("topics") or [None])[0]
            else:
                target_id = admitted["entry_ids"][0]
            spawner(admitted["id"], admitted.get("mode", "regular"), target_id)

        print(f"[{clock():%Y-%m-%d %H:%M:%S}] research-dispatcher: {describe_run(recovered, admitted)}")


def main():
    parser = argparse.ArgumentParser(
        description="Admit queued research annotation-batch workers as memory allows.",
    )
    parser.add_argument(
        "--ending", default=None,
        help="tmux name of the caller's own about-to-close worker session — "
             "excluded from the live-worker count.",
    )
    args = parser.parse_args()
    run_once(ending=args.ending)


if __name__ == "__main__":
    main()
