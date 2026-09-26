#!/usr/bin/env python3
"""keeper_rollover.py — the 3 AM Keeper journaling rollover.

Replaces `keeper_rollover.sh`, which drove the rollover by typing slash
commands into the Keeper's tmux pane (`send-keys` — literally simulating a
keystroke stream: text, a pause, then Enter). That worked when the Keeper's
only surface was a tmux TUI. It now also lives in the observatory as a
headless `claude -p` conversation, so this script does the same nightly job
through that surface instead: no pane to type into, just the same _spawn +
_run_turn machinery routes/observatory.py uses for every turn.

The job, same as the .sh version's close/open halves:

    close  -> send /endsession in the pinned Keeper conversation. This closes
              out the day: writes the diary entry, updates THREADS.md.
    open   -> wake a FRESH pinned Keeper conversation with /journalstart.

One difference the headless surface forces: the tmux version sent /clear
before /journalstart to blank the pane for a new incarnation. Headless there
is no pane to clear and no /clear command to send — a fresh incarnation is
simply a new conversation. So "open" here doesn't clear anything; it archives
the old pinned conversation (unpinning it, off the roster, log untouched —
her record is the record) and creates a brand new one, exactly the way
spark_morning.py's kill+respawn works for the build session.

Run by cron every night (the owner wires the crontab):

    0 3 * * * EXOCORTEX_DATA_DIR=... \
        /opt/exocortex/skeleton/venv/bin/python3 \
        /opt/exocortex/skeleton/scripts/keeper_rollover.py \
        >> .../keeper_rollover.log 2>&1

Needs the venv python (imports the app's observatory route module). The
pinned Keeper conversation is found by scanning bot_chats/index for a
non-archived entry with bot=="keeper" and pinned truthy — not by an id this
script stamped itself (the pinned conversation predates this script and gets
handed off night to night), so it's picked up freshly every run.
"""
import fcntl
import queue
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store                                    # noqa: E402
from routes import observatory as rr           # noqa: E402
import json                                      # noqa: E402

ORIGIN = "keeper_rollover"
RUN_ID = "keeper_rollover"   # id in the scheduled_runs.json registry

# --- Cross-process lock: the 3 AM cron firing and a UI-triggered manual
# rollover (routes/observatory.py's POST .../keeper/rollover) must never run
# at once — both would race to close/reopen the same pinned conversation.
# One file, one fcntl.flock, taken exclusive+non-blocking so a second comer
# fails fast instead of queueing behind the first. Shared convention with
# routes/observatory.py: SAME path (store.DATA_DIR/"bot_chats"/
# "rollover.lock"), but no cross-import — that module re-implements the
# read-only probe below (rollover_running) itself rather than importing this
# one, to keep a route module out of scripts/'s sys.path games. Keep the two
# in sync if this ever changes shape. -------------------------------------

_lock_fh = None   # kept open for the whole process — see _acquire_lock()


def _lock_path():
    """Recomputed on every call, not cached at import: tests (and any code
    that monkeypatches store.DATA_DIR after this module loads) must see the
    lock land under whatever DATA_DIR is current, not whatever it was at
    import time."""
    return store.DATA_DIR / "bot_chats" / "rollover.lock"


def _acquire_lock():
    """Take the exclusive non-blocking lock a REAL run holds start to finish.
    Returns True and stashes the open file handle in the module-scope
    `_lock_fh` (closing it — even via GC — would release the flock, so it
    must outlive the function) if this process now owns it; False if another
    process already does. Never called for --dry-run, which inspects only
    and mutates nothing."""
    global _lock_fh
    path = _lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return False
    _lock_fh = fh
    return True


def rollover_running():
    """Non-destructive probe: is some process (this script, mid real run)
    currently holding the rollover lock? Opens the same file, tries the same
    non-blocking exclusive lock, and immediately releases it again on
    success — a probe must never itself hold the lock, or it would look like
    a rollover is running forever. A lock file that doesn't exist yet means
    no real rollover has run on this box at all -> not running. Not used by
    this script's own main() (which calls _acquire_lock directly and keeps
    the lock); kept here per the module's docstring contract for anything
    else in-process that wants to ask, and mirrored (not imported) by
    routes/observatory.py's own copy for the UI's status endpoint."""
    path = _lock_path()
    if not path.exists():
        return False
    try:
        fh = open(path, "a+")
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        return False
    finally:
        fh.close()

# How long close() will wait out a turn that's mid-flight when the rollover
# fires, and how often it rechecks. 30 * 60s = 30 minutes — long enough to
# outlast an ordinary reply, short enough that a genuinely stuck turn still
# fails the run instead of hanging the cron job till morning.
_WAIT_ATTEMPTS = 30
_WAIT_SECONDS = 60


def _registry_default():
    return {
        "id": RUN_ID,
        "name": "Keeper nightly rollover",
        "description": "Close the journaling day (/endsession) and wake a "
                       "fresh pinned Keeper session (/journalstart).",
        "schedule": "0 3 * * *",
        "schedule_human": "Every night at 3:00 AM",
        "enabled": True,
        "last_run": None,
        "last_status": None,
        "last_conv_id": None,
        "last_cost_usd": None,
    }


def _is_enabled():
    """The UI's pause switch: scripts honor `enabled` so a run can be turned
    off without touching cron. Unregistered (first run ever) = enabled by
    default."""
    for r in store.read("scheduled_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("id") == RUN_ID:
            return r.get("enabled", True)
    return True


def _record_status(status, conv_id=None, cost=None):
    """Write this run's outcome back to the registry so the Automations page
    can show last-run time/status and a link to the session it produced.
    Upserts the entry, so the registry is self-seeding on first run."""
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

# Full tool set for the turn — /endsession isn't a read-only reflection, it
# writes: stream.py render/validate runs through Bash, and the diary entry
# itself is a Write/Edit. (On this box --allowedTools doesn't restrict in -p,
# but naming them keeps the turn correct regardless of that quirk.) Same list
# as spark_morning's SPARK_TOOLS, named for this script's bot.
KEEPER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash",
                "WebFetch", "WebSearch", "TodoWrite"]


def _log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def _find_pinned(index):
    """The pinned Keeper conversation: the one true diary door. Scans fresh
    every run rather than trusting a remembered id, because ownership of
    "the" pinned conversation hands off from last night's _open() to tonight's
    _close() without this script needing to remember anything in between.
    Returns (conv_id, entry) or (None, None). More than one candidate should
    never happen, but if it does (hand-pinned duplicate, a botched migration)
    take the most recently active one and say so loudly rather than silently
    picking an arbitrary one."""
    candidates = [(cid, meta) for cid, meta in index.items()
                  if isinstance(meta, dict) and meta.get("bot") == "keeper"
                  and meta.get("pinned") and not meta.get("archived")]
    if not candidates:
        return None, None
    if len(candidates) > 1:
        _log(f"WARNING: {len(candidates)} pinned Keeper conversations found "
             f"({[c[0] for c in candidates]}) — using the most recently active")
    candidates.sort(key=lambda c: c[1].get("last_at", ""), reverse=True)
    return candidates[0]


def _tail_is_error(log_path):
    """Did the turn's jsonl end on an error event? Read backward past any
    trailing blank lines to the last real event — that's the signal that
    /endsession itself failed (claude exited non-zero, or the model's last
    message never landed) rather than just finishing normally."""
    try:
        lines = log_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            return False
        return isinstance(event, dict) and event.get("type") == "error"
    return False


def _run_turn_sync(bot_id_dict, text, conv_id, resume_sid, cwd):
    """One synchronous turn against an existing conversation's jsonl, the
    same shape spark_morning's _run_orientation uses: append the user event
    first (capture-first, same guarantee bot_send gives every turn), then
    spawn and drain synchronously — a cron one-shot has no HTTP connection to
    detach from and nothing to stay alive for."""
    log_path = rr._chats_dir() / f"{conv_id}.jsonl"
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(json.dumps({"type": "user", "text": text,
                              "ts": rr._now(), "journaled": False}) + "\n")
    proc, stderr_f = rr._spawn(bot_id_dict, text, resume_sid, cwd_override=cwd)
    rr._run_turn(proc, stderr_f, conv_id, log_path, resume_sid, queue.Queue())
    return log_path


def _close(dry_run=False, set_running=None):
    """Close half: /endsession in the pinned conversation. Returns the pinned
    conv_id (whether or not a turn actually ran — no pinned conversation at
    all is the only case that returns None), or raises if the day can't be
    safely closed. `set_running` is a list this appends to the moment it sets
    running=True itself, so main()'s error handler knows exactly which flags
    it's responsible for clearing and never touches one it didn't set."""
    index = store.read("bot_chats/index", {})
    conv_id, entry = _find_pinned(index)
    if conv_id is None:
        _log("close: no pinned Keeper conversation found — nothing to close")
        return None

    if dry_run:
        running = rr._effective_running(conv_id, entry)
        _log(f"[dry-run] close: would target pinned conv {conv_id} "
             f"(running={running}); would send /endsession" +
             (" after waiting out the in-progress turn" if running else ""))
        return conv_id

    # The keeper might be mid-turn when 3 AM lands (a late-night entry still
    # being written). Wait it out rather than stomping on it — but not
    # forever: a turn still running half an hour later is treated as stuck,
    # and the whole roll aborts rather than closing over a live session.
    attempts = 0
    while rr._effective_running(conv_id, entry):
        attempts += 1
        if attempts > _WAIT_ATTEMPTS:
            raise RuntimeError(
                f"pinned conv {conv_id} still running after "
                f"{_WAIT_ATTEMPTS} minutes — refusing to close (the day "
                f"stays open; tomorrow night retargets this conversation)")
        _log(f"pinned conv {conv_id} is mid-turn — waiting {_WAIT_SECONDS}s "
             f"(attempt {attempts}/{_WAIT_ATTEMPTS})")
        time.sleep(_WAIT_SECONDS)
        index = store.read("bot_chats/index", {})
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            raise RuntimeError(
                f"pinned conv {conv_id} vanished from the index while "
                f"waiting for its turn to finish")

    if entry.get("claude_session_id") is None:
        _log(f"close: pinned conv {conv_id} has no claude session yet — "
             f"nothing to close")
        return conv_id

    cwd = entry.get("cwd")
    resume_sid = entry.get("claude_session_id")
    with store.mutate("bot_chats/index", {}) as idx:
        e = idx.get(conv_id)
        if isinstance(e, dict):
            e["running"] = True
            e["last_at"] = rr._now()
    if set_running is not None:
        set_running.append(conv_id)

    bot = dict(rr._bot("keeper") or {}, allowed_tools=KEEPER_TOOLS)
    log_path = _run_turn_sync(bot, "/endsession", conv_id, resume_sid, cwd)

    if _tail_is_error(log_path):
        raise RuntimeError(
            f"/endsession turn in {conv_id} ended in an error — see {log_path}")
    _log(f"closed pinned conv {conv_id}")
    return conv_id


def _open(dry_run=False, set_running=None):
    """Open half: archive+unpin every open pinned Keeper conversation (kill),
    then create a fresh pinned one and send /journalstart (respawn) — the
    same kill+respawn shape as spark_morning's morning ritual. Goes through
    the index directly rather than the close endpoint because
    bot_conv_close() refuses to archive a pinned conversation by design (the
    UI's normal close button must never be able to orphan the diary door);
    the nightly rollover is the one deliberate exception to that rule.
    Returns the new conv_id."""
    if dry_run:
        index = store.read("bot_chats/index", {})
        pinned = [cid for cid, meta in index.items()
                  if isinstance(meta, dict) and meta.get("bot") == "keeper"
                  and meta.get("pinned") and not meta.get("archived")]
        _log(f"[dry-run] open: would archive+unpin {len(pinned)} pinned "
             f"Keeper conversation(s) {pinned}, create a new pinned "
             f"conversation, and send /journalstart")
        return None

    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        killed = 0
        for meta in index.values():
            if isinstance(meta, dict) and meta.get("bot") == "keeper" \
                    and meta.get("pinned") and not meta.get("archived"):
                meta["archived"] = rr._now()
                meta["pinned"] = False
                killed += 1
        conv_id = rr._new_conv_id(index)
        # .get, not [..]: a bots.json keeper entry without a cwd falls back to
        # the vault default rather than KeyError-ing the whole rollover.
        new_cwd = rr._bot("keeper").get("cwd") or rr._default_bots()[0]["cwd"]
        index[conv_id] = {
            "bot": "keeper",
            "origin": ORIGIN,
            "started": rr._now(),
            "last_at": rr._now(),
            "claude_session_id": None,
            "title": f"Keeper — {datetime.now():%a %b %-d}",
            "cost_usd": 0.0,
            "journal": True,                     # the diary door — journal:true stays on
            "pinned": True,
            "cwd": new_cwd,
            "running": True,
        }
        # Attach the boot package: the new Keeper wakes with its rules, recent
        # journal and Coming up already in its system prompt, instead of
        # hunting for the files itself. Stored on the entry so every later
        # turn today carries the same snapshot (routes/observatory.py
        # _conv_config reads it back).
        boot_path = rr.attach_boot_package(conv_id)
        if boot_path:
            index[conv_id]["system_prompt_file"] = boot_path
    if set_running is not None:
        set_running.append(conv_id)
    if killed:
        _log(f"archived+unpinned {killed} prior pinned Keeper session(s)")
    _log(f"boot package: {boot_path or 'NOT built — keeper will read by hand'}")

    bot = dict(rr._bot("keeper") or {}, allowed_tools=KEEPER_TOOLS)
    if boot_path:
        bot["system_prompt_file"] = boot_path
    _run_turn_sync(bot, "/journalstart", conv_id, None, new_cwd)
    _log(f"opened new pinned conv {conv_id}")
    return conv_id


def main():
    if not store.DATA_DIR.exists():
        _log(f"ERROR: DATA_DIR {store.DATA_DIR} missing — is EXOCORTEX_DATA_DIR set?")
        return 1

    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    modes = [a for a in args if a != "--dry-run"]
    if len(modes) > 1 or (modes and modes[0] not in ("roll", "close", "open")):
        print(f"usage: {sys.argv[0]} [roll|close|open] [--dry-run]", file=sys.stderr)
        return 2
    mode = modes[0] if modes else "roll"

    if dry_run:
        # A pure inspection mode: no registry gate, no mutation, no spawn —
        # just report what a real run would find and do.
        _log(f"[dry-run] mode={mode} — no mutations, no spawns")
        if mode in ("roll", "close"):
            _close(dry_run=True)
        if mode in ("roll", "open"):
            _open(dry_run=True)
        return 0

    # Real run: take the cross-process lock before anything else touches the
    # registry or the index. If another process (the other trigger — cron vs
    # a UI-fired manual run, whichever lost the race) already holds it, this
    # run isn't a failure, it's redundant: back off quietly and let the owner
    # of the lock record the outcome. exit 0, registry untouched.
    if not _acquire_lock():
        _log("another rollover is already running — skipping")
        return 0

    if not _is_enabled():
        _log("disabled in scheduled_runs.json — skipping this run")
        return 0

    set_running = []   # conv ids THIS run set running=True on — see _close/_open
    try:
        cost_before = {}
        closed_id = None
        opened_id = None

        if mode in ("roll", "close"):
            pinned_id, pinned_entry = _find_pinned(store.read("bot_chats/index", {}))
            if pinned_id:
                cost_before[pinned_id] = float(pinned_entry.get("cost_usd") or 0.0)
            closed_id = _close(set_running=set_running)

        if mode in ("roll", "open"):
            opened_id = _open(set_running=set_running)

        # Cost delta: read the touched entries' cost_usd now and diff against
        # what was there before this run touched them (a fresh conv started
        # at 0.0, so its "before" is implicitly 0.0 via the .get default).
        touched = {cid for cid in (closed_id, opened_id) if cid}
        cost_delta = 0.0
        if touched:
            index_after = store.read("bot_chats/index", {})
            for cid in touched:
                after = float(index_after.get(cid, {}).get("cost_usd") or 0.0)
                cost_delta += after - cost_before.get(cid, 0.0)
        cost_delta = round(cost_delta, 6)

        final_conv = opened_id or closed_id
        _log(f"done: mode={mode} closed={closed_id} opened={opened_id} "
             f"cost=${cost_delta}")
        _record_status("ok", conv_id=final_conv, cost=cost_delta)
        return 0
    except Exception as e:
        _log(f"ERROR: {type(e).__name__}: {e}")
        _record_status("error")
        # Best-effort: clear the running flag on any conv THIS run set it on,
        # so a crashed turn doesn't read as forever-busy in the roster. Never
        # touches a conv we didn't set running on ourselves — a genuinely
        # stuck pre-existing turn (the wait-timeout case) must be left alone.
        try:
            with store.mutate("bot_chats/index", {}) as index:
                for cid in set_running:
                    entry = index.get(cid)
                    if isinstance(entry, dict) and entry.get("running"):
                        entry["running"] = False
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
