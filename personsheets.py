"""The current-facts sheet kept for each person, as a stack.

**What this does, in plain English.** A person's file in the vault holds
their story as prose. This file keeps a short sheet beside it: who they are
and where things stand now, one row each in the `person_sheets` table in
exo.db. A new sheet never replaces an old one. It is added as a new row, and a
person's sheets are read newest first, so the older ones stay readable
underneath.

A sheet is five labelled lines, in this order:

    Who: who they are to the owner
    Pronouns: the pronouns the owner herself uses for them in a card, or
        "not on record" (never guessed from a name)
    Tied to: what they are tied to
    Now: where things stand now
    Last contact: the date of the last contact

Dated facts, not feelings or advice.

Each row says which person (the stem of their file name in `people/`), who
wrote it (`cricket:<name>`), when, the five lines, and the card ids and days
it was based on.

**The length rule.** A sheet is at most MAX_WORDS words. `add()` refuses a
longer one, and refuses a body that is not exactly the five lines.

Touches: `sqlstore.py` (the table), `scripts/person_sheet.py` (the door a
session uses).

Prompt: "As long as it's got a table and the cards are tagged to tables and I
can have summaries in the table. Don't overwrite old summaries, just make a
new summary."
"""
import json
import re
from datetime import datetime

import sqlstore

# The most words one sheet may hold.
MAX_WORDS = 100

# The five lines of a sheet, in order.
LABELS = ("Who", "Pronouns", "Tied to", "Now", "Last contact")

_SLUG = re.compile(r"^[a-z0-9-]{1,40}$")
_AUTHOR = re.compile(r"^cricket:[a-z0-9-]{1,40}$")
# A card id (2026-07-08.1841b, sometimes with a trailing digit) or a bare day.
_SOURCE = re.compile(r"^\d{4}-\d{2}-\d{2}(\.\d{4}[a-z]\d*)?$")


def word_count(text):
    return len((text or "").split())


def _lines(body):
    """The body's non-empty lines, trimmed. Blank lines are dropped."""
    return [line.strip() for line in (body or "").splitlines() if line.strip()]


def _row(row):
    return {"id": row[0], "slug": row[1], "author": row[2], "written_at": row[3],
            "body": row[4], "based_on": json.loads(row[5] or "[]")}


def add(slug, author, body, based_on=(), written_at=None):
    """Add one sheet on top of a person's stack and return it.

    Raises ValueError for a bad slug or author, a body that is not the five
    labelled lines in order, an over-long body, or a source that is neither a
    card id nor a day. Returns None, and adds nothing, when the body is word
    for word the person's newest sheet: a writer with nothing new to say does
    not grow the stack."""
    if not _SLUG.match(slug or ""):
        raise ValueError(f"not a person slug: {slug!r}")
    if not _AUTHOR.match(author or ""):
        raise ValueError(f"author must be 'cricket:<name>', not {author!r}")
    lines = _lines(body)
    if len(lines) != len(LABELS):
        raise ValueError(f"a sheet is exactly {len(LABELS)} lines "
                         f"({', '.join(LABELS)}); this one has {len(lines)}")
    for label, line in zip(LABELS, lines):
        prefix = f"{label}: "
        if not line.startswith(prefix) or not line[len(prefix):].strip():
            raise ValueError(f"line for {label!r} must start with {prefix!r} and say something: {line!r}")
    body = "\n".join(lines)
    if word_count(body) > MAX_WORDS:
        raise ValueError(f"a sheet is at most {MAX_WORDS} words; this one is {word_count(body)}")
    based_on = [str(source) for source in based_on]
    wrong = [source for source in based_on if not _SOURCE.match(source)]
    if wrong:
        raise ValueError(f"not a card id or a day: {', '.join(wrong)}")
    written_at = written_at or datetime.now().isoformat(timespec="seconds")
    conn = sqlstore.open_db()
    try:
        newest = conn.execute(
            "SELECT body FROM person_sheets WHERE slug = ?"
            " ORDER BY written_at DESC, id DESC LIMIT 1", (slug,)).fetchone()
        if newest and newest[0] == body:
            return None
        cursor = conn.execute(
            "INSERT INTO person_sheets (slug, author, written_at, body, based_on)"
            " VALUES (?, ?, ?, ?, ?)",
            (slug, author, written_at, body, json.dumps(based_on)))
        conn.commit()
        return {"id": cursor.lastrowid, "slug": slug, "author": author,
                "written_at": written_at, "body": body, "based_on": based_on}
    finally:
        conn.close()


def for_person(slug):
    """A person's sheets, newest first."""
    conn = sqlstore.open_db()
    try:
        return [_row(row) for row in conn.execute(
            "SELECT id, slug, author, written_at, body, based_on FROM person_sheets"
            " WHERE slug = ? ORDER BY written_at DESC, id DESC", (slug,))]
    finally:
        conn.close()


def newest(slug):
    """A person's newest sheet, or None when they have none."""
    sheets = for_person(slug)
    return sheets[0] if sheets else None
