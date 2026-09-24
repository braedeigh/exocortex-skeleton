#!/usr/bin/env python3
"""run_dispatcher.py — the one door every background run walks through.

Plain English: this box has ~3.8GB of RAM, no swap, and three cores, and every
`claude` process on it wants about 400MB. Before this file existed, four
different pieces of code each decided independently whether there was room to
start one, and none of them could see the other three. This is that decision,
made once, in one place, for everybody.

Every minute, cron runs this. It takes a lock so two copies can't overlap, reads
the queue, works out which of the currently-"running" runs are ACTUALLY alive,
checks how much memory is free, and — if there's room — promotes exactly one
waiting run to running and starts it. Then it writes one log line and exits. On
most ticks it does nothing at all and takes well under a second.

Four rules it never breaks:
  - ONE ADMISSION PER TICK. A freshly-spawned process's memory hasn't settled
    yet, so trusting a single MemAvailable reading to admit three at once is how
    you OOM the box.
  - NEVER PREEMPT. It decides what STARTS. A run that's going gets to finish;
    nothing here ever kills anything to make room.
  - LIVENESS BY EVIDENCE, NEVER THE FLAG. A run is alive because its process or
    its log says so, not because a field says `running`. Stale flags are how the
    session sorter lost four conversations for nine days.
  - A RATE-LIMITED RUN PAUSES EVERYTHING. Nothing was attempted, so it goes back
    in the queue — and the whole queue holds for a cooling period instead of
    spending the rest of it against the same wall.

WHY IT SPAWNS FROM CRON. `systemctl restart exocortex.service` SIGTERMs
everything in the service's cgroup, and today that includes every agent the web
app started (KillMode defaults to control-group, and setsid does not escape a
cgroup — verified). A run spawned from THIS process lands in cron.service's
cgroup instead, so restarting the site can't kill it. That closes the harness
gap for free: no systemd-run, no root, no user-manager lingering required.

Touches:
  - data/run_queue.json — the queue this file owns (crews enqueue; only this
    file admits).
  - scripts/usage_ledger.py — receipts at reap, and the throttle test.
  - scripts/research_dispatcher.py — the research crew's adapter; its
    spawn_worker() is what a research_worker run calls to mint the worker's
    research-room conversation before the runner below starts it.
  - scripts/spinoff_runner.py — hosts an Observatory turn outside gunicorn,
    which is how a queued session of hers — and, since 09-24, a research
    worker — gets started.
  - data/scheduled_runs.json — the Automations pause switch, honored the same
    way every other cron script here honors it.

Structured as small pure functions with injectable dependencies (meminfo
reader, probe, spawner, clock) so tests drive the whole thing without touching
tmux, /proc, or the real clock — same shape and same reasons as
scripts/research_dispatcher.py, which this file promotes.

Prompt that produced it: "i need some feature that measures the memory on the
machine that is being utilized by all the crews at once and is able to queue
runs and stage them based on a prioirtiy."
"""
import argparse
import fcntl
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Make the skeleton root importable regardless of where this is invoked from
# (mirrors scripts/research_dispatcher.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
from scripts import usage_ledger  # noqa: E402

QUEUE = "run_queue.json"
LOCK_NAME = "run_dispatcher.lock"
RUN_ID = "run_dispatcher"          # its id in scheduled_runs.json
KICKOFF_DIR = "run_kickoffs"       # where a queued turn's prompt text waits

# Priority order, hers, 2026-08-03. FIFO within a lane; a lane can be bumped up
# by waiting (see effective_rank). Night builds sit last on purpose — they run
# at midnight when nothing competes, so they don't need rank, they need an empty
# box. `hers` is a session SHE chose to queue: her live sessions are never
# queued against her will, only when she taps "queue it" on the memory prompt.
LANES = ("keeper", "hers", "research", "housekeeping", "night")

# What one run of each shape actually costs. The queue entry declares its class;
# a class we don't recognize is budgeted as the larger one, because guessing
# small is the guess that OOMs.
MEM_CLASSES = {"agent": 450, "agent_verify": 900}
DEFAULT_MEM_CLASS = "agent"

CAP = 3              # concurrent background runs, ever (3 cores)
FLOOR_MB = 1024      # kept free, never spent on a run
AGE_BUMP_MIN = 30    # minutes of waiting that promote a run one lane
MAX_ATTEMPTS = 2     # a run that dies twice without finishing is failed
COOLDOWN_MIN = 60    # how long a rate-limit pauses the whole queue
STALE_SEC = 600      # how quiet a running turn's log can go before it's dead
KEEP_FINISHED = 50   # finished runs kept in the queue file for the UI


# --- real dependencies (main() wires these up) -------------------------------

def queue_default():
    """A FRESH empty queue every call.

    Deliberately a function, not a module constant: store.mutate hands the
    default straight through when the file doesn't exist yet, so a shared dict
    would have its `runs` list appended to and written back — the "default"
    would quietly accumulate real runs and every later caller would inherit
    them. A constant here is a bug that only shows up on a fresh install.
    """
    return {"runs": [], "paused_until": None, "pause_reason": None}


def read_meminfo_mb():
    """MemAvailable from /proc/meminfo, kB -> MB."""
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable not found in /proc/meminfo")


def enabled():
    """The Automations page's pause switch — the same contract every cron
    script here honors, so the dispatcher can be turned off from the UI without
    touching crontab."""
    for r in store.read("scheduled_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("id") == RUN_ID:
            return r.get("enabled", True)
    return True


# --- pure logic (no I/O — this is the part the tests drive) ------------------

def parse_ts(value):
    """One of our own ISO timestamps back into a datetime, or None."""
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def now_str(clock=None):
    return (clock or datetime.now)().isoformat(timespec="seconds")


def lane_index(lane):
    """Where a lane sits in the order. An unknown lane sorts last rather than
    first — a typo in a crew's enqueue should cost it priority, not grant it."""
    try:
        return LANES.index(lane)
    except ValueError:
        return len(LANES)


def mem_needed(run):
    return MEM_CLASSES.get(run.get("mem_class"), MEM_CLASSES["agent_verify"])


def effective_rank(run, now):
    """Lane index, minus one step per AGE_BUMP_MIN minutes spent waiting.

    This is the anti-starvation bump: without it, a steady trickle of keeper
    work would mean a housekeeping run queued on Monday is still queued on
    Friday. With it, an hour of waiting lifts a run two lanes, so everything
    eventually reaches the front. Floored at 0 — nothing outranks a fresh
    keeper run."""
    idx = lane_index(run.get("lane"))
    queued = parse_ts(run.get("queued_at"))
    if queued is None:
        return idx
    waited_min = max(0.0, (now - queued).total_seconds() / 60.0)
    return max(0, idx - int(waited_min // AGE_BUMP_MIN))


def running_runs(data):
    return [r for r in data.get("runs", []) if r.get("status") == "running"]


def queued_runs(data):
    return [r for r in data.get("runs", []) if r.get("status") == "queued"]


def compute_slots(avail_mb, live_count):
    """How many more runs could start right now, by headcount alone. Memory
    fitness for a SPECIFIC run is a separate question (see next_admit) — this
    is the cap and the floor, nothing else."""
    if avail_mb - FLOOR_MB < MEM_CLASSES["agent"]:
        return 0
    return max(0, CAP - live_count)


def next_admit(data, now, avail_mb, live_count):
    """The one run to start this tick, or None.

    Best effective rank wins; ties break by how long it's been queued, then id.
    If the winner doesn't FIT in the free memory, this admits nothing — it does
    not skip down to a smaller run that would fit. That's deliberate: letting
    small runs hop a big one means a 900MB night build could sit behind an
    endless trickle of 450MB workers and never start. Head-of-line waiting is
    visible and self-clearing (memory frees up); silent starvation isn't.
    """
    if compute_slots(avail_mb, live_count) < 1:
        return None
    waiting = queued_runs(data)
    if not waiting:
        return None
    waiting.sort(key=lambda r: (effective_rank(r, now),
                                r.get("queued_at") or "", r.get("id") or ""))
    chosen = waiting[0]
    if avail_mb - FLOOR_MB < mem_needed(chosen):
        return None
    return chosen


def is_paused(data, now):
    until = parse_ts(data.get("paused_until"))
    return until is not None and now < until


def set_pause(data, now, reason, minutes=COOLDOWN_MIN):
    """Hold the whole queue. Reaping still happens while paused — we keep
    learning what finished, we just stop starting anything new."""
    data["paused_until"] = (now + timedelta(minutes=minutes)).isoformat(timespec="seconds")
    data["pause_reason"] = reason


def prune_finished(data, keep=KEEP_FINISHED):
    """Keep the queue file small. The full history lives in the ledger
    (token_usage.json); what stays here is just enough recent tail for a queue
    view to show what happened."""
    runs = data.get("runs", [])
    done = [r for r in runs if r.get("status") in ("done", "failed")]
    if len(done) <= keep:
        return 0
    done.sort(key=lambda r: r.get("finished") or "")
    drop = {id(r) for r in done[:len(done) - keep]}
    data["runs"] = [r for r in runs if id(r) not in drop]
    return len(drop)


def new_run(lane, kind, spawn, mem_class=DEFAULT_MEM_CLASS, clock=None, **extra):
    """Build a queue entry. The one constructor every crew's adapter calls, so
    the shape can't drift between them."""
    clock = clock or datetime.now
    stamp = clock()
    run = {
        "id": f"rq-{stamp:%m%d-%H%M%S}-{kind[:12]}",
        "lane": lane if lane in LANES else "housekeeping",
        "kind": kind,
        "mem_class": mem_class if mem_class in MEM_CLASSES else DEFAULT_MEM_CLASS,
        "status": "queued",
        "queued_at": stamp.isoformat(timespec="seconds"),
        "attempts": 0,
        "spawn": dict(spawn or {}),
        "started": None,
        "finished": None,
        "model": None,
        "conv_id": None,
        "claude_session": None,
        "claude_cwd": None,
    }
    run.update(extra)
    return run


def settle(run, probe_result, now):
    """Decide what a no-longer-alive run becomes, and mutate it in place.

    Three outcomes, and telling them apart is the whole job:
      - it finished (or errored honestly) -> done / failed, and it earns a
        receipt.
      - it was rate-limited -> back to `queued`, attempt NOT counted, because
        nothing was tried. The caller also pauses the queue.
      - it just vanished -> back to `queued` and count the attempt; on the
        second disappearance it's `failed`, same as the research dispatcher's
        dead-worker recovery.

    Returns one of "done", "failed", "requeued", "throttled".
    """
    error = probe_result.get("error")
    # Backfill the ids a receipt needs, never overwriting what the run already
    # knows. conv_id is here for a research worker: its conversation is
    # minted at spawn, after admission wrote the run, so the probe is the
    # first chance to learn it if the spawn's own write-back was missed.
    for field in ("claude_session", "claude_cwd", "model", "conv_id"):
        if probe_result.get(field) and not run.get(field):
            run[field] = probe_result[field]

    if error and usage_ledger.looks_throttled(error):
        run["status"] = "queued"
        run["throttled"] = True
        run["started"] = None
        return "throttled"

    if probe_result.get("completed") or error:
        run["status"] = "failed" if error else "done"
        run["finished"] = now.isoformat(timespec="seconds")
        if error:
            run["error"] = str(error)[:300]
        return run["status"]

    attempts = run.get("attempts", 0) + 1
    run["attempts"] = attempts
    if attempts >= MAX_ATTEMPTS:
        run["status"] = "failed"
        run["finished"] = now.isoformat(timespec="seconds")
        run["error"] = "the run died twice without finishing — gave up"
        return "failed"
    run["status"] = "queued"
    run["started"] = None
    return "requeued"


def describe(admitted, settled, paused):
    bits = []
    for outcome in ("done", "failed", "requeued", "throttled"):
        n = sum(1 for s in settled if s == outcome)
        if n:
            bits.append(f"{outcome} {n}")
    if admitted:
        bits.append(f"admitted {admitted['id']} ({admitted['lane']})")
    if paused:
        bits.append("QUEUE PAUSED — rate limit")
    return "; ".join(bits) if bits else "nothing to do"


# --- probing: how we know a run is still alive -------------------------------

# The research crew's spawn types: the current name and the one runs queued
# before the move to the research room still carry. Spawned and probed alike.
RESEARCH_SPAWN_TYPES = ("research_worker", "tmux_worker")


def _live_tmux_names(tmux_fn):
    result = tmux_fn("list-sessions -F '#{session_name}'")
    if result.returncode != 0:
        return set()
    return {n.strip() for n in (result.stdout or "").splitlines() if n.strip()}


def make_probe(tmux_fn=None, clock=None, log_mtime_fn=None):
    """Build the real probe: one function that answers, for any run, "is it
    alive, did it finish, and did it error."

    Reads its evidence ONCE per tick (the tmux session list, the conversation
    index, the research collection) and closes over it, so a queue of ten
    running runs doesn't re-read the same three things ten times.
    """
    from routes.kitchen import shared
    from scripts import research_dispatcher

    tmux_fn = tmux_fn or shared.tmux
    clock = clock or datetime.now
    live_names = _live_tmux_names(tmux_fn)
    index = store.read("bot_chats/index", {}) or {}
    research = store.read("research.json", {"sessions": [], "entries": []}) or {}

    def probe(run):
        spawn = run.get("spawn") or {}
        kind = spawn.get("type")

        if kind in RESEARCH_SPAWN_TYPES:
            # A research worker is done when the research record says so: a
            # done/failed status, or an llm reply filed under its session.
            # Completion is judged there rather than on the conversation
            # because APPLY closes the record before the turn ends, and the
            # record is what her Research page reads.
            sid = spawn.get("session_id")
            session = next((s for s in research.get("sessions", [])
                            if s.get("id") == sid), None) or {}
            has_reply = any(e.get("session") == sid and e.get("author") == "llm"
                            for e in research.get("entries", []))
            completed = has_reply or session.get("status") in ("done", "failed")
            conv_id = run.get("conv_id") or session.get("conv_id")
            entry = index.get(conv_id) if (conv_id and isinstance(index, dict)) else None
            entry = entry if isinstance(entry, dict) else {}
            if conv_id:
                # A room worker is alive the way any observatory turn is:
                # the index says running AND a witness has moved recently
                # (quiet_seconds) — the flag alone is what this file refuses
                # to trust.
                quiet = quiet_seconds(conv_id, entry, clock(), log_mtime_fn)
                alive = bool(entry.get("running")) and quiet is not None and quiet < STALE_SEC
            else:
                # A LEGACY record (spawned into tmux before the move) has no
                # conversation; its pane is the only witness left.
                name = research_dispatcher.worker_tmux_name(sid) if sid else None
                alive = bool(name and name in live_names)
            return {
                "alive": alive,
                "completed": completed,
                "error": session.get("error") or entry.get("last_error"),
                "conv_id": conv_id,
                # The Claude session id is kept for the ledger; the cwd is
                # deliberately NOT taken from the conversation, so the receipt
                # sums the conversation's own log (conv_totals) rather than
                # time-slicing a transcript that isn't the record here.
                "claude_session": session.get("claude_session") or entry.get("claude_session_id"),
                "claude_cwd": session.get("claude_cwd"),
                "model": session.get("model") or entry.get("model"),
            }

        if kind == "observatory_turn":
            conv_id = run.get("conv_id") or spawn.get("conv_id")
            entry = index.get(conv_id) if isinstance(index, dict) else None
            entry = entry if isinstance(entry, dict) else {}
            # Alive = the index says running AND its log has moved recently.
            # The flag alone is exactly what we refuse to trust: a worker that
            # died mid-turn leaves it set forever.
            #
            # This used to read `last_at` alone while the comment above claimed
            # it read the log, and the gap between the two was a real bug: back
            # then last_at only moved at the start and the end of a turn, so
            # every turn quiet for STALE_SEC probed dead while perfectly
            # healthy, got requeued, and was failed for good on the next tick
            # (rq-0805-173324 was killed 18 seconds before it finished
            # cleanly). quiet_seconds now grounds the answer in the log the way
            # the comment always said it did.
            quiet = quiet_seconds(conv_id, entry, clock(), log_mtime_fn)
            fresh = quiet is not None and quiet < STALE_SEC
            return {
                "alive": bool(entry.get("running")) and fresh,
                "completed": bool(entry) and not entry.get("running"),
                "error": entry.get("last_error"),
                "claude_session": None,
                "claude_cwd": None,
                "model": entry.get("model"),
            }

        # An unknown spawn type can't be probed, so it can't be trusted alive.
        # It settles as a vanished run and gets the two-strike treatment.
        return {"alive": False, "completed": False, "error": None}

    return probe


# --- spawning ----------------------------------------------------------------

def spawn_run(run):
    """Start one admitted run. Dispatch table keyed on spawn.type, so a new
    crew is a new entry here rather than a new branch inside the logic."""
    spawn = run.get("spawn") or {}
    kind = spawn.get("type")
    if kind in RESEARCH_SPAWN_TYPES:
        # A research worker is two steps: the crew's adapter mints the
        # research-room conversation and writes the kickoff file, then the
        # SAME runner every queued observatory turn uses posts it. The
        # conversation id and file are written back onto the queue entry
        # first, so the reaper and the receipt can find them.
        from scripts import research_dispatcher
        minted = research_dispatcher.spawn_worker(
            spawn.get("session_id"), spawn.get("mode", "regular"), spawn.get("target_id"),
            run_id=run.get("id"))
        run["conv_id"] = minted["conv_id"]
        run["spawn"] = dict(spawn, conv_id=minted["conv_id"], text_file=minted["text_file"])
        run["log_offset"] = conv_log_size(minted["conv_id"])
        record_spawn(run["id"], conv_id=run["conv_id"], spawn=run["spawn"],
                     log_offset=run["log_offset"])
        _spawn_observatory_turn(run)
        return
    if kind == "observatory_turn":
        _spawn_observatory_turn(run)
        return
    raise RuntimeError(f"unknown spawn type {kind!r}")


def record_spawn(run_id, **fields):
    """Write what a spawn learned (its conversation id, the kickoff file) onto
    the queue entry. Its own short mutate, after admission's has closed: the
    admitted dict run_once hands the spawner is a copy from a lock that has
    already been released, so changing it in memory changes nothing on disk."""
    with store.mutate(QUEUE, queue_default()) as data:
        for r in data.get("runs", []):
            if r.get("id") == run_id:
                r.update(fields)


def _spawn_observatory_turn(run):
    """Hand a queued conversation to scripts/spinoff_runner.py, detached.

    That script already exists to host a turn from outside gunicorn (it builds
    a bare Flask app with only the observatory routes and posts through the real
    send path), so a queued session of hers reuses a proven path instead of a
    new one. Launched from here, it inherits cron's cgroup — which is what keeps
    it alive across a `systemctl restart exocortex`.
    """
    conv_id = run.get("conv_id") or (run.get("spawn") or {}).get("conv_id")
    text_file = (run.get("spawn") or {}).get("text_file")
    if not conv_id or not text_file:
        raise RuntimeError("observatory_turn needs conv_id and text_file")
    skeleton = Path(__file__).resolve().parent.parent
    subprocess.Popen(
        [str(skeleton / "venv" / "bin" / "python3"),
         str(skeleton / "scripts" / "spinoff_runner.py"), conv_id, text_file],
        env={**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def conv_log_size(conv_id):
    """Bytes already in a conversation's log. Recorded at spawn so the receipt
    counts only the turns THIS run produced (see usage_ledger.conv_totals)."""
    try:
        return (store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl").stat().st_size
    except OSError:
        return 0


def conv_log_mtime(conv_id):
    """When a conversation's log was last written to, or None if there isn't
    one yet. The turn relay flushes this file on every event it receives
    (routes/observatory.py's turn loop), so the mtime is DIRECT evidence the
    turn is still producing — which is what a probe is supposed to want, as
    against the index's `running` flag, which a worker that died mid-turn
    leaves set forever."""
    try:
        return (store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl").stat().st_mtime
    except OSError:
        return None


def quiet_seconds(conv_id, entry, now, log_mtime_fn=None):
    """How long this conversation has shown no sign of life, measured by the
    freshest of two independent witnesses; None when neither exists.

    Two, because each covers the other's blind spot. The LOG's mtime moves on
    every single event, so it's the more responsive witness — but a turn that
    has spawned and not yet emitted anything may have no log file at all, or
    only a stale one from a previous turn. `last_at` covers exactly that gap:
    the send door stamps it, and the relay re-stamps it every 30s while the
    turn runs (observatory._HEARTBEAT_SEC). Neither is the `running` flag,
    which is the one thing this function refuses to take anyone's word for.
    """
    log_mtime_fn = log_mtime_fn or conv_log_mtime
    witnesses = []
    mtime = log_mtime_fn(conv_id)
    if mtime is not None:
        witnesses.append(datetime.fromtimestamp(mtime))
    last = parse_ts(entry.get("last_at"))
    if last is not None:
        witnesses.append(last)
    if not witnesses:
        return None
    return (now - max(witnesses)).total_seconds()


# --- orchestration ------------------------------------------------------------

def status_to_registry(status, admitted, clock=None):
    """Write this run's outcome back to the Automations registry, so the page
    can never show a schedule the script no longer runs on."""
    with store.mutate("scheduled_runs.json", {"runs": []}) as data:
        runs = data.setdefault("runs", [])
        entry = next((r for r in runs if isinstance(r, dict) and r.get("id") == RUN_ID), None)
        if entry is None:
            entry = {"id": RUN_ID, "name": "Run dispatcher", "enabled": True}
            runs.append(entry)
        entry["description"] = (
            "Admits queued background runs one at a time, as memory allows, in "
            "priority order. Records what each one spent.")
        entry["schedule"] = "* * * * *"
        entry["schedule_human"] = "Every minute"
        entry["last_run"] = now_str(clock)
        entry["last_status"] = status
        if admitted:
            entry["last_admitted"] = admitted.get("id")


def run_once(*, meminfo=None, probe=None, spawner=None, clock=None,
             receipt_fn=None, ledger_fn=None, tmux_fn=None):
    """One dispatcher pass, under a non-blocking flock — if another invocation
    holds it, this returns immediately (exit 0, no output), so overlapping cron
    ticks and event-driven kicks can't race each other.

    Dependencies are resolved at call time rather than bound as default
    arguments, so tests can monkeypatch the module-level functions directly —
    the same pattern tests/test_research_dispatcher.py uses.
    """
    meminfo = meminfo or read_meminfo_mb
    spawner = spawner or spawn_run
    clock = clock or datetime.now
    receipt_fn = receipt_fn or usage_ledger.receipt
    ledger_fn = ledger_fn or usage_ledger.append_entry

    lock_path = store.DATA_DIR / LOCK_NAME
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return  # another invocation is already running

        now = clock()
        settled, receipts, throttled = [], [], False

        # --- REAP: settle everything that's no longer alive -------------------
        with store.mutate(QUEUE, queue_default()) as data:
            live = running_runs(data)
            if live:
                probe_fn = probe or make_probe(tmux_fn=tmux_fn, clock=clock)
                for run in live:
                    result = probe_fn(run) or {}
                    if result.get("alive"):
                        continue
                    outcome = settle(run, result, now)
                    settled.append(outcome)
                    if outcome == "throttled":
                        throttled = True
                    elif outcome in ("done", "failed"):
                        receipts.append(run)
            if throttled:
                set_pause(data, now, "a run hit the subscription's usage limit")
            prune_finished(data)
            live_count = len(running_runs(data))
            paused = is_paused(data, now)

        # Receipts are written OUTSIDE the queue mutate: sum_tokens reads
        # transcripts off disk and /usage shells out, and holding the queue's
        # lock across either would stall every other writer for seconds.
        for run in receipts:
            try:
                ledger_fn(usage_ledger.entry_for(run, receipt_fn(run, now=now)))
            except Exception:
                pass  # a lost receipt must never cost us the reap

        # --- ADMIT: at most one, and only when nothing is holding the queue ---
        admitted = None
        avail_mb = meminfo()
        if not paused:
            with store.mutate(QUEUE, queue_default()) as data:
                chosen = next_admit(data, now, avail_mb, live_count)
                if chosen is not None:
                    chosen["status"] = "running"
                    chosen["started"] = now.isoformat(timespec="seconds")
                    chosen.pop("throttled", None)
                    conv_id = chosen.get("conv_id") or (chosen.get("spawn") or {}).get("conv_id")
                    if conv_id:
                        chosen["conv_id"] = conv_id
                        chosen["log_offset"] = conv_log_size(conv_id)
                    admitted = chosen

        if admitted is not None:
            try:
                spawner(admitted)
            except Exception as e:
                # The spawn failed, so the run is not running — say so honestly
                # rather than leaving a `running` entry nothing will ever reap.
                with store.mutate(QUEUE, queue_default()) as data:
                    for r in data.get("runs", []):
                        if r.get("id") == admitted["id"]:
                            r["status"] = "queued"
                            r["started"] = None
                            r["attempts"] = r.get("attempts", 0) + 1
                            r["error"] = f"spawn failed: {type(e).__name__}: {e}"
                settled.append("requeued")
                admitted = None

        print(f"[{now:%Y-%m-%d %H:%M:%S}] run-dispatcher: "
              f"{describe(admitted, settled, throttled)} "
              f"({avail_mb}MB free, {live_count} live)")
        status_to_registry("ok", admitted, clock=clock)


def main():
    parser = argparse.ArgumentParser(
        description="Admit queued background runs as memory allows, in priority order.")
    parser.parse_args()
    if not store.DATA_DIR.exists():
        print(f"ERROR: DATA_DIR {store.DATA_DIR} missing — is EXOCORTEX_DATA_DIR set?")
        return 1
    if not enabled():
        return 0   # paused from the Automations page; say nothing, do nothing
    run_once()
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
