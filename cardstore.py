"""The journal cards, read from exo.db — a compatibility layer for older callers.

**What this is now.** The journal lives in the database (see
`docs/journal-database.md`): `tools/stream/stream.py` writes every card as a
row, and the tables are defined in `tools/stream/journaldb.py`. This module
used to be the opposite — an hourly one-way copy of the card FILES into
exo.db, plus an alarm for files that vanished. That copy and its alarm are
retired; there is one copy of a card now, so there is nothing to drift.

What's left is what existing callers still call, kept working until the
readers session moves them to the tables directly:

  - `read(cid)`      one card from the database, in the dict shape the
                     callers expect (id, day, ts, who, kind, reply_to,
                     session, refs, tags, body).
  - `sync()`, `sync_one()`, `sync_fresh()`
                     bring in any card that exists only as a FILE — insert
                     only, never changing a row. On the live install every
                     file already has its row (stream.py writes the files
                     from the rows), so these find nothing; they matter for
                     tests and tools that still create card files, and they
                     are the same import the one-time migration used.
  - `rebuild()`      the SQL console's repair button: the same import (rows
                     are the truth now, so there is nothing to wipe).
  - `integrity()`    always empty — there is no second copy to go missing.

Touches: `sqlstore.py` (connection + ladder), `store.py` (where the vault
and data dir are), `tools/stream/stream.py` (file parsing and the import).
"""
import json
import re
from pathlib import Path

import sqlstore
import store
from tools.stream import stream

# The table module stream.py itself loaded, so both share one copy.
journaldb = stream.journaldb

# The only card-id shape stream.py mints: date.HHMM + the speaker's letter
# (b owner, k keeper, s system) + optional counter.
_CARD_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d{4}[bks]\d*$")


def pool_dir() -> Path:
    """The old card folder (still written, from the rows, while
    stream.py's compatibility files are on). Resolved at call time so tests
    that move store.CONTENT_DIR get their own."""
    return store.CONTENT_DIR / "_system" / "data" / "cards"


def deleted_log_path() -> Path:
    return store.CONTENT_DIR / "_system" / "data" / "deleted_cards.jsonl"


def _as_dict(row):
    """A journaldb row in the shape this module has always returned."""
    return {
        "id": row["id"],
        "day": row["day"],
        "ts": row["said_at"],
        "who": row["who"],
        "kind": row["kind"],
        "reply_to": row["reply_to"],
        "session": row["session"],
        "refs": json.dumps(row["refs"] or []),
        "tags": row["tags"],
        "body": row["body"],
    }


def read(cid: str):
    """One live card from the database, or None. A card that so far exists
    only as a file is brought in first, as the old file-reading version of
    this function would have found it."""
    if not _CARD_ID_RE.match(cid or ""):
        return None
    sync_one(cid)
    conn = sqlstore.open_db()
    try:
        rows = journaldb.fetch_cards(conn, "id = ? AND deleted_at IS NULL", (cid,))
    finally:
        conn.close()
    return _as_dict(rows[0]) if rows else None


def _label_context():
    return journaldb.LabelContext(store.CONTENT_DIR, store.DATA_DIR)


def import_files(pool=None, only=None, added_by="migration"):
    """Insert every card file whose id has no row yet. Returns how many were
    added. `only` limits it to a set of ids. Never changes an existing row,
    so it is safe to run against the live database at any time."""
    pool = Path(pool) if pool else pool_dir()
    if not pool.exists():
        return 0
    paths = sorted(pool.glob("*.md"))
    if only is not None:
        paths = [p for p in paths if p.stem in only]
    conn = sqlstore.open_db()
    added = []
    try:
        have = {r[0] for r in conn.execute("SELECT id FROM cards")}
        todo = [p for p in paths if p.stem not in have and _CARD_ID_RE.match(p.stem)]
        if not todo:
            return 0
        context = _label_context()
        sqlstore.begin_immediate(conn)
        try:
            for path in todo:
                try:
                    card = stream.parse_card_file(path)
                except (stream.StreamError, OSError, UnicodeDecodeError):
                    continue  # not a readable card — skipped, never guessed at
                if card.id != path.stem:
                    continue
                if stream.import_card(conn, card, added_by=added_by, context=context, links=False):
                    added.append(card)
            for card in added:
                stream.import_links(conn, card)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return len(added)


def _live_count():
    conn = sqlstore.open_db()
    try:
        return conn.execute("SELECT COUNT(*) FROM cards WHERE deleted_at IS NULL").fetchone()[0]
    finally:
        conn.close()


def sync():
    """Bring in cards that exist only as files; report in the old shape."""
    new = import_files()
    return {"cards": _live_count(), "new": new, "deleted": 0, "missing": []}


def sync_one(cid: str):
    """Bring in one card if it exists only as a file."""
    if _CARD_ID_RE.match(cid or ""):
        import_files(only={cid})


def sync_fresh(pool=None):
    """Bring in any card that exists only as a file in `pool` (the vault's
    own folder by default). Returns how many were added."""
    return import_files(pool)


def rebuild():
    """The SQL console's repair button. The rows are the truth now, so this
    only brings in what's missing — it can never wipe the journal."""
    return sync()


def integrity():
    """Kept for callers of the retired missing-card alarm. There is one copy
    of each card now, so nothing can go missing from a second one."""
    return []
