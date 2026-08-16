#!/usr/bin/env python3
"""spark_morning.py — the 6 AM build-orientation ritual.

Every morning: kill yesterday's Spark session and respawn a fresh one in the
observatory, already oriented on the build so the owner walks up to a
structural read instead of a blank prompt.

WHAT THE TURN DOES (the KICKOFF string below is the whole spec). A cheap fire
check over the two backlogs + git, then it picks UP TO THREE items that look
structurally alarming and sends read-only subagents to verify each one against
the actual code — a locator that finds which files are implicated, then an
analyzer that reads only that narrowed set. She gets a verdict per item
(still real / stale / partly done) with file:line refs, rather than a
restatement of notes she already wrote. "Up to" is deliberate: a fixed quota
of three makes a quiet morning invent a third fire.

THE PHASE ORDER IS LOAD-BEARING: it picks BEFORE it reads the findings
registry. Knowing what it flagged yesterday would bias what it flags today, so
history gets reconciled after the choice and never before it. A repeat that
surfaces on its own is real signal and gets worked again — it just reuses the
prior investigation instead of restarting it. Same discipline as
nightcrew_run.py ignoring what an agent claims and running the tests itself:
measure independently, reconcile second.

THE REGISTRY IS WRITTEN BY THIS SCRIPT, NOT BY THE TURN. The 6 AM session is
act-gated (no explicit lane + a cwd inside the app checkout derives to
orchestra, because nobody is watching it), so it cannot run python to record
anything. Instead the turn drops structured JSON at INBOX_PATH with the Write
tool, and this script — ungated, plain cron — validates it and folds it into
spark_findings.json. The agent proposes; trusted code owns the record. The
inbox is cleared before the turn starts, so a run that writes nothing can
never re-merge yesterday's findings.

Staleness is REPORTED here and never acted on: deleting a note the code has
outrun is the beetles' job, and they ask first.

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
the 6 AM turn itself is orientation-only by instruction, not by tool-scoping.

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
        "schedule": "0 6 * * *",
        "schedule_human": "Every day at 6:00 AM",
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

# Full tool set for the turn — Spark builds, it doesn't just read. `Task` is
# what lets the parent fan out to the read-only locator/analyzer subagents
# instead of dragging forty files into its own context. (On this box
# --allowedTools doesn't restrict in -p, but naming them keeps the turn
# correct regardless of that quirk.)
SPARK_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "Task",
               "WebFetch", "WebSearch", "TodoWrite"]

# Where the turn drops its machine-readable findings for this script to merge.
# A plain path, not a store collection: the turn is act-gated and writes it
# with the Write tool, so it can't go through store.py. Resolved through a
# function rather than a module constant so it follows store.DATA_DIR wherever
# that points — the KICKOFF below still bakes the literal path in, because the
# agent needs somewhere concrete to write.
INBOX_NAME = "spark_morning_inbox.json"
REGISTRY = "spark_findings.json"


def _inbox_path():
    return store.DATA_DIR / INBOX_NAME


def _dev_todo_path():
    """The build queue, resolved rather than hardcoded.

    It sits in the VAULT on this install — it was moved out of the shared repo
    because it carries personal context — but a fresh skeleton checkout may
    still ship its own, so prefer the vault copy and fall back to the checkout.
    This mattered: the prompt named `<skeleton>/dev_todo.md` for two and a half
    weeks after the file moved, so the ritual read one backlog while its own
    instructions claimed two, and nothing anywhere said so."""
    vault = Path(store.CONTENT_DIR).parent / "dev_todo.md"
    return vault if vault.exists() else Path(SKELETON_CWD) / "dev_todo.md"

KICKOFF = """/spark

Good morning. Structural read on the build — not a restatement of my notes,
but what is actually broken, verified against the code.

FIVE PHASES, IN ORDER. Do not skip ahead. Phase 3 must not influence phase 2.

PHASE 1 — FIRE CHECK (cheap; you do this yourself, no subagents)
Read:
  - {todo} — the big structural write-ups; fires usually live here
  - {data}/dev_notes.json — ~180 per-page notes across all tabs; the pool
  - `git -C {skel} log --oneline -25` and `git -C {skel} status --short`
Do NOT open code files yourself in this phase, and do NOT read the findings
registry yet.

PHASE 2 — PICK, BLIND
Pick UP TO THREE items that are the most alarming STRUCTURALLY. Fewer is
correct and expected: if only one clears the bar, return one and say so out
loud. Never promote a minor item just to fill a slot.
Structural means it (a) touches a seam that multiple features ride on,
(b) risks data loss or silent inconsistency, or (c) blocks other queued work.
Backend-leaning, but the backend/frontend seam counts — data capture
especially. Pure UI polish is not structural however annoying it is.

PHASE 3 — ONLY NOW, read the registry at {registry}
For each pick already chosen: if it appears there, note `first_seen` and
`times_seen`; if it carries a `conv_id`, that is a prior investigation — have
the analyzer VERIFY AND EXTEND it rather than restart from zero.
You read this after choosing on purpose. Knowing what you flagged before would
bias what you flag now, and a repeat that surfaced independently is real
signal — it gets worked again, not skipped.

PHASE 4 — DIG (read-only subagents, one pass per pick)
For each pick, in this order:
  LOCATOR (Task): find WHICH files the item implicates. ls/grep/glob only —
    do not read file bodies. Return a short file list, one line each on why.
  ANALYZER (Task): read ONLY that file list. Return the verdict below.
You do not open code files yourself. Subagents are READ-ONLY and never edit.

PHASE 5 — REPORT, then record
Per pick, in this shape:
  - the item verbatim, with its id / source
  - VERDICT (required): still real / stale / partly done
  - what is actually true in the code now, with file:line refs
  - blast radius if I touch it
  - effort: quick win / session / project
  - the one decision only I can make
  - if a repeat: "still open since <first_seen>, seen N times" + prior conv id
Then write the machine record to {inbox} using the Write tool, as JSON:
  {{"findings": [{{"key": ..., "label": ..., "source": ...,
                  "verdict": ..., "summary": ...}}]}}
`key` is a stable slug — "devnote:<id>" for a dev note, "devtodo:<short-slug>"
for a dev_todo.md item. Write the file even if you picked nothing (empty list).

Staleness is REPORTED here and never acted on — the beetles do the deleting
and they ask first. Do not edit or delete any note.

This is orientation ONLY: don't edit code, and spawn nothing beyond the
read-only subagents above. When I pick something, we'll spin it off together.
""".format(data=store.DATA_DIR, skel=SKELETON_CWD, todo=_dev_todo_path(),
           registry=store.DATA_DIR / REGISTRY,
           inbox=store.DATA_DIR / INBOX_NAME)


def _log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


KEEP_WINDOW_HOURS = 24


def _was_used(conv_id):
    """Did she actually say anything to this Spark, or is it just the 6 AM
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
    rr._run_turn(proc, stderr_f, conv_id, log_path, None, queue.Queue())


# A defensive ceiling, not a product rule: the prompt asks for at most three.
# Anything past this is a confused turn, and the registry shouldn't inherit it.
MAX_FINDINGS = 20


def _clear_inbox():
    """Wipe the drop point before the turn runs. Without this, a turn that
    writes nothing — crashed, refused, ran out of window — would leave
    yesterday's file in place and the merge would bank it as today's work."""
    try:
        _inbox_path().unlink()
    except FileNotFoundError:
        pass
    except OSError as e:
        _log(f"WARN: could not clear inbox: {e}")


def _read_inbox():
    """Whatever the turn wrote, read defensively. Every malformed shape is
    dropped and logged rather than raised: a bad findings file must never cost
    her the orientation that's already sitting in the session log."""
    try:
        raw = json.loads(_inbox_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        _log("no findings file written by the turn")
        return []
    except (OSError, ValueError) as e:
        _log(f"WARN: unreadable findings file: {type(e).__name__}: {e}")
        return []
    items = raw.get("findings") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        _log("WARN: findings file carries no findings[] list")
        return []
    clean = []
    for item in items[:MAX_FINDINGS]:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if not key:            # keyless rows can't be deduped, so they're noise
            continue
        clean.append({"key": key,
                      "label": str(item.get("label") or "").strip(),
                      "source": str(item.get("source") or "").strip(),
                      "verdict": str(item.get("verdict") or "").strip(),
                      "summary": str(item.get("summary") or "").strip()})
    return clean


def _merge_findings(conv_id):
    """Fold the turn's findings into the durable registry, keyed by slug.

    Upsert, never blind-append: a repeat keeps its original `first_seen` and
    bumps `times_seen`, which is exactly the "still open since Aug 3, seen 4
    times" line tomorrow's run reads back in phase 3. `conv_id` always points
    at the MOST RECENT session that investigated the item — that's the one
    worth reopening, and talking to it un-archives it."""
    found = _read_inbox()
    if not found:
        return 0
    today = datetime.now().strftime("%Y-%m-%d")
    with store.mutate(REGISTRY, {"findings": []}) as data:
        rows = data.setdefault("findings", [])
        by_key = {r.get("key"): r for r in rows if isinstance(r, dict)}
        for item in found:
            row = by_key.get(item["key"])
            if row is None:
                row = {"key": item["key"], "first_seen": today, "times_seen": 0}
                rows.append(row)
                by_key[item["key"]] = row
            row.update({k: v for k, v in item.items() if k != "key"})
            row["last_seen"] = today
            row["times_seen"] = int(row.get("times_seen") or 0) + 1
            row["conv_id"] = conv_id
    _log(f"recorded {len(found)} finding(s) to {REGISTRY}")
    return len(found)


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
        _clear_inbox()
        _run_orientation(conv_id)
        _merge_findings(conv_id)
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
