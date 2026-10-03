"""File alerts — the app notices when two open sessions are in the same file,
and writes it down for the helpers.

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
`file_alerts` table. That is all that happens: the sessions themselves are
told nothing, and no helper is woken for it. The helpers are shown the list
(`recorded_section`) — the room helper's runs at the end of their files
section (edited_files.section), and every helper's chat at the end of the
sessions part of its seed (helper_chat.py) — and decide whether to message
anyone or put the two in a swarm.

An earlier build told the two sessions directly. In its first ten minutes it
sent thirteen notices, none of which needed acting on, and the owner chose
the helper-only way; that code is gone. The few rows it wrote are marked
`told`, and the list says so on those lines.

Who is never part of an overlap: a session and its own continuation (they're
one line of work), a helper, a session that is done, closed or handed on, and
any pair already written down for that file.

What it can miss is what edited_files.py can miss: an edit or a read made
through Bash is only seen when the command spells the file's name, and a
Bash edit only for a file git shows as changed.

Touches: edited_files.py (open_lines, edits, reads — the detecting — and its
section), helper_chat.py (the seed), sqlstore.py (the `file_alerts` table,
rungs 42–43), swarms.py (line_of_work), config.py (FILE_OVERLAPS,
FILE_ALERT_ROOMS, FILE_ALERT_HOURS), scripts/coming_up_dispatcher.py (the
minute tick), tests/test_file_alerts.py. Design: docs/swarms.md.

Prompts that produced this: "So maybe have some kind of code that identifies
when 2 agents are working nearby or on the same files and alert them when
they are?" — then, after seeing it run: "That should only be read by the
helper", and "list should go to helper chats seed but don't wake".
"""
from datetime import datetime, timedelta
from pathlib import Path

import config
import edited_files
import sqlstore
import store
import swarms

SAME, STALE = "same-file", "stale-copy"
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


def claim(overlap, index, now=None):
    """Write this pair and file down. True only for the one caller whose row
    went in — the unique key refuses every later one, which is what makes an
    overlap count once however many checks see it."""
    low, high = sorted((_line_key(overlap["a"], index), _line_key(overlap["b"], index)))
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        won = conn.execute(
            "INSERT OR IGNORE INTO file_alerts (at, kind, path, line_a, line_b, conv_a,"
            " conv_b) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (_now_stamp(now or datetime.now()), overlap["kind"], overlap["path"], low, high,
             overlap["a"], overlap["b"])).rowcount
        conn.execute("COMMIT")
    finally:
        conn.close()
    return won == 1


def tick(now=None, repo=None):
    """The minute check: find every overlap and write down each pair that
    isn't written down for that file yet, for the helpers to read. Returns
    how many new overlaps were written down. Run by
    scripts/coming_up_dispatcher.py."""
    if not config.FILE_OVERLAPS:
        return 0
    now = now or datetime.now()
    repo = Path(repo or edited_files._REPO)
    index = _index()
    return sum(claim(overlap, index, now)
               for room in config.FILE_ALERT_ROOMS
               for overlap in overlaps(room, index, repo, now))


# --- What the helpers are shown -----------------------------------------------------

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


def recorded_section(lines, repo, today):
    """The list above under its heading, as markdown lines — empty when there
    is nothing to list. Both places a helper reads it use this, so the words
    are the same: edited_files.section and helper_chat's sessions part."""
    recorded = recorded_lines(lines, repo, today)
    if not recorded:
        return []
    return ["## Overlaps the app has noticed", "",
            "Each pair and file is listed once, when first noticed. Unless a line says"
            " a session was told, the sessions don't know: whether to message them,"
            " make them a swarm or leave it is yours to decide.", ""] + recorded
