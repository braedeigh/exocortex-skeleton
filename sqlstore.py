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

_SCHEMA_VERSION = 7


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
    "files", "file_paths", "commits", "commit_files",
    "sessions", "session_files",
    "cards", "card_tags",
    "todos", "fronts", "todo_fronts", "todo_subtasks",
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
    if version < 5:
        # Typed tables, entity #3: the codebase's own history (see codestore.py
        # for what fills them). Git is the source of truth here — these tables
        # are a queryable INDEX over it, never a second copy anyone edits. Same
        # derived-and-rebuildable contract as habits and expenses, with one
        # twist: the source is two git repos plus the session sidecars, not a
        # JSON blob.
        #
        # A file is a ROW with a stable id; its path is an attribute, not its
        # identity — a rename updates the path and the id survives, which is
        # habit_aliases' identity lesson applied to files. `file_paths` maps
        # every path a file has ever worn onto its row (most recent owner wins
        # when a path is reused).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS files ("
            "  id INTEGER PRIMARY KEY,"
            # 'skeleton' or 'vault' — the two repos Terrain covers. TEXT rather
            # than a table of its own: two values, and the ids are already the
            # public names the terrain payload uses.
            "  repo TEXT NOT NULL,"
            # The path the file wears NOW (or wore last, if deleted). No UNIQUE
            # constraint on purpose: two different files can have worn the same
            # path in different eras, and both eras deserve their own row.
            # Lookups go through file_paths, not this column.
            "  path TEXT NOT NULL,"
            # NULL first_seen means git has never seen it — a session touched a
            # file that was never committed (or not committed yet).
            "  first_seen TEXT,"
            "  last_seen TEXT,"
            # Set when a commit deletes the file, cleared if a later commit
            # brings the path back. NULL = alive.
            "  deleted_at TEXT"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_files_repo_path ON files (repo, path)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS file_paths ("
            "  repo TEXT NOT NULL,"
            "  path TEXT NOT NULL,"
            "  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,"
            "  PRIMARY KEY (repo, path)"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS commits ("
            "  sha TEXT PRIMARY KEY,"
            "  repo TEXT NOT NULL,"
            # Both clocks for the same instant: epoch seconds for maths and the
            # terrain payload, local ISO text for joining against everything
            # else in this system (journal days, habit dates) with strftime.
            "  authored_ts INTEGER NOT NULL,"
            "  authored_at TEXT NOT NULL,"
            "  author TEXT NOT NULL DEFAULT '',"
            "  subject TEXT NOT NULL DEFAULT ''"
            ")"
        )
        # Almost every question is "over what period" — same reasoning as
        # idx_expenses_date.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_commits_repo_ts"
            " ON commits (repo, authored_ts)"
        )
        # The many-to-many-carrying-data shape, third appearance in this file
        # (habit_entries, then expenses→categories, now this). "Which files
        # change together" is a self-join on it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS commit_files ("
            "  sha TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,"
            "  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,"
            # Git's own letter: A added, M modified, D deleted, R renamed-to,
            # C copied-to, T type-changed.
            "  status TEXT NOT NULL DEFAULT 'M',"
            # Line counts from --numstat. NULL means git couldn't count
            # (binary files) — distinct from 0, which means counted-as-zero.
            "  added INTEGER,"
            "  removed INTEGER,"
            "  PRIMARY KEY (sha, file_id)"
            ")"
        )
        # File-first index: "this file's whole history" is the query the
        # (sha, file_id) primary key can't serve.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_commit_files_file"
            " ON commit_files (file_id)"
        )
        # Observatory sessions and which files they touched — the harvest that
        # already exists as bot_chats/footprints.json, made joinable. Wholly
        # derived from the sidecars; codestore.sync_sessions() rebuilds both.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions ("
            "  id TEXT PRIMARY KEY,"
            "  title TEXT NOT NULL DEFAULT '',"
            "  bot TEXT,"
            "  lane TEXT,"
            "  started TEXT,"
            "  last_at TEXT"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS session_files ("
            "  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,"
            "  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,"
            "  writes INTEGER NOT NULL DEFAULT 0,"
            "  reads INTEGER NOT NULL DEFAULT 0,"
            "  creates INTEGER NOT NULL DEFAULT 0,"
            "  last TEXT,"
            "  PRIMARY KEY (session_id, file_id)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_session_files_file"
            " ON session_files (file_id)"
        )
    if version < 6:
        # Typed entity #4: the journal card pool (see cardstore.py for what
        # fills these). The markdown files in the vault stay the single source
        # of truth — these rows are a one-way queryable mirror, same contract
        # as git and the commits table. The three presence columns double as
        # the capture-integrity alarm: a row whose file disappeared is either
        # `deleted_at` (found in the pool's deleted_cards.jsonl cast — a cut
        # the owner asked for) or `missing_since` (no cast — silent loss, the
        # thing the pool promises can never happen, surfaced loudly).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS cards ("
            # The pool's own id, e.g. 2026-08-02.0808b — date.HHMM + who-letter
            # + optional counter. Stable for a card's whole life.
            "  id TEXT PRIMARY KEY,"
            # The journal day, split out of the id so day queries don't need
            # substr(). Indexed: almost every question is 'over what period'.
            "  day TEXT NOT NULL,"
            # Full timestamp from the frontmatter (local, 'YYYY-MM-DD HH:MM:SS').
            "  ts TEXT,"
            # 'B' = the owner, 'K' = the Keeper.
            "  who TEXT NOT NULL DEFAULT 'B',"
            "  kind TEXT,"
            # Card id this one answers (the K-question/B-answer pairing).
            "  reply_to TEXT,"
            "  session TEXT,"
            # refs kept as a JSON list in text — rarely queried, not worth a
            # join table until a real query wants one.
            "  refs TEXT,"
            "  body TEXT NOT NULL DEFAULT '',"
            # Presence tracking (the alarm). first_seen/last_seen are sync
            # clock times, not card times.
            "  first_seen TEXT NOT NULL,"
            "  last_seen TEXT NOT NULL,"
            # Set from the deletion cast when the file is legitimately gone.
            "  deleted_at TEXT,"
            # Set when the file is gone with NO cast. NULL = alive or
            # explained. A non-NULL here is an integrity incident, kept as a
            # row forever so it can't be un-noticed.
            "  missing_since TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cards_day ON cards (day)")
        # Tags are the many-to-many-carrying-nothing shape — a plain pair
        # table, so 'every card tagged x' is one indexed lookup.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS card_tags ("
            "  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,"
            "  tag TEXT NOT NULL,"
            "  PRIMARY KEY (card_id, tag)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags (tag)"
        )
    if version < 7:
        # Typed entity #5: to-dos (see todostore.py for what fills these).
        # `todos.json` stays truth; these rows are a one-way mirror, same
        # contract as habits/expenses.
        #
        # `fronts` is the life-domain registry (fronts.json). It gets a real
        # table rather than a repeated string for the same reason expenses'
        # category did — a foreign key is what lets a form render a dropdown —
        # plus one this data needed on its own: `registered` marks a front id
        # that appears on a to-do but NOT in the registry (the retired
        # junk-drawer tags 'life'/'admin'/'work' still ride four old items).
        # Dropping them would lose data; a flag makes the drift queryable.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS fronts ("
            "  id TEXT PRIMARY KEY,"
            "  name TEXT NOT NULL,"
            "  registered INTEGER NOT NULL DEFAULT 1"
            "    CHECK (registered IN (0, 1)),"
            "  created TEXT"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS todos ("
            # The blob's 8-hex id, kept verbatim. Unique across every bucket
            # today, and the only identity a to-do has ever had.
            "  id TEXT PRIMARY KEY,"
            "  text TEXT NOT NULL DEFAULT '',"
            # Which list it sits in (now/up_next/later/someday/done). An
            # ATTRIBUTE, not the identity — habitstore's lesson: a to-do moved
            # from up_next to done is the same row, so its history survives
            # the move.
            "  bucket TEXT NOT NULL,"
            # Her manual ordering within that bucket. The blob expresses it as
            # array position and nothing else, so it has to be carried or the
            # ordering she set is lost the moment rows leave the list.
            "  position INTEGER NOT NULL,"
            # Kept ALONGSIDE bucket, never collapsed into it: one live item is
            # currently done:true while still sitting in `now` (the sweep only
            # archives yesterday's). Deriving one from the other would erase a
            # real state the app can be in.
            "  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),"
            "  created TEXT,"
            # ONE completion moment, folded from the blob's three competing
            # fields (finished_on / done_at / completed) by todostore's
            # precedence — with `finished_source` naming which one it came
            # from, so a query can never quietly present a legacy day-stamp as
            # a claim about when the thing was actually done. Same honesty rule
            # as habit_entries.source.
            "  finished_on TEXT,"
            "  finished_time TEXT,"
            "  finished_source TEXT"
            "    CHECK (finished_source IN ('claimed', 'marked', 'legacy')),"
            "  finished_note TEXT,"
            "  notes TEXT,"
            "  due_by TEXT,"
            "  due_time TEXT,"
            "  duration_min INTEGER,"
            "  place_id TEXT,"
            "  after_date TEXT,"
            # Deliberately NOT a foreign key: the blob's after_id holds
            # hand-written refs ('homedepot_run') beside real ids, and a
            # dangling pointer here is data about how she works, not
            # corruption to reject.
            "  after_id TEXT,"
            "  status TEXT,"
            "  created_at TEXT NOT NULL"
            "    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # The two questions this table exists to answer: "what got done in this
        # window" and "what's in this bucket, in her order".
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_todos_finished ON todos (finished_on)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_todos_bucket"
            " ON todos (bucket, position)"
        )
        # Same pair-table shape as card_tags on purpose, so a domain can be
        # asked across the journal AND the to-do list in one UNION. Note the
        # limit (todostore.py, decision 3): the two tag vocabularies overlap on
        # almost nothing today, so that query is possible but nearly empty
        # until a front->tags mapping exists.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS todo_fronts ("
            "  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,"
            "  front TEXT NOT NULL REFERENCES fronts(id) ON DELETE CASCADE,"
            "  PRIMARY KEY (todo_id, front)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_todo_fronts_front"
            " ON todo_fronts (front)"
        )
        # Ordered children. Subtask ids are not unique across the blob (some
        # are hand-written slugs like 'sd_desk'), so position carries identity
        # here and the blob's own id rides along as an attribute.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS todo_subtasks ("
            "  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,"
            "  position INTEGER NOT NULL,"
            "  subtask_id TEXT,"
            "  text TEXT NOT NULL DEFAULT '',"
            "  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),"
            "  PRIMARY KEY (todo_id, position)"
            ")"
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
