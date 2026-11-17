"""
journaldb.py — the journal's tables in exo.db: their shape, and the small
row-level operations every writer shares.

**What this is.** Since the journal moved into the database (see
`docs/journal-database.md`, the design of record), a card is a row in `cards`,
not a markdown file. This module holds the one definition of the five journal
tables and the rules that live in SQLite itself, plus the handful of
operations that touch them: put a card in, label it, take a label off, link
two cards, record an edit.

It is **standard library only** on purpose. `stream.py` runs under the
system `python3` through the vault shim, with no venv, and must be able to
write a card with nothing but this file beside it. The app's migration ladder
(`sqlstore.py`, rung 61) imports this same module, so the schema the app
builds and the schema the engine expects can never be two different texts.

The tables:

    cards        one row per utterance           editable 24h, then frozen
    card_edits   before/after of each edit       append-only
    card_links   note -> old card, answer -> q   a row is never changed
    labels       threads, people, topics, ...    the vocabulary
    card_labels  card <-> label, with history    rows are marked off, never deleted

plus `card_tags`, a read-only VIEW in the shape the old mirror table had
(card_id, tag), so every reader written against the mirror keeps working.

Touches: `tools/stream/stream.py` (the engine; every card write goes through
it), `sqlstore.py` (the ladder rung that builds these tables in the live
database), `cardstore.py` (the app-side reader), `scripts/journal_db_migrate.py`
(the one-time move of the card files into these tables).
"""
import json
import os
import random
import sqlite3
import time
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from typing import Dict, List, Optional


# --------------------------------------------------------------------------------
# The schema. Every statement is IF NOT EXISTS, so running it again is a no-op.
# --------------------------------------------------------------------------------

# The 24-hour rule, written as SQL so it holds for every writer, not just the
# ones that remember to check. The clock runs from `saved_at` — when the row
# landed — not from when the words were said, so a card that arrives late (a
# voice listener that was offline, a held card drained hours later, a card
# added to an older day) still gets its full day to be fixed. Times are local
# 'YYYY-MM-DD HH:MM:SS', so a plain string comparison against SQLite's local
# clock orders correctly.
LOCK_WINDOW = "-1 day"
_LOCKED = f"old.saved_at < datetime('now', 'localtime', '{LOCK_WINDOW}')"

SCHEMA = [
    # One row per utterance. The id is the readable one the files had
    # (`2026-11-15.2315b`: day . HHMM + speaker letter + optional counter).
    """CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        -- B the owner, K the Keeper, S the system.
        who TEXT NOT NULL CHECK (who IN ('B', 'K', 'S')),
        -- The moment it was said, local 'YYYY-MM-DD HH:MM:SS'.
        said_at TEXT NOT NULL,
        -- The journal day: the first ten characters of said_at.
        day TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'line' CHECK (kind IN ('line', 'context', 'ref')),
        body TEXT NOT NULL,
        -- A ref card's targets, as a JSON list ("YYYY-MM-DD" or a vault path).
        refs TEXT NOT NULL DEFAULT '[]',
        -- sha256 of who, said_at and body: a rewrite that went around the
        -- triggers no longer matches it (stream.py validate checks).
        fingerprint TEXT NOT NULL,
        -- How it came in: web, hook, reconciler, voice, cli, ... NULL for
        -- cards from before doors were recorded.
        door TEXT,
        -- Which machine heard it (voice).
        device TEXT,
        -- The conversation it was pulled out of, if any.
        session TEXT,
        -- When this row was written. The 24-hour lock runs from here, and
        -- it can never be changed (a trigger refuses), or rewriting it
        -- would reopen the window. Migrated cards carry said_at here.
        saved_at TEXT NOT NULL,
        -- Set by a delete inside the window; the row stays, hidden.
        deleted_at TEXT,
        deleted_by TEXT,
        -- Compatibility for readers written against the old mirror table,
        -- which called said_at `ts` and tracked missing files. Computed,
        -- never stored, so they can't disagree with the real columns.
        ts TEXT GENERATED ALWAYS AS (said_at) VIRTUAL,
        missing_since TEXT GENERATED ALWAYS AS (NULL) VIRTUAL
    )""",
    "CREATE INDEX IF NOT EXISTS cards_by_day ON cards (day)",
    "CREATE INDEX IF NOT EXISTS cards_by_fingerprint ON cards (fingerprint)",

    # Before/after of every edit made inside the window. Voice cards never
    # pass through a Claude transcript, so this is their only history.
    """CREATE TABLE IF NOT EXISTS card_edits (
        id INTEGER PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id),
        edited_at TEXT NOT NULL,
        by TEXT NOT NULL,
        before TEXT NOT NULL,
        after TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS card_edits_by_card ON card_edits (card_id, edited_at)",

    # A newer card pointing at an older one: `note` (a later thought on a
    # locked card), `answers` (her reply to a Keeper question — what the
    # files called reply_to).
    """CREATE TABLE IF NOT EXISTS card_links (
        from_card TEXT NOT NULL REFERENCES cards(id),
        to_card TEXT NOT NULL REFERENCES cards(id),
        kind TEXT NOT NULL CHECK (kind IN ('note', 'answers')),
        linked_at TEXT NOT NULL,
        by TEXT,
        PRIMARY KEY (from_card, to_card, kind)
    )""",
    "CREATE INDEX IF NOT EXISTS card_links_to ON card_links (to_card, kind)",

    # The vocabulary: one row per thread, person, topic, front or source.
    # A slug names one label, whatever its kind, so `card_tags` can show it
    # as the plain string the files carried.
    """CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'dormant', 'retired')),
        -- The vault file it belongs to (Threads/x.md, people/x.md), if any.
        file TEXT,
        created_at TEXT NOT NULL
    )""",

    # Card <-> label, with who put it there and why. Taking a label off marks
    # the row (removed_*) instead of deleting it: that row is the memory that
    # stops an agent putting back a label the owner took off.
    """CREATE TABLE IF NOT EXISTS card_labels (
        id INTEGER PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id),
        label_id INTEGER NOT NULL REFERENCES labels(id),
        -- owner, keeper, capture, migration, thread-tending, people-cricket, ...
        added_by TEXT NOT NULL,
        -- Which nightly run added it, so one night can be undone at once.
        run TEXT,
        reason TEXT,
        -- about (mainly this) or touches (it comes up); NULL until judged.
        weight TEXT CHECK (weight IS NULL OR weight IN ('about', 'touches')),
        added_at TEXT NOT NULL,
        removed_at TEXT,
        removed_by TEXT,
        removed_why TEXT
    )""",
    # At most one LIVE row per card and label; marked-off rows pile up beside it.
    """CREATE UNIQUE INDEX IF NOT EXISTS card_labels_live
        ON card_labels (card_id, label_id) WHERE removed_at IS NULL""",
    "CREATE INDEX IF NOT EXISTS card_labels_by_label ON card_labels (label_id, card_id)",
    "CREATE INDEX IF NOT EXISTS card_labels_by_run ON card_labels (run)",

    # The 24-hour lock. Changing what was said (words, speaker, time, kind,
    # id), or deleting — hiding via deleted_at or removing the row — is
    # refused once the row is more than a day old. One clock for everyone.
    f"""CREATE TRIGGER IF NOT EXISTS cards_locked_update
        BEFORE UPDATE OF id, who, said_at, day, kind, body, fingerprint, deleted_at ON cards
        WHEN {_LOCKED}
        BEGIN SELECT RAISE(ABORT, 'card is locked: saved more than 24 hours ago'); END""",
    # The lock's own clock never moves.
    """CREATE TRIGGER IF NOT EXISTS cards_saved_at_fixed
        BEFORE UPDATE OF saved_at ON cards
        WHEN new.saved_at IS NOT old.saved_at
        BEGIN SELECT RAISE(ABORT, 'saved_at never changes'); END""",
    f"""CREATE TRIGGER IF NOT EXISTS cards_locked_delete
        BEFORE DELETE ON cards
        WHEN {_LOCKED}
        BEGIN SELECT RAISE(ABORT, 'card is locked: saved more than 24 hours ago'); END""",

    # Append-only tables refuse change outright.
    """CREATE TRIGGER IF NOT EXISTS card_edits_append_only_update
        BEFORE UPDATE ON card_edits
        BEGIN SELECT RAISE(ABORT, 'card_edits is append-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS card_edits_append_only_delete
        BEFORE DELETE ON card_edits
        BEGIN SELECT RAISE(ABORT, 'card_edits is append-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS card_links_never_change
        BEFORE UPDATE ON card_links
        BEGIN SELECT RAISE(ABORT, 'a card link is never changed'); END""",
    """CREATE TRIGGER IF NOT EXISTS card_links_never_delete
        BEFORE DELETE ON card_links
        BEGIN SELECT RAISE(ABORT, 'a card link is never deleted'); END""",
    """CREATE TRIGGER IF NOT EXISTS card_labels_never_delete
        BEFORE DELETE ON card_labels
        BEGIN SELECT RAISE(ABORT, 'card labels are marked off, never deleted'); END""",

    # The old mirror's tag table, as a view: live labels, plus the two
    # capture facts the files carried as tags (`voice`, `via:<device>`),
    # which now live in the door/device columns. Read-only, so it can never
    # become a second place tags are written.
    """CREATE VIEW IF NOT EXISTS card_tags AS
        SELECT cl.card_id AS card_id, l.slug AS tag
          FROM card_labels cl JOIN labels l ON l.id = cl.label_id
         WHERE cl.removed_at IS NULL
        UNION
        SELECT id, 'voice' FROM cards WHERE door = 'voice'
        UNION
        SELECT id, 'via:' || device FROM cards WHERE device IS NOT NULL""",
]

# The real tables, for anything that needs to list them (the ladder's
# completeness check, the export).
TABLES = ("cards", "card_edits", "card_links", "labels", "card_labels")


class NotReady(Exception):
    """The database is there but doesn't have the journal tables in their
    new shape yet (the ladder rung hasn't run). A writer treats this like any
    other database failure: the card goes to the holding file."""


def create_schema(conn: sqlite3.Connection) -> None:
    for statement in SCHEMA:
        conn.execute(statement)


def has_new_shape(conn: sqlite3.Connection) -> bool:
    """True when `cards` exists with the said_at column (not the old mirror)."""
    columns = {row[1] for row in conn.execute("PRAGMA table_xinfo(cards)")}
    return "said_at" in columns


def reshape_old_mirror(conn: sqlite3.Connection) -> bool:
    """Move the old hourly mirror (`cards` + `card_tags` tables, from before
    the database was the truth) out of the way, and build the new tables.

    The old tables are RENAMED, not dropped — `cards_v6_mirror` and
    `card_tags_v6_mirror` — so the migration can be compared against them and
    nothing is lost if the cutover has to be walked back; a later rung drops
    them. Their indexes go with them under their old names, which is why the
    new indexes have new names. Returns True if it reshaped anything.

    The caller holds the write lock and re-creates whatever else hangs off
    `cards` (the word index's triggers live in sqlstore.py)."""
    exists = conn.execute(
        "SELECT type FROM sqlite_master WHERE name = 'cards'").fetchone()
    reshaped = False
    if exists and not has_new_shape(conn):
        # Triggers on the old table would follow it through the rename.
        for (name,) in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
                " AND tbl_name IN ('cards', 'card_tags')").fetchall():
            conn.execute(f'DROP TRIGGER "{name}"')
        conn.execute("ALTER TABLE cards RENAME TO cards_v6_mirror")
        kind = conn.execute(
            "SELECT type FROM sqlite_master WHERE name = 'card_tags'").fetchone()
        if kind and kind[0] == "table":
            conn.execute("ALTER TABLE card_tags RENAME TO card_tags_v6_mirror")
        reshaped = True
    create_schema(conn)
    return reshaped


# --------------------------------------------------------------------------------
# Finding and opening the database.
# --------------------------------------------------------------------------------

def db_path(content_root: Optional[Path] = None) -> Path:
    """Where exo.db is, resolved the way the app resolves it.

    `TULKU_STREAM_DB` (an exact file, for tests) -> `EXOCORTEX_DATA_DIR/exo.db`
    (the app's own data dir) -> `<content root>/../data/exo.db` (the vault
    layout: tulku/ and data/ side by side — the same fallback stream.py uses
    for todos.json). Read on every call, never cached, so tests can move it."""
    env = os.environ.get("TULKU_STREAM_DB")
    if env:
        return Path(env)
    env = os.environ.get("EXOCORTEX_DATA_DIR")
    if env:
        return Path(env) / "exo.db"
    if content_root is not None:
        return Path(content_root).parent / "data" / "exo.db"
    raise NotReady("cannot locate exo.db: set EXOCORTEX_DATA_DIR")


# How long the engine waits for the write lock before giving up and holding
# the card instead. Short: the capture hook runs while she waits for her
# prompt to send.
BUSY_MS = 250
LOCK_WAIT_BUDGET = 5.0


def connect(path: Path, create: bool = True) -> sqlite3.Connection:
    """Open exo.db with the house pragmas.

    `create`: a database with no journal tables at all (a brand-new file, a
    test) gets them made here. One with the OLD mirror tables is not touched
    — reshaping is the ladder's job — and raises NotReady instead, so the
    caller holds the card rather than writing into the wrong shape."""
    conn = sqlite3.connect(str(path), timeout=BUSY_MS / 1000, isolation_level=None)
    try:
        conn.execute(f"PRAGMA busy_timeout={BUSY_MS}")
        conn.execute("PRAGMA foreign_keys=ON")
        present = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN"
            " ('cards', 'card_edits', 'card_links', 'labels', 'card_labels')"
        ).fetchone()[0]
        if present == 0 and create:
            begin_immediate(conn)
            try:
                create_schema(conn)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        elif present < len(TABLES) or not has_new_shape(conn):
            raise NotReady("exo.db has the old card mirror; the journal tables aren't built yet")
    except BaseException:
        conn.close()
        raise
    return conn


def begin_immediate(conn: sqlite3.Connection, budget: float = LOCK_WAIT_BUDGET) -> None:
    """Take the write lock, waiting up here in Python between short tries.

    Same shape as sqlstore.begin_immediate, and for the same reason: when the
    engine is imported into a gevent web worker (routes/ear.py), a wait
    inside SQLite's C busy handler freezes the whole worker, while
    `time.sleep` yields. A failed BEGIN starts nothing, so retrying is safe."""
    deadline = time.monotonic() + budget
    delay = 0.01
    while True:
        try:
            conn.execute("BEGIN IMMEDIATE")
            return
        except sqlite3.OperationalError as exc:
            text = str(exc).lower()
            if ("locked" not in text and "busy" not in text) or time.monotonic() >= deadline:
                raise
            time.sleep(min(delay, 0.2) * (0.5 + random.random()))
            delay = min(delay * 2, 0.2)


# --------------------------------------------------------------------------------
# Row operations.
# --------------------------------------------------------------------------------

def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def fingerprint(who: str, said_at: str, body: str) -> str:
    """The card's fingerprint: sha256 over speaker, time and words."""
    return sha256(f"{who}\n{said_at}\n{body}".encode("utf-8")).hexdigest()


def insert_card(conn, *, id, who, said_at, body, kind="line", refs=(), door=None,
                device=None, session=None, saved_at=None, deleted_at=None,
                deleted_by=None) -> None:
    """Put one card in. The caller holds the transaction."""
    conn.execute(
        "INSERT INTO cards (id, who, said_at, day, kind, body, refs, fingerprint,"
        " door, device, session, saved_at, deleted_at, deleted_by)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (id, who, said_at, said_at[:10], kind, body, json.dumps(list(refs or [])),
         fingerprint(who, said_at, body), door or None, device or None,
         session or None, saved_at or now_text(), deleted_at, deleted_by))


def is_locked(saved_at: str, now: Optional[datetime] = None) -> bool:
    """The 24-hour rule in Python, matching the triggers — for a friendly
    refusal before the trigger has to raise one."""
    now = now or datetime.now()
    try:
        saved = datetime.strptime(saved_at, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return True
    return (now - saved).total_seconds() > 24 * 3600


def locks_at(saved_at: str) -> str:
    """When a card stops being editable: saved_at + 24 hours."""
    saved = datetime.strptime(saved_at, "%Y-%m-%d %H:%M:%S")
    return datetime.fromtimestamp(saved.timestamp() + 24 * 3600).strftime("%Y-%m-%d %H:%M:%S")


def link(conn, from_card: str, to_card: str, kind: str, by: Optional[str] = None,
         linked_at: Optional[str] = None) -> bool:
    """Link a newer card to an older one. True if a new link was made."""
    cursor = conn.execute(
        "INSERT OR IGNORE INTO card_links (from_card, to_card, kind, linked_at, by)"
        " VALUES (?, ?, ?, ?, ?)",
        (from_card, to_card, kind, linked_at or now_text(), by))
    return cursor.rowcount > 0


def record_edit(conn, card_id: str, edited_at: str, by: str, before: str, after: str) -> None:
    conn.execute(
        "INSERT INTO card_edits (card_id, edited_at, by, before, after) VALUES (?, ?, ?, ?, ?)",
        (card_id, edited_at, by, before, after))


# --------------------------------------------------------------------------------
# Labels: which kind a new slug is, and putting one on / taking one off.
# --------------------------------------------------------------------------------

# Capture-time tags that say how a card came in rather than what it's about.
SOURCE_SLUGS = ("voice", "exo-command")
OWNER = "owner"


def _frontmatter_fields(path: Path) -> Dict[str, str]:
    """The simple `key: value` lines of a vault file's frontmatter — enough
    for status, title and name. Never raises."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    fields = {}
    for line in text.split("\n")[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if sep and key.strip() and not key.startswith((" ", "\t")):
            fields[key.strip().lower()] = value.strip().strip('"').strip("'")
    return fields


class LabelContext:
    """What it takes to work out a new slug's kind: the vault (people and
    thread files) and the data dir (fronts.json). Built once per write."""

    def __init__(self, content_root: Optional[Path], data_dir: Optional[Path]):
        self.content_root = Path(content_root) if content_root else None
        self.data_dir = Path(data_dir) if data_dir else None
        self._fronts = None

    def fronts(self):
        if self._fronts is None:
            self._fronts = set()
            if self.data_dir is not None:
                try:
                    data = json.loads((self.data_dir / "fronts.json").read_text(encoding="utf-8"))
                    self._fronts = {f["id"] for f in data.get("fronts") or [] if f.get("id")}
                except (OSError, ValueError, AttributeError, TypeError):
                    pass
        return self._fronts

    def classify(self, slug: str) -> dict:
        """kind/status/name/file for a slug, in the order the tags backfill
        classifies (scripts/backfill_tags.py): person, thread, front, else
        topic — with capture sources first."""
        if slug in SOURCE_SLUGS or slug.startswith("via:"):
            return {"kind": "source", "status": "active", "name": slug, "file": None}
        root = self.content_root
        if root is not None:
            person = root / "people" / f"{slug}.md"
            if person.exists():
                fields = _frontmatter_fields(person)
                return {"kind": "person", "status": "active",
                        "name": fields.get("name") or fields.get("title") or _titled(slug),
                        "file": f"people/{slug}.md"}
            for folder, default in (("Threads", "active"), ("Threads-Retired", "retired")):
                thread = root / folder / f"{slug}.md"
                if thread.exists():
                    fields = _frontmatter_fields(thread)
                    status = fields.get("status", default)
                    if folder == "Threads-Retired":
                        status = "retired"
                    if status not in ("active", "dormant", "retired"):
                        status = default
                    return {"kind": "thread", "status": status,
                            "name": fields.get("title") or fields.get("name") or _titled(slug),
                            "file": f"{folder}/{slug}.md"}
        if slug in self.fronts():
            return {"kind": "front", "status": "active", "name": _titled(slug), "file": None}
        return {"kind": "topic", "status": "active", "name": _titled(slug), "file": None}


def _titled(slug: str) -> str:
    return " ".join(word.capitalize() for word in slug.replace("_", "-").split("-") if word) or slug


def label_id(conn, slug: str, context: LabelContext) -> int:
    """The label row for a slug, made (and classified) on first use."""
    row = conn.execute("SELECT id FROM labels WHERE slug = ?", (slug,)).fetchone()
    if row:
        return row[0]
    info = context.classify(slug)
    cursor = conn.execute(
        "INSERT INTO labels (kind, slug, name, status, file, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (info["kind"], slug, info["name"], info["status"], info["file"], now_text()))
    return cursor.lastrowid


def add_label(conn, card_id: str, slug: str, by: str, context: LabelContext,
              run: Optional[str] = None, reason: Optional[str] = None,
              weight: Optional[str] = None, added_at: Optional[str] = None) -> str:
    """Put a label on a card. Returns 'added', 'already' (it's on), or
    'refused' — the owner took this label off this card, and only the
    owner's own hand may put it back (rule 7 of the design)."""
    lid = label_id(conn, slug, context)
    if conn.execute("SELECT 1 FROM card_labels WHERE card_id = ? AND label_id = ?"
                    " AND removed_at IS NULL", (card_id, lid)).fetchone():
        return "already"
    if by != OWNER and conn.execute(
            "SELECT 1 FROM card_labels WHERE card_id = ? AND label_id = ?"
            " AND removed_by = ?", (card_id, lid, OWNER)).fetchone():
        return "refused"
    conn.execute(
        "INSERT INTO card_labels (card_id, label_id, added_by, run, reason, weight, added_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (card_id, lid, by, run, reason, weight, added_at or now_text()))
    return "added"


def remove_label(conn, card_id: str, slug: str, by: str, why: Optional[str] = None,
                 removed_at: Optional[str] = None) -> str:
    """Take a label off a card by marking its row. Returns 'removed',
    'absent' (it wasn't on), or 'refused' — the owner put it there, and an
    agent never removes a label she added (rule 7)."""
    row = conn.execute(
        "SELECT cl.id, cl.added_by FROM card_labels cl JOIN labels l ON l.id = cl.label_id"
        " WHERE cl.card_id = ? AND l.slug = ? AND cl.removed_at IS NULL", (card_id, slug)).fetchone()
    if row is None:
        return "absent"
    if row[1] == OWNER and by != OWNER:
        return "refused"
    conn.execute("UPDATE card_labels SET removed_at = ?, removed_by = ?, removed_why = ? WHERE id = ?",
                 (removed_at or now_text(), by, why, row[0]))
    return "removed"


def set_weight(conn, card_id: str, slug: str, weight: str, by: str) -> str:
    """Mark a live label `about` (the card is mainly this) or `touches` (it
    comes up). Returns 'set', 'same', 'absent' (the label isn't on), or
    'refused': an agent may fill in the weight of a label the owner added
    while it is still unjudged, but never change one already set."""
    if weight not in ("about", "touches"):
        raise ValueError(f"weight must be 'about' or 'touches', not {weight!r}")
    row = conn.execute(
        "SELECT cl.id, cl.added_by, cl.weight FROM card_labels cl JOIN labels l ON l.id = cl.label_id"
        " WHERE cl.card_id = ? AND l.slug = ? AND cl.removed_at IS NULL", (card_id, slug)).fetchone()
    if row is None:
        return "absent"
    if row[2] == weight:
        return "same"
    if row[1] == OWNER and row[2] is not None and by != OWNER:
        return "refused"
    conn.execute("UPDATE card_labels SET weight = ? WHERE id = ?", (weight, row[0]))
    return "set"


def set_label_status(conn, slug: str, status: str) -> bool:
    """Bring a label's status (active, dormant, retired) in step with its
    thread file. True when it changed; a slug with no label is left alone."""
    cursor = conn.execute("UPDATE labels SET status = ? WHERE slug = ? AND status != ?",
                          (status, slug, status))
    return cursor.rowcount > 0


# --------------------------------------------------------------------------------
# Reading cards back, with their live labels, the card each answers, and
# when each was last edited — everything the old file header carried.
# --------------------------------------------------------------------------------

CARD_COLUMNS = ("id", "who", "said_at", "day", "kind", "body", "refs", "fingerprint",
                "door", "device", "session", "saved_at", "deleted_at", "deleted_by")


def fetch_cards(conn, where: str = "deleted_at IS NULL", params=(),
                order: str = "said_at, id") -> List[dict]:
    """Card rows as dicts, each with `tags` (the capture facts as tags —
    `voice`, `via:<device>` — then live label slugs in the order they were
    put on), `reply_to` (the card
    it answers, if any) and `edited` (its last edit time, if any)."""
    rows = [dict(zip(CARD_COLUMNS, row)) for row in conn.execute(
        f"SELECT {', '.join(CARD_COLUMNS)} FROM cards WHERE {where} ORDER BY {order}", params)]
    if not rows:
        return rows
    ids = [row["id"] for row in rows]
    tags: Dict[str, List[str]] = {}
    answers: Dict[str, str] = {}
    edited: Dict[str, str] = {}
    # Fetch the side tables for these ids only, in chunks SQLite will accept.
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for card_id, slug in conn.execute(
                "SELECT cl.card_id, l.slug FROM card_labels cl JOIN labels l ON l.id = cl.label_id"
                f" WHERE cl.removed_at IS NULL AND cl.card_id IN ({marks}) ORDER BY cl.id", chunk):
            tags.setdefault(card_id, []).append(slug)
        for from_card, to_card in conn.execute(
                "SELECT from_card, to_card FROM card_links WHERE kind = 'answers'"
                f" AND from_card IN ({marks}) ORDER BY linked_at", chunk):
            answers.setdefault(from_card, to_card)
        for card_id, last in conn.execute(
                f"SELECT card_id, MAX(edited_at) FROM card_edits WHERE card_id IN ({marks})"
                " GROUP BY card_id", chunk):
            edited[card_id] = last
    for row in rows:
        row["refs"] = json.loads(row["refs"] or "[]")
        # The capture facts lead, where the voice door always put them.
        row_tags = []
        if row["door"] == "voice":
            row_tags.append("voice")
        if row["device"]:
            row_tags.append(f"via:{row['device']}")
        row["tags"] = row_tags + [t for t in tags.get(row["id"], []) if t not in row_tags]
        row["reply_to"] = answers.get(row["id"])
        row["edited"] = edited.get(row["id"])
    return rows
