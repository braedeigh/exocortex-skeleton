"""File alerts — the app notices when two open sessions are in the same file,
and writes it down for the room helper.

**What this is, in plain English.** Several agent sessions work in one
checkout at once. Once a minute this file looks for two kinds of overlap
between the open sessions of a room:

  - SAME FILE: two open lines of work both changed the file within
    config.FILE_ALERT_HOURS.
  - STALE COPY: one changed a file that another read within the window and
    has not read again since. The reader is working from a version that no
    longer exists.

Sharing a folder is not an overlap: unrelated work sits side by side in one.

Each overlap is written down ONCE per pair of sessions per file, in the
`file_alerts` table. That is all that happens by default: the sessions
themselves are told nothing. The room helper reads the list (it is the last
part of its files section, edited_files.section, and the table is open to its
SQL) and decides whether to message anyone or put the two in a swarm.

Telling the sessions directly is still here, behind a switch that is OFF
(config.FILE_ALERTS). The owner tried it and chose the helper-only way: in
its first ten minutes it sent thirteen notices, none of which needed acting
on. With the switch on, a row is marked `told` and:
  - each session gets one notice — which file, which other session, what
    that session is doing and what to do about it (config.FILE_ALERT_*_TEXT).
    Both sessions for a same-file overlap; only the reader for a stale copy.
    It goes into the agents' mailbox as kind `S` (peermail.send_notice): a
    session mid-turn reads it between its steps, an idle one isn't woken.
  - the session about to make an edit is warned on the spot by the pre-edit
    hook (tools/file_alert_hook.py → before_edit). The edit is never blocked.

Who is never part of an overlap: a session and its own continuation (they're
one line of work), a helper, a session that is done, closed or handed on, and
any pair already written down for that file.

What it can miss is what edited_files.py can miss: an edit or a read made
through Bash is only seen when the command spells the file's name, and a
Bash edit only for a file git shows as changed.

Touches: edited_files.py (open_lines, edits, reads — the detecting — and its
section, which shows the list to the room helper), sqlstore.py (the
`file_alerts` table, rungs 42–43), swarms.py (line_of_work), lanes.py (which
room), config.py (FILE_OVERLAPS, FILE_ALERT*), scripts/coming_up_dispatcher.py
(the minute tick), tests/test_file_alerts.py. Only with the switch on:
peermail.py (send_notice), routes/observatory.py (_session_settings wires the
hook; drain_inbox keeps a notice from waking anyone),
tools/file_alert_hook.py. Design: docs/swarms.md.

Prompts that produced this: "So maybe have some kind of code that identifies
when 2 agents are working nearby or on the same files and alert them when
they are?" — then, after seeing it run: "That should only be read by the
helper."
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

import config
import edited_files
import lanes
import peermail
import sqlstore
import store
import swarms

SAME, STALE = "same-file", "stale-copy"
# How much of the other session's summary line an alert carries.
_DOING_CHARS = 240
# How many overlaps the room helper's section lists.
_RECORDED_SHOWN = 15


def _now_stamp(now):
    return now.isoformat(timespec="seconds")


def _index(index=None):
    index = store.read("bot_chats/index", {}) if index is None else index
    return index if isinstance(index, dict) else {}


# --- Finding the overlaps -----------------------------------------------------------

def overlaps(room, index=None, repo=None, now=None):
    """Every overlap between the open lines of work in this room right now,
    alerted before or not. Each is a dict: `kind`, `path`, and two sessions
    with a time each — for same-file, `a` and `b` are the two that changed it
    (`a_at`, `b_at`: when each last did); for stale-copy, `a` changed it at
    `a_at` and `b` last read it at `b_at`, before that."""
    index = _index(index)
    repo = Path(repo or edited_files._REPO)
    now = now or datetime.now()
    since = _now_stamp(now - timedelta(hours=config.FILE_ALERT_HOURS))
    lines = edited_files.open_lines(room, index)
    if len(lines) < 2:
        return []
    uncommitted, committed = edited_files.changed_in_git(repo, since)
    candidates = uncommitted | committed
    changed = edited_files.edits(lines, since, repo, candidates)
    by_file = {}
    for face, touched in changed.items():
        for path, at in touched.items():
            by_file.setdefault(path, {})[face] = at
    found = []
    # Same file: every pair of sessions that both changed it.
    for path, who in by_file.items():
        faces = sorted(who)
        found += [{"kind": SAME, "path": path, "a": a, "a_at": who[a], "b": b, "b_at": who[b]}
                  for i, a in enumerate(faces) for b in faces[i + 1:]]
    # Stale copy: a session that read a changed file before the change and
    # hasn't read it since — and hasn't changed it itself, which is the case above.
    read = edited_files.reads(lines, since, repo, candidates, wanted=set(by_file))
    for path, who in by_file.items():
        for reader, seen in read.items():
            if reader in who or path not in seen:
                continue
            found += [{"kind": STALE, "path": path, "a": editor, "a_at": at,
                       "b": reader, "b_at": seen[path]}
                      for editor, at in who.items() if seen[path] < at]
    return found


# --- Writing each pair down once ----------------------------------------------------

def _line_key(conv, index):
    """The name a line of work keeps for life: its first session. A session
    and its continuations share it, so a pair alerted once stays alerted
    after either hands off."""
    return min(swarms.line_of_work(conv, index))


def claim(overlap, index, source="tick", now=None, told=False):
    """Write this pair and file down. True only for the one caller whose row
    went in — the unique key refuses every later one, which is what makes an
    overlap count once however many checks see it. `told`: the sessions are
    about to be told too (config.FILE_ALERTS)."""
    low, high = sorted((_line_key(overlap["a"], index), _line_key(overlap["b"], index)))
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        won = conn.execute(
            "INSERT OR IGNORE INTO file_alerts (at, kind, path, line_a, line_b, conv_a,"
            " conv_b, source, told) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (_now_stamp(now or datetime.now()), overlap["kind"], overlap["path"], low, high,
             overlap["a"], overlap["b"], source, int(told))).rowcount
        conn.execute("COMMIT")
    finally:
        conn.close()
    return won == 1


def _doing(conv, index):
    """One line on what a session is doing: its helper-written summary if it
    has one (its swarm helper's, else the room helper's), else what it was
    last asked."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute(
            "SELECT summary FROM swarm_members WHERE conv = ? AND summary IS NOT NULL"
            " ORDER BY summary_at DESC LIMIT 1", (conv,)).fetchone() or conn.execute(
            "SELECT summary FROM session_summaries WHERE conv = ?", (conv,)).fetchone()
    finally:
        conn.close()
    text = (row[0] if row else "") or (index.get(conv) or {}).get("last_prompt") or ""
    text = " ".join(str(text).split())
    if not text:
        return "(no summary of it yet)"
    return text if len(text) <= _DOING_CHARS else text[:_DOING_CHARS - 1] + "…"


class _Blank(dict):
    """Fill a text's missing names with nothing, so a replacement text set in
    the environment can't break an alert by using a name that isn't there."""

    def __missing__(self, key):
        return ""


def alert_text(template, overlap, other, index, repo, now, when=None):
    """One alert, from its config text. `other` is the session the reader of
    this text is being told about."""
    today = now.date().isoformat()
    return template.format_map(_Blank(
        file=edited_files._shown(overlap["path"], repo), conv=other,
        title=(index.get(other) or {}).get("title") or other,
        doing=_doing(other, index), hours=f"{config.FILE_ALERT_HOURS:g}",
        when=when or f"at {edited_files._when(overlap['a_at'], today)}",
        read_at=f"at {edited_files._when(overlap['b_at'], today)}" if overlap.get("b_at") else ""))


def texts(overlap, index, repo, now):
    """Who is told what: {session: text}. Both sessions for a same-file
    overlap; only the reader for a stale copy."""
    today = now.date().isoformat()
    a, b = overlap["a"], overlap["b"]
    if overlap["kind"] == STALE:
        return {b: alert_text(config.FILE_ALERT_STALE_TEXT, overlap, a, index, repo, now)}
    # Same file: each is told when the OTHER last changed it.
    return {a: alert_text(config.FILE_ALERT_SAME_TEXT, overlap, b, index, repo, now,
                          when=f"at {edited_files._when(overlap['b_at'], today)}"),
            b: alert_text(config.FILE_ALERT_SAME_TEXT, overlap, a, index, repo, now,
                          when=f"at {edited_files._when(overlap['a_at'], today)}")}


def _notify(conv, text):
    """Leave one notice for a session. A session that can't be reached (gone
    from the index) is logged and skipped — the other one is still told."""
    try:
        peermail.send_notice(conv, text)
        return True
    except (KeyError, ValueError) as e:
        print(f"file alert to {conv} not sent: {e}", file=sys.stderr, flush=True)
        return False


def tick(now=None, repo=None):
    """The minute check: find every overlap and write down each pair that
    isn't written down for that file yet, for the room helper to read. The
    sessions are told as well only when config.FILE_ALERTS is on. Returns how
    many new overlaps were written down. Run by scripts/coming_up_dispatcher.py."""
    if not (config.FILE_OVERLAPS or config.FILE_ALERTS):
        return 0
    now = now or datetime.now()
    repo = Path(repo or edited_files._REPO)
    index = _index()
    tell = config.FILE_ALERTS
    recorded = 0
    for room in config.FILE_ALERT_ROOMS:
        for overlap in overlaps(room, index, repo, now):
            # Write it down BEFORE telling anyone: a crash between the two
            # costs one alert, never the same alert every minute forever.
            if not claim(overlap, index, "tick", now, told=tell):
                continue
            recorded += 1
            if tell:
                for conv, text in texts(overlap, index, repo, now).items():
                    _notify(conv, text)
    return recorded


# --- Caught as the edit begins (the pre-edit hook) -----------------------------------

def before_edit(conv, tool, tool_input, cwd=None, repo=None, now=None):
    """Only when config.FILE_ALERTS is on (it is off by default, and then
    no session carries the hook). A session is about to change a file: if
    another open session changed that file in the window and this pair isn't
    written down yet, tell both now.
    Returns the warning for the session making the edit (the hook adds it to
    what the agent sees), or None. The other session gets a notice."""
    if not config.FILE_ALERTS or not conv:
        return None
    index = _index()
    entry = index.get(conv)
    if not isinstance(entry, dict):
        return None
    room = lanes.derive_lane(entry)
    if room not in config.FILE_ALERT_ROOMS:
        return None
    repo = Path(repo or edited_files._REPO)
    now = now or datetime.now()
    lines = edited_files.open_lines(room, index)
    mine = next((face for face, line in lines.items() if conv in line), None)
    others = {face: line for face, line in lines.items() if face != mine}
    if mine is None or not others:
        return None
    # What the other open sessions changed in the window.
    since = _now_stamp(now - timedelta(hours=config.FILE_ALERT_HOURS))
    uncommitted, committed = edited_files.changed_in_git(repo, since)
    candidates = uncommitted | committed
    theirs = {}
    for face, touched in edited_files.edits(others, since, repo, candidates).items():
        for path, at in touched.items():
            theirs.setdefault(path, {})[face] = at
    # Which of those files this call is about to change.
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    if tool == "Bash":
        targets = edited_files.bash_writes(str(tool_input.get("command") or ""),
                                           candidates | set(theirs), repo)
    else:
        target = tool_input.get("file_path") or tool_input.get("notebook_path")
        targets = {edited_files._edited_path(target, cwd, repo)}
    warnings = []
    for path in sorted(targets & set(theirs)):
        for other, at in sorted(theirs[path].items()):
            overlap = {"kind": SAME, "path": path, "a": mine, "a_at": _now_stamp(now),
                       "b": other, "b_at": at}
            if not claim(overlap, index, "hook", now, told=True):
                continue
            told = texts(overlap, index, repo, now)
            _notify(other, alert_text(config.FILE_ALERT_SAME_TEXT, overlap, mine, index,
                                      repo, now, when="just now"))
            warnings.append(told[mine])
    if not warnings:
        return None
    # Show the warning in this session's own chat too, as a System bubble:
    # the hook's words reach the agent, but nothing else would write them down.
    warning = "\n\n".join(warnings)
    try:
        peermail.append_line(store.DATA_DIR / "bot_chats" / f"{conv}.jsonl", {
            "type": "reminder", "text": warning, "source": "notice",
            "journaled": False, "ts": _now_stamp(now)})
    except OSError:
        pass
    return warning


# --- What the room helper is shown -----------------------------------------------------

def recorded_lines(lines, repo, today):
    """The overlaps written down that involve a line of work still open here,
    newest first, as bullet lines for edited_files.section — each saying
    whether the sessions were told. `lines` is edited_files.open_lines' answer."""
    keys = [min(line) for line in lines.values()]
    if not keys:
        return []
    marks = ",".join("?" * len(keys))
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            f"SELECT at, kind, path, conv_a, conv_b, told FROM file_alerts"
            f" WHERE line_a IN ({marks}) OR line_b IN ({marks})"
            f" ORDER BY id DESC LIMIT ?", (*keys, *keys, _RECORDED_SHOWN)).fetchall()
    finally:
        conn.close()
    # Name each side by the session carrying its line now, when it's still open.
    carrying = {conv: face for face, line in lines.items() for conv in line}
    out = []
    for at, kind, path, conv_a, conv_b, told in rows:
        a, b = carrying.get(conv_a, conv_a), carrying.get(conv_b, conv_b)
        what = "both changed it" if kind == SAME else f"`{a}` changed it after `{b}` read it"
        heard = "nobody told" if not told else "both told" if kind == SAME else f"`{b}` told"
        out.append(f"- `{edited_files._shown(path, Path(repo))}` — `{a}` and `{b}`:"
                   f" {what}; {heard} (noticed {edited_files._when(at, today)})")
    return out
