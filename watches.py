"""A helper's watches — how a helper keeps a promise to watch something
between turns.

**What this is, in plain English.** A helper's chat (helper_chat.py) only
runs when something starts a turn: her message, an agent's mail, a system
notice. So when the room helper told her "I'll tell you when that session
ships", nothing ever woke it to do so. A WATCH is that promise written down:

  - the helper sets one from its chat — `scripts/helper_watch.py add <session>
    --on done,committed --note "tell her when the Linear board ships"` — and
    it's stored in `helper_watches` (exo.db);
  - once a minute (scripts/coming_up_dispatcher.py → tick) every open watch is
    checked against what the watched session has done since the watch was set;
  - when one fires, it's marked fired first, then the helper's chat is woken
    with ONE System message — the watch, the session, what happened — through
    the same follow-up queue a finished detached job or a sudo answer uses
    (routes/observatory.py queue_followup). Several watches of one helper
    firing in the same minute go out as one message. Each watch fires once.

What a watch can wait for (`--on`, any of them):

  - done       — the session marks itself done (session_done.py), or is closed;
  - asked      — it files questions for her (request_input.py) or a sudo card
                 (sudo_request.py);
  - committed  — a `git commit` it runs succeeds;
  - error      — a turn of it fails or its turn process dies;
  - stalled    — it writes nothing for config.HELPER_WATCH_STALLED_MINUTES,
                 while nothing is waiting on her and no detached job of its
                 is running.

Only what happens AFTER the watch is set counts: transcript lines are read
from where the transcript ended at that moment (`since_offset`), and stamps
are compared with `created_at`. A watch follows its session into a
continuation (continuation.successor). A watch that hasn't fired after
config.HELPER_WATCH_EXPIRE_DAYS is retired, and the helper is told so. A
watch whose helper has been closed is dropped quietly: there's no one left
to keep the promise.

Any Observatory session can set watches — the door checks only that the
watcher is a session — but only the helpers are told about them
(helper_chat.CHAT_PROMPT), and their seed lists the ones they have open.

Touches: sqlstore.py (the `helper_watches` table, rung 40), the session index
and transcripts under data/bot_chats/, sudo_requests.py (its requests file),
continuation.py (successor), routes/observatory.py (queue_followup,
_effective_running, _unfinished_jobs), config.py (HELPER_WATCH_*),
scripts/helper_watch.py (the helpers' door), helper_chat.py (the seed's list),
tools/helper_gate.py (lets the door through), scripts/coming_up_dispatcher.py
(the minute tick), tests/test_helper_watch.py. Design: docs/swarms.md.

Prompt that produced this: "i need something that alerts you to watch things
between turns." — the owner to the room helper, whose chat summary was full
of promises to tell her when a session shipped that nothing woke it to keep.
"""
import json
import re
from datetime import datetime, timedelta

import config
import sqlstore
import store

KINDS = ("done", "asked", "committed", "stalled", "error")
# What `add` watches for when the helper names nothing: the moments she'd want
# to hear about. `stalled` is left to be asked for — most sessions go quiet
# between her messages, and that isn't news.
DEFAULT_KINDS = ("done", "asked", "committed", "error")
# The `source` stamped on the System bubble, so the chat labels it as a watch.
SOURCE = "helper-watch"

_NOTE_MAX = 500
_EVENT_CHARS = 200

# A commit: a Bash call whose command runs `git commit` (with or without -C).
_GIT_COMMIT = re.compile(r"\bgit (?:-C \S+ )*commit\b")
# The commit's hash and subject in its output, when the output names them:
# "[main a15f1a7] subject" from a plain commit, or "a15f1a7 subject" from the
# `git log --oneline -1` most sessions run after a quiet `commit -q`.
_COMMIT_LINE = re.compile(r"\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,40})\] ([^\n]+)")
_ONELINE = re.compile(r"^([0-9a-f]{7,40}) ([^\n]+)$", re.M)


class WatchError(ValueError):
    """A watch that can't be set or dropped as asked — the reason says why."""


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _trim(text, cap=_EVENT_CHARS):
    text = " ".join(str(text or "").split())
    return text if len(text) <= cap else text[:cap - 1] + "…"


def _transcript(conv):
    return store.DATA_DIR / "bot_chats" / f"{conv}.jsonl"


def _index():
    index = store.read("bot_chats/index", {})
    return index if isinstance(index, dict) else {}


def _row(row):
    keys = ("id", "owner_conv", "conv", "kinds", "note", "created_at", "since_offset",
            "status", "closed_at", "event")
    watch = dict(zip(keys, row))
    watch["kinds"] = [k for k in (watch["kinds"] or "").split(",") if k]
    return watch


_COLUMNS = ("id, owner_conv, conv, kinds, note, created_at, since_offset, status,"
            " closed_at, event")


# --- Setting, listing and dropping watches (the helpers' door) -----------------

def parse_kinds(values):
    """The kinds named on the command line — comma lists, repeatable — checked
    against KINDS. Nothing named means DEFAULT_KINDS."""
    kinds = []
    for value in values or []:
        for kind in str(value).split(","):
            kind = kind.strip().lower()
            if not kind:
                continue
            if kind not in KINDS:
                raise WatchError(f"unknown kind {kind!r} — one of: {', '.join(KINDS)}")
            if kind not in kinds:
                kinds.append(kind)
    return kinds or list(DEFAULT_KINDS)


def add(owner_conv, conv, kinds, note, now=None):
    """Set a watch: `owner_conv` is woken when `conv` does one of `kinds`.
    Returns the watch. Setting the same watch again (same session, same
    kinds, still open) rewrites its note instead of adding a second."""
    note = (note or "").strip()[:_NOTE_MAX]
    if not note:
        raise WatchError("say what you promised her (--note) — it's what you're woken with")
    kinds = parse_kinds(kinds)
    index = _index()
    if not isinstance(index.get(owner_conv), dict):
        raise WatchError(f"no such session (the watcher): {owner_conv}")
    import continuation
    entry = index.get(conv)
    if not isinstance(entry, dict):
        raise WatchError(f"no such session: {conv}")
    # A session that handed off is watched where its work goes on now.
    conv = continuation.successor(conv, index)
    entry = index.get(conv) or entry
    if conv == owner_conv:
        raise WatchError("a session can't watch itself")
    if entry.get("archived"):
        raise WatchError(f"{conv} is already closed — nothing left to watch")
    # Only what comes after now counts: remember where its transcript ends.
    try:
        offset = _transcript(conv).stat().st_size
    except OSError:
        offset = 0
    now = now or _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        same = conn.execute(
            "SELECT id FROM helper_watches WHERE owner_conv = ? AND conv = ? AND kinds = ?"
            " AND status = 'watching'", (owner_conv, conv, ",".join(kinds))).fetchone()
        if same:
            conn.execute("UPDATE helper_watches SET note = ? WHERE id = ?", (note, same[0]))
            watch_id = same[0]
        else:
            watch_id = conn.execute(
                "INSERT INTO helper_watches (owner_conv, conv, kinds, note, created_at,"
                " since_offset) VALUES (?, ?, ?, ?, ?, ?)",
                (owner_conv, conv, ",".join(kinds), note, now, offset)).lastrowid
        conn.execute("COMMIT")
    finally:
        conn.close()
    return dict(get(watch_id), updated=bool(same))


def get(watch_id):
    conn = sqlstore.open_db()
    try:
        row = conn.execute(f"SELECT {_COLUMNS} FROM helper_watches WHERE id = ?",
                           (watch_id,)).fetchone()
    finally:
        conn.close()
    return _row(row) if row else None


def listing(owner_conv=None, open_only=True, limit=50):
    """Watches newest first — one helper's, or everyone's with owner_conv None."""
    where, args = [], []
    if owner_conv:
        where.append("owner_conv = ?")
        args.append(owner_conv)
    if open_only:
        where.append("status = 'watching'")
    sql = f"SELECT {_COLUMNS} FROM helper_watches"
    if where:
        sql += " WHERE " + " AND ".join(where)
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(sql + " ORDER BY id DESC LIMIT ?", (*args, limit)).fetchall()
    finally:
        conn.close()
    return [_row(r) for r in rows]


def drop(watch_id, owner_conv=None):
    """Stop watching. A helper drops only its own watches; with no owner (her,
    at a terminal) any open one can be dropped."""
    watch = get(watch_id)
    if watch is None:
        raise WatchError(f"no watch #{watch_id}")
    if owner_conv and watch["owner_conv"] != owner_conv:
        raise WatchError(f"watch #{watch_id} is {watch['owner_conv']}'s, not yours")
    if watch["status"] != "watching":
        raise WatchError(f"watch #{watch_id} is already {watch['status']}")
    _close(watch_id, "dropped", "dropped by hand")
    return get(watch_id)


def _close(watch_id, status, event):
    """Mark a watch fired, dropped or expired — only if it's still open.
    True when this call is the one that closed it, so two ticks racing can
    never both wake the helper for the same watch."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        changed = conn.execute(
            "UPDATE helper_watches SET status = ?, closed_at = ?, event = ?"
            " WHERE id = ? AND status = 'watching'", (status, _now(), event, watch_id)).rowcount
        conn.execute("COMMIT")
    finally:
        conn.close()
    return changed == 1


def _follow(watch, conv):
    """The watched session handed off: watch its continuation from the start."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("UPDATE helper_watches SET conv = ?, since_offset = 0 WHERE id = ?",
                     (conv, watch["id"]))
        conn.execute("COMMIT")
    finally:
        conn.close()


# --- What a watched session did since the watch was set ------------------------

def _new_lines(conv, offset):
    """The transcript lines written after `offset`, parsed. A transcript
    shorter than the offset (rewritten) is read from the start."""
    path = _transcript(conv)
    try:
        with open(path, "rb") as f:
            size = f.seek(0, 2)
            f.seek(offset if offset <= size else 0)
            raw = f.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    lines = []
    for text in raw.splitlines():
        try:
            line = json.loads(text)
        except ValueError:
            continue    # a line still being written, read whole next minute
        if isinstance(line, dict):
            lines.append(line)
    return lines


def _result_text(block):
    content = block.get("content")
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict))
    return str(content or "")


def _transcript_events(conv, offset, kinds):
    """The events in one session's new transcript lines: questions filed,
    commits made, turns that failed."""
    events = []
    commits = set()     # tool_use ids of Bash calls that ran `git commit`
    for line in _new_lines(conv, offset):
        kind = line.get("type")
        if kind == "questions" and "asked" in kinds:
            asked = "; ".join(_trim(q, 150) for q in line.get("questions") or [])
            events.append(f"asked her: {asked}")
        elif kind == "error" and "error" in kinds:
            events.append(f"hit an error: {_trim(line.get('error'))}")
        elif kind in ("assistant", "user") and "committed" in kinds \
                and not line.get("parent_tool_use_id"):
            for block in (line.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use" and block.get("name") == "Bash" \
                        and _GIT_COMMIT.search(str((block.get("input") or {}).get("command"))):
                    commits.add(block.get("id"))
                elif block.get("type") == "tool_result" and block.get("tool_use_id") in commits \
                        and not block.get("is_error"):
                    # A commit that worked: name it by its hash when the output does.
                    output = _result_text(block)
                    found = _COMMIT_LINE.search(output) or _ONELINE.search(output)
                    events.append(f"committed {found.group(1)[:7]} {_trim(found.group(2), 120)}"
                                  if found else "committed (a `git commit` succeeded)")
    return events


def _sudo_events(convs, since):
    """Sudo cards any of these sessions filed after `since`."""
    data = store.read("sudo_requests", {"requests": []}) or {}
    events = []
    for req in data.get("requests") or []:
        for asker in req.get("askers") or []:
            if asker.get("conv") in convs and str(asker.get("at") or "") >= since:
                label = (config.SUDO_ACTIONS.get(req.get("action")) or {}).get("label") \
                    or req.get("action")
                reason = f" — {_trim(asker['reason'], 150)}" if asker.get("reason") else ""
                events.append(f"asked her for sudo: {label}{reason}")
    return events


def _state_events(watch, conv, entry, now):
    """Events read from the session's entry as it is now: done or closed, or
    gone silent."""
    from routes import observatory
    kinds, since = watch["kinds"], watch["created_at"]
    if "done" in kinds:
        if str(entry.get("done_at") or "") >= since:
            note = f": {_trim(entry['done_note'])}" if entry.get("done_note") else ""
            return [f"marked itself done{note}"]
        # Closed without a done mark. A handoff isn't a close: the watch
        # follows the work (tick), so an archived session with a successor
        # never gets here.
        if entry.get("archived") and not entry.get("continued_by"):
            return ["was closed"]
    if "stalled" in kinds and not entry.get("archived") and not entry.get("done_at") \
            and not entry.get("awaiting_input") and not entry.get("saved_at"):
        # Silent: nothing written since the later of the watch and its last line.
        stamps = [datetime.fromisoformat(since)]
        try:
            stamps.append(datetime.fromisoformat(str(entry.get("last_at"))))
        except ValueError:
            pass
        try:
            stamps.append(datetime.fromtimestamp(_transcript(conv).stat().st_mtime))
        except OSError:
            pass
        quiet = now - max(stamps)
        limit = timedelta(minutes=config.HELPER_WATCH_STALLED_MINUTES)
        if quiet >= limit and not observatory._unfinished_jobs(conv):
            minutes = int(quiet.total_seconds() // 60)
            where = ("mid-turn — it may be stuck"
                     if observatory._effective_running(conv, entry)
                     else "idle, not done, and not waiting on her")
            return [f"has written nothing for {minutes} minutes ({where})"]
    return []


def check(watch, index, now=None):
    """What has happened for one watch, as a list of plain lines (empty:
    nothing yet). Follows a handoff to the continuation, checking the old
    session's last lines on the way."""
    import continuation
    now = now or datetime.now()
    chain, conv, offset = [], watch["conv"], watch["since_offset"]
    # The line of work from the watched session to whoever does it now.
    seen = set()
    while conv not in seen:
        seen.add(conv)
        chain.append((conv, offset))
        nxt = (index.get(conv) or {}).get("continued_by")
        if not nxt or nxt not in index:
            break
        conv, offset = nxt, 0
    events = []
    for conv, offset in chain:
        events += _transcript_events(conv, offset, watch["kinds"])
    if "asked" in watch["kinds"]:
        events += _sudo_events({c for c, _ in chain}, watch["created_at"])
    now_conv = chain[-1][0]
    entry = index.get(now_conv)
    if not isinstance(entry, dict):
        return events + ["is gone from the session index"]
    events += _state_events(watch, now_conv, entry, now)
    # Move the watch on only once the old session is archived: it finishes
    # the turn it handed off in, and those last lines still count.
    if now_conv != watch["conv"] and not events:
        if (index.get(watch["conv"]) or {}).get("archived"):
            _follow(watch, continuation.successor(now_conv, index))
    elif now_conv != watch["conv"]:
        events.append(f"(its work goes on in `{now_conv}` — it handed off)")
    return events


# --- The minute tick ------------------------------------------------------------

def wake_message(fired, index):
    """What the helper is told, and how its chat shows it. `fired` is a list
    of (watch, events, status). Returns (text, system) — the follow-up
    queue's pair, as in scripts/run_detached.py wake_message."""
    parts, short = [], []
    for watch, events, status in fired:
        title = (index.get(watch["conv"]) or {}).get("title") or watch["conv"]
        heading = (f"Watch #{watch['id']} on `{watch['conv']}` ({title}),"
                   f" watching for {', '.join(watch['kinds'])}")
        parts.append("\n".join([heading, f"You promised: {watch['note']}",
                                "What happened:", *[f"- {e}" for e in events]]))
        short.append(f"#{watch['id']} {_trim(title, 50)}: {events[0]}"
                     if status == "fired" else f"#{watch['id']} {_trim(title, 50)}: expired")
    text = ("[Watch — sent by the app, not by the owner. You set these with"
            " scripts/helper_watch.py to keep a promise to her, and they fired.]\n\n"
            + "\n\n".join(parts)
            + "\n\nKeep the promise now: tell her here, in a few plain lines, what happened"
              " and what it means for her — check the facts first if you need to"
              " (`peers.py show <id>`, git). Each watch fires once; if you should keep"
              " watching, set a new one.")
    display = _trim("Watch fired — " + "; ".join(short), 300)
    system = {"display": display, "journal": display, "source": SOURCE,
              "item_id": ",".join(str(w["id"]) for w, _, _ in fired)}
    return text, system


def tick(now=None):
    """Check every open watch; wake each helper whose watches fired, once,
    with all of them. Returns how many helpers were woken. Run once a minute
    by scripts/coming_up_dispatcher.py."""
    from routes import observatory
    now = now or datetime.now()
    open_watches = listing(open_only=True, limit=1000)
    if not open_watches:
        return 0
    index = _index()
    expire = timedelta(days=config.HELPER_WATCH_EXPIRE_DAYS)
    by_owner = {}
    for watch in open_watches:
        owner = index.get(watch["owner_conv"])
        # A closed helper can't keep a promise: drop its watches quietly.
        if not isinstance(owner, dict) or owner.get("archived"):
            _close(watch["id"], "dropped", "the watcher was closed")
            continue
        try:
            events = check(watch, index, now)
        except Exception as e:
            print(f"watch #{watch['id']} check failed: {e}", flush=True)
            continue
        status = "fired" if events else None
        if not events and now - datetime.fromisoformat(watch["created_at"]) >= expire:
            status = "expired"
            events = [f"nothing happened in {config.HELPER_WATCH_EXPIRE_DAYS:g} days,"
                      " so the app stopped watching"]
        if status:
            by_owner.setdefault(watch["owner_conv"], []).append((watch, events, status))
    woken = 0
    for owner_conv, items in by_owner.items():
        # Mark each one closed BEFORE waking: a crash between the two costs
        # one message, never the same message every minute forever.
        won = [(w, events, status) for w, events, status in items
               if _close(w["id"], status, "\n".join(events))]
        if not won:
            continue
        text, system = wake_message(won, index)
        observatory.queue_followup(owner_conv, text, system=system)
        woken += 1
    return woken


# --- The helper's seed -----------------------------------------------------------

def seed_section(owner_conv):
    """The watches a helper has open, as a section of its chat's seed."""
    index = _index()
    lines = ["# Your open watches", "",
             "Set with `scripts/helper_watch.py`; the app wakes you once when one fires."]
    watches = listing(owner_conv, open_only=True)
    for watch in watches:
        title = (index.get(watch["conv"]) or {}).get("title") or watch["conv"]
        lines.append(f"- #{watch['id']} `{watch['conv']}` ({title}) — on"
                     f" {', '.join(watch['kinds'])}, since {watch['created_at']}:"
                     f" {watch['note']}")
    if not watches:
        lines.append("(none)")
    return "\n".join(lines) + "\n"
