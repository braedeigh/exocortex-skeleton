"""The build log: everything planned, built, or decided against for the app.

**What this does, in plain English.** Each thing someone means to build, fix or
look into is one row in the `build_items` table in exo.db: a title, the write-up
underneath it, who raised it and when, and where it stands — an idea, open,
paused, shipped, or dropped. Nothing is deleted when it ships or is turned
down: the log keeps what was done *and* what was decided against, so an old
idea that comes back can be found with its first answer attached.

Whatever happens to an item later goes in a second table, `build_notes`, as a
dated line under it — a finding, a follow-up, a change of status. The item's
own write-up is never rewritten; the notes pile up beneath it in order, the
way the old markdown file grew `###` addenda under a heading.

The log replaced the vault's `dev_todo.md` (one long markdown file) on
2026-10-14. `import_markdown()` is the one-time move of that file's `## `
sections into rows; the file itself stays in the vault's archive.

Touches: `sqlstore.py` (the two tables), `scripts/build_log.py` (the door a
session uses), `scripts/spark_morning.py` (reads the open items each morning).

Prompt: "is it possible to turn [the dev todo] into a database powered item
instead" … "I'd want to save this as a log of things I do and plan to do and
build out or not."
"""
import re
from contextlib import contextmanager
from datetime import date, datetime

import sqlstore

# Where an item stands.
#   idea    — named, not planned or started
#   open    — meant to be built or fixed
#   paused  — set aside on purpose, may come back
#   shipped — built (or fixed, or answered)
#   dropped — decided against; kept so the answer is findable
STATUSES = ("idea", "open", "paused", "shipped", "dropped")
LIVE = ("idea", "open", "paused")
CLOSED = ("shipped", "dropped")

_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ITEM_COLUMNS = "id, title, body, status, raised_by, raised_on, added_at, closed_on, source"


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _item(row):
    return dict(zip(("id", "title", "body", "status", "raised_by", "raised_on",
                     "added_at", "closed_on", "source"), row))


def _check(title=None, by=None, status=None, raised_on=None):
    """Refuse a value that doesn't belong in the log, with a reason."""
    if title is not None and not title.strip():
        raise ValueError("an item needs a title")
    if by is not None and not (by.strip() and len(by) <= 60):
        raise ValueError("say who raised it (60 characters at most)")
    if status is not None and status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}, not {status!r}")
    if raised_on is not None and not _DAY.match(raised_on):
        raise ValueError(f"raised_on is a day, YYYY-MM-DD, not {raised_on!r}")


@contextmanager
def _writing():
    """One write to the log, all or nothing.

    exo.db connections commit each statement on its own, so a write of more
    than one row takes the write lock first (sqlstore.begin_immediate, which
    waits its turn behind other writers) and commits once at the end. Any
    error rolls the whole write back."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        try:
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def _insert(conn, title, by, body, status, raised_on, source):
    """Write one item row, inside a _writing() block."""
    cursor = conn.execute(
        "INSERT INTO build_items (title, body, status, raised_by, raised_on,"
        " added_at, closed_on, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (title.strip(), (body or "").strip(), status, by.strip(), raised_on,
         _now(), raised_on if status in CLOSED else None, source))
    return cursor.lastrowid


def add(title, by, body="", status="open", raised_on=None):
    """Add one item to the log and return it. raised_on defaults to today."""
    _check(title=title, by=by, status=status, raised_on=raised_on)
    with _writing() as conn:
        item_id = _insert(conn, title, by, body, status,
                          raised_on or date.today().isoformat(), None)
    return get(item_id)


def get(item_id, conn=None):
    """One item with its notes, oldest note first, or None."""
    own = conn is None
    conn = conn or sqlstore.open_db()
    try:
        row = conn.execute(f"SELECT {_ITEM_COLUMNS} FROM build_items WHERE id = ?",
                           (item_id,)).fetchone()
        if row is None:
            return None
        item = _item(row)
        item["notes"] = [dict(zip(("id", "written_at", "author", "kind", "text"), note))
                         for note in conn.execute(
                             "SELECT id, written_at, author, kind, text FROM build_notes"
                             " WHERE item_id = ? ORDER BY written_at, id", (item_id,))]
        return item
    finally:
        if own:
            conn.close()


def items(statuses=LIVE, search=None):
    """The items in the given statuses, newest raised first, without notes.

    `search` keeps only items whose title, write-up or notes contain the
    words, ignoring case."""
    statuses = tuple(statuses)
    for status in statuses:
        _check(status=status)
    query = (f"SELECT {_ITEM_COLUMNS} FROM build_items"
             f" WHERE status IN ({', '.join('?' * len(statuses))})")
    values = list(statuses)
    if search:
        query += (" AND (title LIKE ? OR body LIKE ? OR id IN"
                  " (SELECT item_id FROM build_notes WHERE text LIKE ?))")
        values += [f"%{search}%"] * 3
    query += " ORDER BY raised_on DESC, id DESC"
    conn = sqlstore.open_db()
    try:
        return [_item(row) for row in conn.execute(query, values)]
    finally:
        conn.close()


def note(item_id, by, text):
    """Add a dated note under an item: a finding, a follow-up, an addendum."""
    _check(by=by)
    if not (text or "").strip():
        raise ValueError("a note needs some words")
    with _writing() as conn:
        if not conn.execute("SELECT 1 FROM build_items WHERE id = ?", (item_id,)).fetchone():
            raise ValueError(f"no build item #{item_id}")
        conn.execute("INSERT INTO build_notes (item_id, written_at, author, kind, text)"
                     " VALUES (?, ?, ?, 'note', ?)", (item_id, _now(), by.strip(), text.strip()))
    return get(item_id)


def set_status(item_id, status, by, why=""):
    """Move an item to a new status, and log the move as a note under it.

    Shipping or dropping it stamps today as the day it closed; reopening it
    clears that day."""
    _check(status=status, by=by)
    with _writing() as conn:
        row = conn.execute("SELECT status FROM build_items WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise ValueError(f"no build item #{item_id}")
        if row[0] == status:
            return get(item_id, conn=conn)
        conn.execute("UPDATE build_items SET status = ?, closed_on = ? WHERE id = ?",
                     (status, date.today().isoformat() if status in CLOSED else None, item_id))
        text = f"{row[0]} → {status}" + (f": {why.strip()}" if (why or "").strip() else "")
        conn.execute("INSERT INTO build_notes (item_id, written_at, author, kind, text)"
                     " VALUES (?, ?, ?, 'status', ?)", (item_id, _now(), by.strip(), text))
    return get(item_id)


# ---- the one-time move of dev_todo.md into the log ------------------------

# The heading's leading status emoji, and what each one meant in the old file.
_EMOJI_STATUS = {"✅": "shipped", "⏸": "paused", "💡": "idea", "🔍": "idea"}
_LEADING_MARKS = re.compile(r"^[^\w`\"'(\[]+")
_CLOSED_WORDS = re.compile(r"^(CLOSED|FIXED|SHIPPED|BACKFILLED)\b")
_FIRST_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def parse_heading(heading):
    """Read a `## ` heading's title, status, author and day.

    The old file's headings carried their facts as prose — a status emoji, a
    title, then something like `(hers, 2026-10-14, idea only)`. This reads
    what's there and guesses nothing more: no day found means no day, no
    author found means `unknown`."""
    marks = _LEADING_MARKS.match(heading)
    leading = marks.group(0) if marks else ""
    title = heading[len(leading):].strip() or heading.strip()
    status = "open"
    for emoji, meaning in _EMOJI_STATUS.items():
        if emoji in leading:
            status = meaning
    if _CLOSED_WORDS.match(title):
        status = "shipped"
    elif "idea only" in title.lower():
        status = "idea"
    # The heading's own aside is the first parenthetical that holds a day —
    # `(hers, 2026-10-14)` — so a day that's part of the title ("Receipts all
    # dated 2026-06-01") isn't taken for the day it was raised.
    asides = re.findall(r"\(([^)]*)\)", heading)
    aside = next((part for part in asides if _FIRST_DAY.search(part)),
                 asides[0] if asides else "")
    day = _FIRST_DAY.search(aside) or _FIRST_DAY.search(heading)
    return {"title": title, "status": status, "by": _author(aside),
            "raised_on": day.group(0) if day else None}


def _author(aside):
    """Who raised an old item, read from its heading's aside, or 'unknown'.

    "found by the Keeper" and "planned with Spark" give the name after by or
    with; "hers", "her ask", "her spec" all give "hers"; otherwise the first
    capitalised name of three words or fewer ("Ettle", "hers + Fable")."""
    named = re.search(r"\b(?:by|with) (?:the )?([A-Za-z]\w+)", aside)
    if named:
        return named.group(1)
    for part in aside.split(","):
        part = _FIRST_DAY.sub("", part).strip()
        if part.startswith("hers"):
            return part.split(":")[0].strip()
        if part.startswith("her "):
            return "hers"
        if part[:1].isupper() and len(part.split()) <= 3:
            return part
    return "unknown"


def split_markdown(text):
    """Split the old file into its `## ` sections, as (line, heading, body).

    Everything under a heading, `###` addenda included, is that section's
    body, word for word. Lines before the first `## ` (the file's own title)
    belong to no item."""
    sections, current = [], None
    for number, line in enumerate(text.splitlines(), start=1):
        if line.startswith("## "):
            current = [number, line[3:].strip(), []]
            sections.append(current)
        elif current is not None:
            current[2].append(line)
    return [(number, heading, "\n".join(lines).strip()) for number, heading, lines in sections]


def import_markdown(text, source_name="dev_todo.md"):
    """Move every section of the old file into the log; return how many.

    Sections go in from the bottom of the file up, so the oldest get the
    lowest numbers. Refuses to run twice: if any row already came from this
    source, nothing is added."""
    sections = split_markdown(text)
    with _writing() as conn:
        if conn.execute("SELECT 1 FROM build_items WHERE source LIKE ?",
                        (f"{source_name}:%",)).fetchone():
            raise ValueError(f"{source_name} was already imported")
        # An old heading with no day in it keeps raised_on empty, rather
        # than pretending it was raised on the day of the move.
        for number, heading, body in reversed(sections):
            facts = parse_heading(heading)
            _insert(conn, facts["title"], facts["by"], body, facts["status"],
                    facts["raised_on"], f"{source_name}:{number}")
    return len(sections)

