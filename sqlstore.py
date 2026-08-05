"""SQLite backing for store.py — the database of record, one collection at a time.

The plan (see frontend/MIGRATION_NOTES.md for the frontend side of the story):
JSON files stay the language of the EDGES — LLM agents, git-diffable backups,
"download my data" — while SQLite becomes the CENTER: what the app writes,
what the app reads, and therefore what the UI displays. A collection listed in
store.SQL_COLLECTIONS routes its read/write/mutate through here; everything
else keeps using plain JSON files until it, too, is migrated.

Guarantees per SQL-backed collection:
  - Reads come from SQLite (what you see is what's stored).
  - Writes commit to SQLite first, then export a canonical JSON MIRROR file at
    the collection's old path — so the hourly git backup keeps producing
    readable diffs and external readers keep working. The mirror is derived
    output; the database is the truth.
  - `mutate()` runs the whole read-modify-write inside one BEGIN IMMEDIATE
    transaction, which is a stronger, simpler version of store.mutate's flock:
    concurrent writers queue on SQLite's write lock (busy_timeout 5s).
  - First touch of a collection that has a legacy JSON file but no DB row
    seeds the row from the file — the same lazy back-fill-on-read migration
    style data_helpers uses, so flipping a collection on requires no script.

Storage model: one `docs` row per collection (name -> JSON text). Deliberately
file-granular for now — it keeps every route's code unchanged and makes the
per-collection flip trivial. Typed tables (real columns, an ops log for sync)
are the next layer and can be introduced per-entity without touching callers.

Multi-user: `_db_path()` is the seam, same rule as store._path() — when users
arrive this becomes DATA_DIR/<user>/exo.db and nothing else moves.

Kill switch: EXOCORTEX_SQL_OFF=1 makes store.py treat SQL_COLLECTIONS as
empty (pure file mode). The mirrors are always current, so flipping back and
forth is safe in either direction.
"""
from contextlib import contextmanager
import json
import sqlite3

import store

_SCHEMA_VERSION = 4


def _db_path():
    """The per-user seam — today one DB beside the JSON files.

    Resolved at call time (not import time) so tests that monkeypatch
    store.DATA_DIR get an isolated database, same as they get isolated files.
    """
    return store.DATA_DIR / "exo.db"


def _connect() -> sqlite3.Connection:
    """Open a connection with the house pragmas, migrated to the latest schema.

    One short-lived connection per operation: the data is tiny, gevent workers
    stay independent, and tests get isolation for free. WAL + busy_timeout is
    what lets the two gunicorn workers (and, later, the agent watcher) share
    the file safely.
    """
    conn = sqlite3.connect(_db_path(), timeout=5, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    _migrate(conn)
    return conn


# Every table a fully-migrated database must have. This is the cross-check that
# makes the version stamp trustworthy — see _migrate.
_EXPECTED_TABLES = (
    "docs",
    "habits", "habit_aliases", "habit_entries",
    "expenses", "expense_categories",
)


def _tables_present(conn):
    found = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN"
        f" ({','.join('?' * len(_EXPECTED_TABLES))})",
        _EXPECTED_TABLES,
    ).fetchone()[0]
    return found == len(_EXPECTED_TABLES)


def _migrate(conn):
    """The one migration ladder for this database file.

    Every module that keeps tables here adds a rung, and the version is stamped
    once at the end — two modules each owning their own `user_version` would
    stamp over each other and silently skip a rung.

    **The stamp alone is not trusted**, because it can lie. Bump
    _SCHEMA_VERSION and the next connection stamps the new number whether or
    not the rung that goes with it exists yet — after which every later
    connection sees "already migrated" and skips it forever. That failed
    silently on the live database: user_version said 4 while the expense tables
    were missing, and nothing noticed until a query for them errored.

    So the fast path requires the stamp AND the tables actually being there;
    anything else re-runs the whole ladder. Every rung is `IF NOT EXISTS`, so
    re-running is a no-op on what already exists and self-heals what doesn't.
    """
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    complete = _tables_present(conn)
    if version >= _SCHEMA_VERSION and complete:
        return
    if not complete:
        version = 0  # the stamp lied — replay every rung
    if version < 1:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS docs ("
            "  name TEXT PRIMARY KEY,"
            "  data TEXT NOT NULL,"
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
    if version < 2:
        # Typed tables, entity #1: habits (see habitstore.py for what fills
        # them). A habit is a ROW with a stable id; its name is an attribute,
        # not its identity. `habit_aliases` maps every log key the app has ever
        # written — legacy bare text AND the current 'section|text' — onto that
        # row, so history stays reachable after a habit is renamed, moved, or
        # dropped from the markdown list entirely.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS habits ("
            "  id INTEGER PRIMARY KEY,"
            "  name TEXT NOT NULL,"
            # Lowercased to match data_helpers.habit_log_key. '' (never NULL)
            # means no current section: SQLite treats NULLs as distinct in a
            # UNIQUE index, so NULL sections would let duplicates right back in.
            "  section TEXT NOT NULL DEFAULT '',"
            "  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),"
            "  started_on TEXT,"
            # Self-referencing FK: the owner's manual "these two were always the
            # same habit" call. rebuild() never sets or clears it, so a merge
            # survives every later rebuild.
            "  merged_into INTEGER REFERENCES habits(id) ON DELETE SET NULL,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  UNIQUE (section, name)"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS habit_aliases ("
            "  alias TEXT PRIMARY KEY,"
            "  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_habit_aliases_habit"
            " ON habit_aliases (habit_id)"
        )
    if version < 3:
        # One row per habit per day — the shape habits_log can't express.
        # `status` exists because the JSON log is pinned to `const: true`
        # (schemas/habits_log.json): unchecking DELETES the key, so absence is
        # its only negative and "didn't do it" is indistinguishable from "wasn't
        # on the list" or "never opened the app". A real column separates them.
        # `source` keeps that honest: 'logged' is what the log actually says,
        # 'inferred' is what habitstore deduced. Never mix them in a claim.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS habit_entries ("
            "  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,"
            "  date TEXT NOT NULL,"
            "  status TEXT NOT NULL CHECK (status IN ('done', 'missed', 'skipped')),"
            "  source TEXT NOT NULL CHECK (source IN ('logged', 'inferred')),"
            "  PRIMARY KEY (habit_id, date)"
            ")"
        )
        # Date-first index: "what happened between these days" scans by date
        # across all habits, which the (habit_id, date) primary key can't serve.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_habit_entries_date"
            " ON habit_entries (date)"
        )
    if version < 4:
        # Typed tables, entity #2: expenses (see expensestore.py). The second
        # entity exists partly to keep the schema-driven UI honest — a generator
        # with only habits to generalise over would be secretly shaped like
        # habits.
        #
        # Category gets its own table rather than staying a repeated string: 15
        # distinct values across 124 rows, and a foreign key is what lets a form
        # render a dropdown instead of a free-text box.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS expense_categories ("
            "  id INTEGER PRIMARY KEY,"
            "  name TEXT NOT NULL UNIQUE"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS expenses ("
            # The blob's uuid, kept verbatim, so a row here and a row there are
            # provably the same expense.
            "  id TEXT PRIMARY KEY,"
            "  date TEXT NOT NULL,"
            # Money as INTEGER CENTS, never a float: 0.1 + 0.2 != 0.3 in binary
            # floating point, and a budget that drifts by fractions of a cent
            # per row is a bug you find months later.
            "  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),"
            # Every amount in the blob is positive, including the ones tagged
            # 'Income' — so sign can't tell money in from money out. This column
            # can.
            "  direction TEXT NOT NULL DEFAULT 'out'"
            "    CHECK (direction IN ('out', 'in')),"
            "  category_id INTEGER REFERENCES expense_categories(id),"
            # The raw bank memo line ('LEASERUNNER LTD 02/08 PURCHASE …').
            "  description TEXT NOT NULL DEFAULT '',"
            "  title TEXT,"
            "  receipt TEXT,"
            "  source TEXT NOT NULL DEFAULT 'manual',"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # Almost every question asked of this table is "over what period" —
        # month, year, since-a-date — so date leads.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_expenses_category"
            " ON expenses (category_id)"
        )
    if version < _SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")


def _seed_from_file(conn, name):
    """Lazy one-time migration: adopt the legacy JSON file as the initial row."""
    legacy = store.file_path(name)
    if not legacy.exists():
        return None
    text = legacy.read_text()
    json.loads(text)  # malformed legacy file -> raise, don't adopt garbage
    conn.execute(
        "INSERT INTO docs (name, data) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
        (name, text),
    )
    return text


def _export_mirror(name, data):
    """Write the canonical JSON mirror at the collection's old file path.

    Derived output only — kept current so git diffs, external readers, and the
    kill switch all keep working. Uses store's atomic file writer directly
    (NOT store.write, which would dispatch right back here).
    """
    store.write_file(name, data)


def open_db():
    """Connection factory for the typed-table modules (habitstore.py).

    Same pragmas and same migration ladder as the blob path — typed tables live
    in the same file, so they must not open it any other way.
    """
    return _connect()


def get(name, default=None):
    conn = _connect()
    try:
        row = conn.execute("SELECT data FROM docs WHERE name = ?", (name,)).fetchone()
        if row is None:
            seeded = _seed_from_file(conn, name)
            if seeded is None:
                return {} if default is None else default
            return json.loads(seeded)
        return json.loads(row[0])
    finally:
        conn.close()


def put(name, data):
    text = json.dumps(data, indent=2, ensure_ascii=False)
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO docs (name, data, updated_at)"
            " VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            " ON CONFLICT(name) DO UPDATE SET"
            "   data = excluded.data, updated_at = excluded.updated_at",
            (name, text),
        )
        conn.execute("COMMIT")
    finally:
        conn.close()
    _export_mirror(name, data)


@contextmanager
def mutate(name, default=None):
    """Read-modify-write one collection inside a single write transaction.

    BEGIN IMMEDIATE takes SQLite's write lock up front, so concurrent mutates
    (other workers, the future agent watcher) serialize instead of losing
    updates. An exception inside the block rolls the transaction back — same
    contract as store.mutate on files (nothing is written).
    """
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT data FROM docs WHERE name = ?", (name,)).fetchone()
        if row is None:
            seeded = _seed_from_file(conn, name)
            data = json.loads(seeded) if seeded is not None else ({} if default is None else default)
        else:
            data = json.loads(row[0])
        yield data
        conn.execute(
            "INSERT INTO docs (name, data, updated_at)"
            " VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            " ON CONFLICT(name) DO UPDATE SET"
            "   data = excluded.data, updated_at = excluded.updated_at",
            (name, json.dumps(data, indent=2, ensure_ascii=False)),
        )
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass  # no transaction active (failed before BEGIN)
        raise
    finally:
        conn.close()
    _export_mirror(name, data)
