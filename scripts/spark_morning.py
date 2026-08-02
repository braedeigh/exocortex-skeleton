#!/usr/bin/env python3
"""spark_morning.py — the 5 AM build-orientation ritual.

Every morning: kill yesterday's Spark session and respawn a fresh one in the
observatory, already oriented on the build so the owner walks up to a ranked
take instead of a blank prompt.

A "Spark session" is just a native observatory conversation (it shows up in
the flat Sessions list next to `chat`/`dev2`, no bot label) whose first turn is
seeded with `/spark` + an orientation kickoff. The turn runs headless `claude`
exactly the way routes/observatory.bot_send does — same _spawn + _run_turn —
but SYNCHRONOUSLY (a one-shot cron script has no HTTP connection to detach
from and nothing to stay alive for). When it finishes, the ranked orientation
is already sitting in bot_chats/<conv>.jsonl, ready to open.

"Kill + respawn" (the owner's call): yesterday's spark-morning conversation is
archived (leaves the roster; its log stays — her record is the record) before
today's is created, so the list shows one current Spark, not a pile.

The kill is GUARDED, though (her rule): a prior Spark survives if she actually
talked to it AND has touched it within the last 24 hours. So an orientation she
never opened gets cleared as before, and a session she was working in yesterday
afternoon is still on the roster this morning — it only ages out once it's gone
a full day untouched. See _was_used for why "did she talk to it" can't be read
off the index entry.

Cwd is the SKELETON checkout, not the vault: Spark builds the app, so it should
boot skeleton/CLAUDE.md and act on the code. The turn runs with a full tool set
so Spark can actually do the work (and spin things off) once she picks a task;
the 5 AM turn itself is orientation-only by instruction, not by tool-scoping.

Run by cron every morning (the owner wires the crontab):

    0 5 * * * EXOCORTEX_DATA_DIR=... \
        /opt/exocortex/skeleton/venv/bin/python3 \
        /opt/exocortex/skeleton/scripts/spark_morning.py \
        >> .../spark_morning.log 2>&1

Needs the venv python (imports the app's observatory route module). Marks the
conversation with origin="spark_morning" so tomorrow's run can find and archive
exactly its own prior sessions and never touch a hand-made one.
"""
import json
import queue
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store                                    # noqa: E402
from routes import observatory as rr           # noqa: E402

ORIGIN = "spark_morning"
RUN_ID = "spark_morning"   # id in the scheduled_runs.json registry
SKELETON_CWD = str(Path(__file__).resolve().parents[1])


def _registry_default():
    return {
        "id": RUN_ID,
        "name": "Morning Spark",
        "description": "A fresh, oriented Spark session in the observatory each "
                       "morning, ranked against the build.",
        "schedule": "0 5 * * *",
        "schedule_human": "Every day at 5:00 AM",
        "enabled": True,
        "last_run": None,
        "last_status": None,
        "last_conv_id": None,
        "last_cost_usd": None,
    }


def _is_enabled():
    """The UI's pause switch: scripts honor `enabled` so a run can be turned off
    without touching cron. Unregistered (first run ever) = enabled by default."""
    for r in store.read("scheduled_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("id") == RUN_ID:
            return r.get("enabled", True)
    return True


def _record_status(status, conv_id=None, cost=None):
    """Write this run's outcome back to the registry so the Automations page can
    show last-run time/status and a link to the session it produced. Upserts the
    entry, so the registry is self-seeding on first run."""
    with store.mutate("scheduled_runs.json", {"runs": []}) as data:
        runs = data.setdefault("runs", [])
        entry = next((r for r in runs if isinstance(r, dict) and r.get("id") == RUN_ID), None)
        if entry is None:
            entry = _registry_default()
            runs.append(entry)
        entry["last_run"] = rr._now()
        entry["last_status"] = status
        if conv_id is not None:
            entry["last_conv_id"] = conv_id
        if cost is not None:
            entry["last_cost_usd"] = cost

# Full tool set for the turn — Spark builds, it doesn't just read. (On this
# box --allowedTools doesn't restrict in -p, but naming them keeps the turn
# correct regardless of that quirk.)
SPARK_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash",
               "WebFetch", "WebSearch", "TodoWrite"]

KICKOFF = """/spark

Good morning. Orient me on the build so I can pick what to work on today.

Read the per-page dev notes in {data}/dev_notes.json across ALL tabs, the build
queue in {skel}/dev_todo.md, and the recent history
(`git -C {skel} log --oneline -25`). Then give me a prioritized take: the top
handful of things worth doing today and WHY, each with a one-line reason.

Rank by, in order: does it block Rodeo (Oct 15, multi-user + privacy toggle);
does it help today vs. someday; impact (data-loss/broken > annoyance > polish);
effort (quick win vs. project). Call out anything that's on fire.

This is orientation ONLY — don't edit code or spawn anything yet. When I pick
something, we'll spin it off together.""".format(data=store.DATA_DIR, skel=SKELETON_CWD)


def _log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


KEEP_WINDOW_HOURS = 24


def _was_used(conv_id):
    """Did she actually say anything to this Spark, or is it just the 5 AM
    orientation nobody opened?

    Counts her messages in the conversation log, and the shape matters: the
    log's `user` events are NOT all hers. Claude Code relays tool RESULTS as
    `user` events too, so a session she never touched can still show dozens of
    them (2026-08-01 had 42 `user` events and exactly one message from her).
    Hers are the ones the send path stamps with a `ts` and real text; tool
    results arrive with neither.

    The seeded kickoff is itself one such message, so "used" means MORE than
    one. Unreadable/missing log → treat as used, so a bad read can never be
    the reason a session she was working in disappears.

    `last_prompt` on the index entry looks like the obvious signal and is the
    wrong one — it's gated on _card_prompt/journal in the send path, so it sat
    empty on sessions with real conversations in them."""
    path = rr._chats_dir() / f"{conv_id}.jsonl"
    try:
        mine = 0
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(event, dict) and event.get("type") == "user"
                        and event.get("ts") and str(event.get("text") or "").strip()):
                    mine += 1
                    if mine > 1:
                        return True
        return False
    except OSError:
        return True


def _is_fresh(meta):
    """Has she touched it inside the keep window? An unparseable/missing
    `last_at` counts as fresh — same bias as _was_used, never delete on a
    reading failure."""
    stamp = meta.get("last_at") or meta.get("started")
    if not stamp:
        return True
    try:
        seen = datetime.fromisoformat(str(stamp))
    except ValueError:
        return True
    return (datetime.now() - seen) < timedelta(hours=KEEP_WINDOW_HOURS)


def _archive_prior():
    """Archive the conversations this ritual made before — the 'kill' half of
    kill+respawn. Only ever touches entries we stamped with our ORIGIN, and
    only ones she's finished with: a prior Spark is SPARED when she both
    talked to it and touched it within KEEP_WINDOW_HOURS."""
    killed = kept = 0
    with store.mutate("bot_chats/index", {}) as index:
        for conv_id, meta in index.items():
            if not isinstance(meta, dict) or meta.get("origin") != ORIGIN \
                    or meta.get("archived"):
                continue
            if _was_used(conv_id) and _is_fresh(meta):
                kept += 1
                _log(f"keeping {conv_id} — in use within {KEEP_WINDOW_HOURS}h")
                continue
            meta["archived"] = rr._now()
            killed += 1
    if killed:
        _log(f"archived {killed} prior spark-morning session(s)")
    if kept:
        _log(f"kept {kept} prior spark-morning session(s) still in use")


def _create_conv():
    """Respawn half: a fresh conversation in the flat observatory list, cwd'd
    into the skeleton so Spark works on the app code."""
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        conv_id = rr._new_conv_id(index)
        index[conv_id] = {
            "bot": "keeper",                     # the single engine → shows in the flat list
            "origin": ORIGIN,
            "started": rr._now(),
            "last_at": rr._now(),
            "claude_session_id": None,
            "title": f"Spark — {datetime.now():%a %b %-d}",
            "cost_usd": 0.0,
            "journal": False,                    # a build workshop, never the diary
            "cwd": SKELETON_CWD,
            "running": True,
        }
    return conv_id


def _run_orientation(conv_id):
    bot = dict(rr._bot("keeper") or {}, allowed_tools=SPARK_TOOLS)
    log_path = rr._chats_dir() / f"{conv_id}.jsonl"
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(json.dumps({"type": "user", "text": KICKOFF,
                              "ts": rr._now(), "journaled": False}) + "\n")
    proc, stderr_f = rr._spawn(bot, KICKOFF, None, cwd_override=SKELETON_CWD)
    # Synchronous: a cron one-shot has nothing to detach to. _run_turn drains
    # its own events into a throwaway queue and persists session id/cost/running
    # to the index when the turn ends.
    rr._run_turn(proc, stderr_f, conv_id, log_path, True, None, queue.Queue())


def main():
    if not store.DATA_DIR.exists():
        _log(f"ERROR: DATA_DIR {store.DATA_DIR} missing — is EXOCORTEX_DATA_DIR set?")
        return 1
    if not _is_enabled():
        _log("disabled in scheduled_runs.json — skipping this run")
        return 0
    try:
        _archive_prior()
        conv_id = _create_conv()
        _log(f"spawned spark session {conv_id} (cwd={SKELETON_CWD})")
        _run_orientation(conv_id)
        entry = store.read("bot_chats/index", {}).get(conv_id, {})
        _log(f"orientation done: session={entry.get('claude_session_id')} "
             f"cost=${entry.get('cost_usd')}")
        _record_status("ok", conv_id=conv_id, cost=entry.get("cost_usd"))
        return 0
    except Exception as e:
        _log(f"ERROR: {type(e).__name__}: {e}")
        _record_status("error")
        # Best-effort: clear the running flag so a crashed turn doesn't read
        # as forever-busy in the roster.
        try:
            with store.mutate("bot_chats/index", {}) as index:
                for meta in index.values():
                    if isinstance(meta, dict) and meta.get("origin") == ORIGIN \
                            and meta.get("running"):
                        meta["running"] = False
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
