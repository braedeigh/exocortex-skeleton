"""The summaries written of each journal thread, kept as a stack.

**What this does, in plain English.** A thread's file holds dated facts with
their sources and no prose. This file keeps the prose beside it: short
summaries of where a thread stands, one row each in the `thread_summaries`
table in exo.db. A new summary never replaces an old one. It is added as a new
row, and a thread's summaries are read newest first, so the older ones stay
readable underneath.

Each row says which thread, who wrote it (`keeper`, or `cricket:<name>` for a
night helper), when, the words, and the card ids and days it was based on. A
summary written because the thread changed status also carries that status
(`dormant`, `retired`, `active`).

**The length rule.** A summary is at most MAX_WORDS words. `add()` refuses a
longer one. `fit()` shortens one by dropping whole sentences from the end, for
a writer that would rather store less than nothing.

Touches: `sqlstore.py` (the table), `scripts/thread_summary.py` (the door a
session uses), `scripts/thread_tending.py` (the night pass writes through
here), `routes/threads.py` (the thread page reads through here).

Prompt: "Summarize it and put that in there somewhere in the database as a
keeper record. Then have the crickets store information the same way and
update a summary whenever they edit a thread. Each summary sits above an old
summary and I can read past summaries. Don't make them too long."
"""
import json
import re
from datetime import datetime

import sqlstore

# The most words one summary may hold.
MAX_WORDS = 120

_SLUG = re.compile(r"^[a-z0-9-]{1,40}$")
_AUTHOR = re.compile(r"^(keeper|cricket:[a-z0-9-]{1,40})$")
# A card id (2026-07-08.1841b, sometimes with a trailing digit) or a bare day.
# The statuses a thread can move to, which a summary can be marked with.
STATUSES = ("active", "dormant", "retired")
_SOURCE = re.compile(r"^\d{4}-\d{2}-\d{2}(\.\d{4}[a-z]\d*)?$")
# One sentence: the words up to a full stop, question mark or exclamation mark,
# plus any closing quote or bracket right after it. The last piece of a text
# counts as a sentence even with no full stop.
_SENTENCE = re.compile(r".+?(?:[.!?][\"'”’)\]]*(?=\s|$)|$)")


def word_count(text):
    return len((text or "").split())


def fit(text):
    """The summary cut down to MAX_WORDS by dropping whole sentences from the
    end. Empty when even the first sentence is too long."""
    text = " ".join((text or "").split())
    if word_count(text) <= MAX_WORDS:
        return text
    kept = ""
    for sentence in _SENTENCE.findall(text):
        longer = kept + sentence
        if word_count(longer) > MAX_WORDS:
            break
        kept = longer
    return kept.strip()


def _row(row):
    return {"id": row[0], "slug": row[1], "author": row[2], "written_at": row[3],
            "body": row[4], "based_on": json.loads(row[5] or "[]"), "status": row[6]}


def add(slug, author, body, based_on=(), written_at=None, status=None):
    """Add one summary on top of a thread's stack and return it.

    `status` marks a summary written because the thread moved to that status.

    Raises ValueError for a bad slug, author or status, an empty or over-long
    body, or a source that is neither a card id nor a day. Returns None, and
    adds nothing, when the body is word for word the thread's newest summary
    and no status is being marked: a writer that has nothing new to say does
    not grow the stack."""
    body = (body or "").strip()
    if not _SLUG.match(slug or ""):
        raise ValueError(f"not a thread slug: {slug!r}")
    if not _AUTHOR.match(author or ""):
        raise ValueError(f"author must be 'keeper' or 'cricket:<name>', not {author!r}")
    if status is not None and status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}, not {status!r}")
    if not body:
        raise ValueError("a summary needs words")
    if word_count(body) > MAX_WORDS:
        raise ValueError(f"a summary is at most {MAX_WORDS} words; this one is {word_count(body)}")
    based_on = [str(source) for source in based_on]
    wrong = [source for source in based_on if not _SOURCE.match(source)]
    if wrong:
        raise ValueError(f"not a card id or a day: {', '.join(wrong)}")
    written_at = written_at or datetime.now().isoformat(timespec="seconds")
    conn = sqlstore.open_db()
    try:
        newest = conn.execute(
            "SELECT body FROM thread_summaries WHERE slug = ?"
            " ORDER BY written_at DESC, id DESC LIMIT 1", (slug,)).fetchone()
        if newest and newest[0] == body and status is None:
            return None
        cursor = conn.execute(
            "INSERT INTO thread_summaries (slug, author, written_at, body, based_on, status)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (slug, author, written_at, body, json.dumps(based_on), status))
        conn.commit()
        return {"id": cursor.lastrowid, "slug": slug, "author": author,
                "written_at": written_at, "body": body, "based_on": based_on, "status": status}
    finally:
        conn.close()


def for_thread(slug):
    """A thread's summaries, newest first."""
    conn = sqlstore.open_db()
    try:
        return [_row(row) for row in conn.execute(
            "SELECT id, slug, author, written_at, body, based_on, status FROM thread_summaries"
            " WHERE slug = ? ORDER BY written_at DESC, id DESC", (slug,))]
    finally:
        conn.close()
