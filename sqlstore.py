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
    concurrent writers queue on SQLite's write lock. They queue by yielding in
    Python, not by parking inside SQLite — see `begin_immediate` for why that
    distinction is the difference between waiting and failing here.
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
import random
import sqlite3
import time

import store
import tablelog

_SCHEMA_VERSION = 46


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
    # tablelog.Connection is an ordinary connection that also settles the
    # table log when it closes (see tablelog.watch, below).
    conn = sqlite3.connect(_db_path(), timeout=_BUSY_MS / 1000, isolation_level=None,
                           factory=tablelog.Connection)
    conn.execute(f"PRAGMA busy_timeout={_BUSY_MS}")
    # ASK BEFORE SETTING. journal_mode is a persistent property of the FILE, so
    # after the first ever connection the answer is already 'wal' and this is a
    # read that takes no lock at all — which is the whole point, because SETTING
    # it does take one, and does NOT honour busy_timeout: against a database
    # another connection is mid-write on, `PRAGMA journal_mode=WAL` fails
    # instantly with "database is locked" rather than waiting its 250ms.
    #
    # That only bites on a FRESH database — one still in `delete` mode while
    # several connections open it at once and one of them is climbing the
    # migration ladder. It sat here latent until the ladder grew long enough
    # (the code-graph and trace rungs) for the window to be worth hitting, and
    # then it failed about two runs in five.
    if (conn.execute("PRAGMA journal_mode").fetchone() or ("",))[0].lower() != "wal":
        _set_wal(conn)
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _migrate(conn)
    # Note which tables this connection writes, for the Terrain map's table
    # outlines (tablelog.py). Switched on AFTER the ladder, so a replayed
    # ladder's own statements aren't counted as row writes; the ladder reports
    # what it really changed itself, in _migrate. Never raises.
    tablelog.watch(conn)
    return conn


# --- waiting for the write lock ----------------------------------------------
# The app runs under gunicorn's gevent worker, and sqlite3 is a C extension
# gevent cannot patch. So a thread parked in SQLite's busy handler is parked
# for real: the whole worker's event loop stops, and every other greenlet in
# that process — INCLUDING THE ONE HOLDING THE TRANSACTION — is frozen until
# the handler returns.
#
# That inverts what busy_timeout is for. Two concurrent writes in one worker
# used to cost the full five seconds and fail one of them, no matter how
# trivial the work: the waiter blocked the hub, the holder could not be
# scheduled to commit, and the waiter timed out against a transaction its own
# waiting was preventing from finishing. Measured, before this: 0.2s of work,
# 5.01s wall clock, one OperationalError. It ran ~5 times a day on the two
# highest-frequency writers — the usage beacons, which both fire on the same
# navigation.
#
# So the C-level wait is now short enough to be irrelevant, and the real
# waiting happens up in Python where `time.sleep` is monkey-patched and YIELDS
# — which is precisely what lets the holder run and commit.
_BUSY_MS = 250
_LOCK_WAIT_BUDGET = 5.0     # total seconds to keep trying; matches the old ceiling
_LOCK_BACKOFF_START = 0.01
_LOCK_BACKOFF_MAX = 0.2


def _is_locked(exc):
    return "locked" in str(exc).lower() or "busy" in str(exc).lower()


def begin_immediate(conn, budget=_LOCK_WAIT_BUDGET):
    """Take the write lock, yielding between attempts instead of blocking.

    Retrying is safe precisely because a failed BEGIN starts no transaction —
    there is never a half-applied write to clean up, so the only thing a retry
    can duplicate is the waiting.

    Raises the original OperationalError if the budget runs out, so a genuinely
    stuck database still surfaces rather than hanging forever.
    """
    deadline = time.monotonic() + budget
    delay = _LOCK_BACKOFF_START
    while True:
        try:
            conn.execute("BEGIN IMMEDIATE")
            return
        except sqlite3.OperationalError as exc:
            if not _is_locked(exc) or time.monotonic() >= deadline:
                raise
            # Jittered so two waiters woken by the same commit don't collide
            # again in lockstep.
            time.sleep(min(delay, _LOCK_BACKOFF_MAX) * (0.5 + random.random()))
            delay = min(delay * 2, _LOCK_BACKOFF_MAX)


def _set_wal(conn, budget=_LOCK_WAIT_BUDGET):
    """Switch a fresh database into WAL, waiting out a competing writer.

    Same shape as `begin_immediate` above and for the same reason: the waiting
    has to happen up in Python, where it can be retried and (under gevent)
    yields, rather than inside a C-level busy handler that this particular
    pragma doesn't consult anyway. Safe to retry — the pragma is idempotent,
    and a connection that loses the race simply finds the winner's 'wal' on the
    next pass."""
    deadline = time.monotonic() + budget
    delay = _LOCK_BACKOFF_START
    while True:
        try:
            conn.execute("PRAGMA journal_mode=WAL").fetchall()
            return
        except sqlite3.OperationalError as exc:
            if not _is_locked(exc) or time.monotonic() >= deadline:
                raise
            time.sleep(min(delay, _LOCK_BACKOFF_MAX) * (0.5 + random.random()))
            delay = min(delay * 2, _LOCK_BACKOFF_MAX)


# Every table a fully-migrated database must have. This is the cross-check that
# makes the version stamp trustworthy — see _migrate.
_EXPECTED_TABLES = (
    "docs",
    "habits", "habit_aliases", "habit_entries",
    "expenses", "expense_categories",
    "files", "file_paths", "commits", "commit_files",
    "sessions", "session_files", "session_turns",
    "cards", "card_tags",
    "todos", "fronts", "todo_fronts", "todo_subtasks", "todo_agent_notes",
    "job_runs",
    "attention_segments",
    "tags",
    "filer_nominations", "filer_verdicts",
    "command_runs", "command_sources",
    "code_files", "code_edges",
    "traces", "trace_spans",
    "notes", "note_judgments",
    "tool_calls", "tool_call_sources", "turn_results", "turn_usage", "ui_events", "requests",
    "foods", "food_names", "products", "receipt_names", "food_links",
    "recipe_makes", "meal_rotation",
    "recipes", "recipe_lines", "shopping_trips", "shopping_lines", "grocery_list",
    "receipts",
    "food_sources", "food_source_counties", "food_estimates", "source_requests",
    "source_proposals", "source_proposal_counties", "source_proposal_parts",
    "source_proposal_evidence", "source_proposal_regions",
    # The journal word index, plus the five storage tables FTS5 keeps behind it.
    "cards_fts", "cards_fts_data", "cards_fts_idx", "cards_fts_content",
    "cards_fts_docsize", "cards_fts_config",
    "research_topics", "research_topic_fronts",
    "research_entries", "research_entry_topics", "research_entry_context",
    "research_sessions", "research_session_entries", "research_session_topics",
    "research_annotations", "claim_sources", "claim_values",
    "hazards", "hazard_names", "hazard_parents", "hazard_measures",
    "food_judgments", "judgment_grounds", "hazard_history", "research_tables",
    # The agents' mailbox, token accounting per model call, and swarms.
    "agent_messages", "model_calls", "swarms", "swarm_members", "swarm_helper_runs",
    "session_summaries", "swarm_pins", "room_moves", "room_helper_runs",
    # Verifiable exposure scores (rung 36).
    "hazard_facts", "food_pdp_codes", "data_pulls", "exposure_scores", "exposure_terms",
    "source_files", "passage_pages",
    # Recipe nutrients: which USDA entry a food is, and her gram weights (rung 39).
    "food_usda", "recipe_line_grams",
    # What the helpers promised to keep an eye on (rung 40).
    "helper_watches",
    # Which pairs of sessions are in the same file (rungs 42–43).
    "file_alerts",
    # What other people did in Linear, as the feed noticed it (rung 44).
    "linear_events",
    # What each swarm did, written when it closed (rung 45).
    "swarm_closings",
    "spinoff_briefs", "spinoff_contexts", "spinoff_handoffs",
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
    anything else re-runs the whole ladder. Almost every rung is
    `IF NOT EXISTS`, so re-running is a no-op on what already exists and
    self-heals what doesn't — the exception is v9, which DROPs and recreates
    `session_turns` on purpose.

    **The ladder runs inside the write lock**, and that exception is why. Two
    connections opening a database that isn't migrated yet both saw work to
    do and both climbed at once, so one of them ran v9's bare CREATE against
    a table the other had just made: `table session_turns already exists`,
    about half the time on a fresh install. Only a fresh install — an
    already-migrated database returns on the fast path above and never gets
    here — which is exactly why it went unnoticed. The version and the table
    check are re-read once the lock is held, so the loser of the race sees
    the winner's finished work and does nothing.
    """
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    complete = _tables_present(conn)
    if version >= _SCHEMA_VERSION and complete:
        return

    begin_immediate(conn)
    try:
        # Tell the table log which tables the ladder created or redefined.
        # Compared by each table's stored definition before and after, because
        # the rungs are `IF NOT EXISTS` and re-run freely: only a definition
        # that is new or different is a real change.
        before = _table_definitions(conn)
        _run_ladder(conn)
        after = _table_definitions(conn)
        conn.execute("COMMIT")
        tablelog.structure_changed(
            [name for name, sql in after.items() if before.get(name) != sql])
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass
        raise


def _table_definitions(conn):
    """Every table's name and the CREATE statement SQLite holds for it — an
    ALTER TABLE rewrites that text, so a changed definition shows up here."""
    return dict(conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table'"
        " AND name NOT LIKE 'sqlite_%'"))


def _run_ladder(conn):
    """The rungs themselves. Called only with the write lock held."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    complete = _tables_present(conn)
    if version >= _SCHEMA_VERSION and complete:
        return  # another connection climbed it while we waited for the lock
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
            # 'B' = the owner, 'K' = the Keeper, 'S' = the system (a reminder
            # the app sent — neither of theirs). Free text, so no migration.
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
    if version < 8:
        # When she was actually TALKING to an agent — one row per message she
        # sent, harvested from the conversation transcripts by
        # codestore.sync_turns().
        #
        # Why this exists when `sessions` already has started/last_at: a
        # session is a container, not an activity. A third of them stay open
        # more than twelve hours and two dozen span more than a day, so
        # "started 10am, last_at 4am" says almost nothing about when she was
        # at the keyboard. A turn is the real event, and there are eleven of
        # them for every session.
        #
        # NO PROMPT TEXT. Only the moment. What she typed lives in the
        # transcript (and, when she journals it, in the card pool); this table
        # exists to be drawn on a time axis, and text it doesn't need is text
        # a mirror has no business holding.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS session_turns ("
            "  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,"
            # Position in the transcript. Part of the key because two messages
            # sent inside the same second are two turns, not one — the clock
            # here is second-resolution and she does send twice in a second.
            "  seq INTEGER NOT NULL,"
            # LOCAL naive ISO, exactly as the transcript writes it — the same
            # clock `cards.ts` and `commits.authored_at` keep.
            "  ts TEXT NOT NULL,"
            "  PRIMARY KEY (session_id, seq)"
            ")"
        )
    if version < 9:
        # session_turns gains `journaled`: was this message one she PUT IN THE
        # JOURNAL? The capture hook writes the flag onto the turn as it mints
        # the card, so it's the pool's own answer rather than a guess — 97% of
        # flagged turns have a matching card within two minutes, and the flag
        # never appears on a session rooted in the app checkout.
        #
        # It exists so the pond can draw the working half WITHOUT redrawing the
        # journal: a message that became a card is already a dot in the left
        # lane, and drawing it again on the right makes one afternoon look like
        # two. Recorded either way — the filtering is a reading decision, made
        # by whoever queries, never by dropping rows.
        #
        # DROP and recreate rather than ALTER: this table is derived wholesale
        # from the transcripts by codestore.sync_turns() on every run, so
        # rebuilding it costs nothing and stays idempotent if the ladder
        # replays (an ALTER would raise the second time through).
        conn.execute("DROP TABLE IF EXISTS session_turns")
        conn.execute(
            "CREATE TABLE session_turns ("
            "  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,"
            "  seq INTEGER NOT NULL,"
            "  ts TEXT NOT NULL,"
            "  journaled INTEGER NOT NULL DEFAULT 0"
            "    CHECK (journaled IN (0, 1)),"
            "  PRIMARY KEY (session_id, seq)"
            ")"
        )
    if version < 10:
        # Entity #6: what the system's ~19 scheduled jobs actually DID (see
        # jobstore.py for what fills this). Every other table in this file is
        # DERIVED — wipe it and re-walk git, the markdown, or a JSON blob and
        # you get it back. **This one cannot be.** A job run is an event that
        # happened once; when it's over the only evidence it ever existed is
        # the row it wrote. So:
        #
        #   - NEVER add job_runs to routes/sqlab.py's rebuild button. Every
        #     other rebuild only reads its source; a rebuild here would delete
        #     history that exists nowhere else.
        #   - jobstore.export_day() writes a JSON mirror per sealed day under
        #     data/job_runs/, so the vault's hourly git commit is the backup.
        #
        # Why it exists: the state was stored and the DECIDING was not. "28% of
        # cards carry no tag" was answerable; "did the 2 AM swarm run on July
        # 17th, and did it look at those cards and decline them, or did it
        # never wake up" was not — cricket_swarm.sh writes a text log and
        # nothing else. Three different failures, three different fixes, and no
        # way to tell them apart. That's what this table is for.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS job_runs ("
            "  id INTEGER PRIMARY KEY,"
            # Matches the `id` in scheduled_runs.json where the job has an
            # entry there, so the Automations page can join the two.
            "  job TEXT NOT NULL,"
            # LOCAL naive ISO ('YYYY-MM-DDTHH:MM:SS') — the same clock
            # cards.ts, session_turns.ts and commits.authored_at keep, NOT the
            # UTC that session_files.last uses. Mixing them draws work five
            # hours off and looks entirely plausible, so this column picks one
            # and says which.
            "  started TEXT NOT NULL,"
            # NULL means the run never closed: it's still going, or it DIED —
            # OOM, a killed cgroup, the box rebooted. An open row older than
            # the job's own schedule is the silent-failure alarm, and it only
            # works because the row is written at START, not at finish.
            "  finished TEXT,"
            #   running — opened, not yet closed (see above)
            #   ok      — did work
            #   noop    — woke up, found nothing to do (the common case for the
            #             three every-minute jobs)
            #   failed  — raised, or reported a nonzero result
            #   skipped — deliberately stood down (the Automations `enabled`
            #             toggle is off), which is NOT a failure
            "  status TEXT NOT NULL"
            "    CHECK (status IN ('running','ok','noop','failed','skipped')),"
            # How many no-op runs this row stands for. Three jobs run every
            # minute and on almost every tick do nothing; a row each is ~1.5M
            # rows a year of noise wrapped around the few thousand that matter.
            # So consecutive no-ops inside one clock hour collapse onto one
            # heartbeat row and bump this instead (jobstore._close). "Was it
            # alive at 4am" stays answerable; the noise doesn't accumulate.
            "  ticks INTEGER NOT NULL DEFAULT 1,"
            # What it DECIDED, in three counters every job can express:
            # considered / changed / errored on. Generic on purpose — the
            # alternative is a bespoke column set per job, and 19 jobs would
            # never all get one. NULL means the job doesn't count that (which
            # is honestly different from 0, same rule as commit_files.added).
            "  looked INTEGER,"
            "  acted INTEGER,"
            "  failed INTEGER,"
            "  note TEXT,"
            # Optional JSON for anything the three counters can't carry. Kept
            # as text, unqueried for now — a column to grow into, not a promise.
            "  detail TEXT"
            ")"
        )
        # "This job's history" and "everything that ran in this window" — the
        # two questions, same reasoning as idx_commits_repo_ts.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_job_runs_job_started"
            " ON job_runs (job, started)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_job_runs_started"
            " ON job_runs (started)"
        )
    if version < 11:
        # Entity #7: WHEN she was looking at what (see attentionstore.py).
        # feature_usage already counts dwell, but only as a per-day total per
        # tab — "90 minutes of observatory on Sunday" can't be laid beside a
        # file write or a journal card, because it has no clock. A segment is
        # one contiguous run of active attention, so this table gives that
        # number a beginning and an end.
        #
        # DERIVED, unlike job_runs above: the record is an append-only JSONL
        # per day under data/attention/, which the vault's hourly git commit
        # backs up for free. Wipe this table and attentionstore.rebuild()
        # walks it back. That keeps the invariant job_runs had to break —
        # everything in exo.db except job_runs can be re-derived from a
        # source that isn't SQLite.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS attention_segments ("
            "  id INTEGER PRIMARY KEY,"
            # The tab's own name, same vocabulary feature_usage's "time" key
            # uses, so the two can be compared directly.
            "  tab TEXT NOT NULL,"
            # The conversation, when the tab was an agent chat — joins to
            # sessions.id, and through it to session_turns.journaled, which
            # is what makes "how long did I journal" a query. NULL everywhere
            # else, and also on a chat too new to have an id in its url yet.
            "  conv TEXT,"
            # LOCAL naive ISO, the clock cards.ts / session_turns.ts /
            # job_runs.started keep — NOT the UTC session_files.last uses.
            # Drawing this lane against the working lane in the wrong clock
            # puts her evening five hours into the next morning and looks
            # entirely plausible, so the conversion happens once, on the way
            # in (attentionstore._local), and never again.
            "  started TEXT NOT NULL,"
            "  ended TEXT NOT NULL,"
            # The journal day this belongs to: the date part of `started`,
            # split out so day queries don't need substr(). Same trick as
            # cards.day.
            "  day TEXT NOT NULL"
            ")"
        )
        # Deliberately NO `seconds` column. A segment only ever accumulates
        # while the dwell clock is running, and the clock stopping is what
        # ENDS a segment — so active seconds and (ended - started) are the
        # same quantity, and storing both invites them to disagree.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attention_day"
            " ON attention_segments (day)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attention_conv"
            " ON attention_segments (conv)"
        )
        # Re-deriving a day means deleting it first; without this the wipe
        # half of an incremental update scans the whole table.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attention_started"
            " ON attention_segments (started)"
        )
    if version < 12:
        # Entity #8: the universal tags table (see docs/tags-architecture.md,
        # the design of record this rung implements verbatim). Every subject
        # in the system — cards, todos, files, research entries, threads —
        # gets one namespaced tagging surface instead of a fourth bespoke
        # dialect (card_tags free strings, todo_fronts FK-only, research.json
        # topics[].fronts each invented separately). `ns` is what makes "other
        # structures I may assign" free: a new namespace is a new value, zero
        # schema changes. `source` keeps taxonomies sweepable — 'derived' rows
        # can be regenerated by re-running the backfill at any time, 'manual'
        # rows are the owner's hand and are never bulk-deleted, 'cricket' rows
        # came through a propose queue. The old junctions (card_tags,
        # todo_fronts) stay put; this is additive, not a replacement.
        #
        # Prompt that produced this table: "one universal namespaced tags
        # table so every subject in the system — cards, todos, files, research
        # entries, threads — can be tagged and searched like a wiki by front,
        # topic, and any future structure".
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tags ("
            "  subject TEXT NOT NULL,"
            "  ns      TEXT NOT NULL,"
            "  tag     TEXT NOT NULL,"
            "  source  TEXT NOT NULL DEFAULT 'manual'"
            "          CHECK (source IN ('manual', 'derived', 'cricket')),"
            "  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  PRIMARY KEY (subject, ns, tag)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS tags_by_tag     ON tags (ns, tag)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS tags_by_subject ON tags (subject)"
        )
    if version < 13:
        # Entity #9: what the FILER proposed and what she decided about it —
        # the training record (see filerstore.py for what fills these).
        #
        # These join job_runs as the second and third tables here that are NOT
        # derived, and the same two consequences follow: never add them to
        # routes/sqlab.py's rebuild button, and filerstore.export_day() mirrors
        # sealed days to JSON so the vault's hourly commit is the real backup.
        # A nomination is an event; when it's over the row is the only evidence.
        #
        # Why TWO tables instead of a verdict column. The owner's stated use is
        # to train a model on her filing decisions eventually, and for that the
        # REJECTIONS and REDIRECTS carry more signal than the accepts: an
        # accept-only record has no negative examples, so it cannot teach where
        # the boundary is. A redirect is the richest row of all — it carries
        # both the wrong answer and the right one. And a mind CHANGED later is
        # signal too, so verdicts are append-only in their own table rather
        # than a column that overwrites. `filer_nominations.verdict` is a
        # denormalized copy of the latest verdict, kept for cheap querying;
        # filer_verdicts is the record of authority.
        #
        # Prompt that produced these tables: "retain as much information about
        # my decisions and what it does so that I can train ML on it
        # eventually ... whatever best practices are that gets me the most and
        # best organized data".
        conn.execute(
            "CREATE TABLE IF NOT EXISTS filer_nominations ("
            "  id INTEGER PRIMARY KEY,"
            # Which run produced it — joins straight to the job ledger, so
            # "what did the filer do on the 4th" is one query.
            "  run_id INTEGER REFERENCES job_runs(id) ON DELETE SET NULL,"
            # The file's IDENTITY, not its location. codestore's files/
            # file_paths pair already survives renames (path is an attribute,
            # not identity), which is exactly what a filer needs: once she
            # accepts a move, the nomination still points at the same file at
            # its new home instead of orphaning.
            "  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,"
            # Where it lived WHEN NOMINATED. Kept alongside file_id because the
            # question "what did it look like before we moved it" has to stay
            # answerable even if the identity layer is rebuilt.
            "  path TEXT NOT NULL,"
            # Content identity. Survives a rename AND a re-upload of the same
            # bytes under a new name — which is the shape of the duplicate
            # problem in the archive (one photo, three uploads, three names).
            "  sha256 TEXT,"
            # LOCAL naive ISO, the same clock job_runs.started keeps. Stated
            # here for the same reason it's stated there: session_files.last is
            # UTC, and mixing them looks entirely plausible while being wrong.
            "  observed TEXT NOT NULL,"
            # Which model decided. A verdict is only training data if you know
            # what produced the proposal it judged.
            "  model TEXT,"
            # The model's own description of what it saw, in its words. Not a
            # label — the raw read, which is what makes a later disagreement
            # diagnosable ("it misread the document" vs "it read it right and
            # filed it wrong" are different failures).
            "  saw TEXT,"
            # JSON: {destination, front, action}. JSON rather than columns
            # because the destination vocabulary will move and a schema change
            # per new filing target is how this stops getting used.
            "  proposal TEXT NOT NULL,"
            "  reasoning TEXT,"
            "  confidence REAL,"
            # JSON array of the options it considered and DIDN'T pick, with
            # their scores. The runner-up is where the decision boundary
            # actually lives; it is free to record now and impossible later.
            "  alternatives TEXT,"
            # Denormalized copy of the latest filer_verdicts row (or 'pending'
            # when she hasn't ruled yet), so the review queue is one cheap
            # query. filer_verdicts stays the record of authority.
            "  verdict TEXT NOT NULL DEFAULT 'pending'"
            "    CHECK (verdict IN ('pending','accepted','rejected','redirected')),"
            # Whether the file was actually MOVED, which is deliberately
            # separate from whether she accepted: accepted-but-not-yet-applied
            # is a real state, and conflating them is how a crash mid-apply
            # becomes invisible.
            "  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),"
            "  applied_at TEXT"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS filer_verdicts ("
            "  id INTEGER PRIMARY KEY,"
            "  nomination_id INTEGER NOT NULL"
            "    REFERENCES filer_nominations(id) ON DELETE CASCADE,"
            "  verdict TEXT NOT NULL"
            "    CHECK (verdict IN ('accepted','rejected','redirected')),"
            "  at TEXT,"
            # Who ruled. 'her' is the only value that counts as ground truth
            # for training; anything else is a machine agreeing with itself and
            # must be filterable out of the training set.
            "  by TEXT NOT NULL DEFAULT 'her',"
            "  note TEXT,"
            # JSON, redirects only: where it SHOULD have gone. This is the
            # single most valuable column in either table.
            "  corrected TEXT"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS filer_nom_pending"
            " ON filer_nominations (verdict, observed)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS filer_nom_by_file"
            " ON filer_nominations (file_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS filer_verdicts_by_nom"
            " ON filer_verdicts (nomination_id, at)"
        )
    if version < 14:
        # Provenance on to-dos (todo_provenance.py): who created each item
        # and, for agent-left notes, who said it and what it cites. Three
        # columns on `todos` — added with ALTER so the rung is re-runnable
        # (a replayed ladder hits "duplicate column", which is the one
        # error we swallow) — plus one row per agent note. `refs` is a JSON
        # list; the citation is the whole point of the note, so it is never
        # dropped in the mirror even though SQLite can't index into it.
        for col in ("origin_by TEXT", "origin_at TEXT", "origin_conv TEXT"):
            try:
                conn.execute(f"ALTER TABLE todos ADD COLUMN {col}")
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e):
                    raise
        conn.execute(
            "CREATE TABLE IF NOT EXISTS todo_agent_notes ("
            "  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,"
            "  position INTEGER NOT NULL,"
            "  by TEXT NOT NULL,"
            "  at TEXT,"
            "  text TEXT NOT NULL,"
            "  refs TEXT NOT NULL DEFAULT '[]',"
            "  conv TEXT,"
            "  PRIMARY KEY (todo_id, position)"
            ")"
        )
    if version < 15:
        # Which slash commands the owner actually runs (commandstore.py).
        # DERIVED, like the habit tables and unlike job_runs: every row is
        # re-readable from the Claude Code transcripts on disk, so this pair
        # can be dropped and rebuilt without losing anything. `uuid` is the
        # transcript message's own id, which is what makes ingest idempotent
        # — the same line read twice inserts once.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS command_runs ("
            "  uuid TEXT PRIMARY KEY,"
            "  at TEXT,"
            "  day TEXT NOT NULL,"
            "  hour INTEGER NOT NULL,"
            "  name TEXT NOT NULL,"
            "  kind TEXT NOT NULL,"
            "  session_id TEXT,"
            "  cwd TEXT,"
            "  arg_chars INTEGER NOT NULL DEFAULT 0"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS command_runs_by_day ON command_runs (day)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS command_runs_by_name"
            " ON command_runs (name, at)"
        )
        # The incremental watermark: how far into each transcript we have
        # already read. Transcripts are append-only JSONL, so a file whose
        # size is unchanged has nothing new, and one that grew is re-opened
        # at `size` rather than from the top. Without this every rollup
        # re-read 1.7 GB to find a handful of new lines.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS command_sources ("
            "  path TEXT PRIMARY KEY,"
            "  size INTEGER NOT NULL,"
            "  scanned_at TEXT NOT NULL"
            ")"
        )
    if version < 16:
        # The codebase's own SHAPE — every code file, and every dependency
        # between them (codegraph.py). DERIVED, like the habit tables: every
        # row is re-readable by re-parsing the source, so this pair can be
        # dropped and rebuilt without losing anything.
        #
        # Deliberately keyed by (repo, path) STRINGS rather than joined to
        # files(id). The two tables answer different questions and disagree on
        # purpose: `files` is git's view (identity that survives renames, and
        # every file git has ever seen, including deleted ones), while this is
        # the view of the code as it stands on disk RIGHT NOW — including files
        # git has never seen. Giving this one its own key means neither can
        # corrupt the other's answer; join on (repo, path) when a query wants
        # both.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS code_files ("
            "  repo TEXT NOT NULL,"
            "  path TEXT NOT NULL,"
            # 'python' | 'ts' | 'tsx' | 'js' | 'jsx' | 'css' — what the parser
            # treated it as, which is also which resolver drew its edges.
            "  lang TEXT NOT NULL,"
            "  lines INTEGER NOT NULL DEFAULT 0,"
            # How many edges leave and arrive. Denormalized on purpose: "what
            # is a hub" and "what is dead" are the two questions this table
            # exists to answer instantly, without a GROUP BY over the edges.
            "  out_degree INTEGER NOT NULL DEFAULT 0,"
            "  in_degree INTEGER NOT NULL DEFAULT 0,"
            "  parsed_at TEXT NOT NULL,"
            # Set when the file could not be parsed — kept as a ROW with a
            # reason rather than dropped, so "every piece of code" stays
            # literally true and a parser gap is visible instead of silent.
            "  parse_error TEXT,"
            "  PRIMARY KEY (repo, path)"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS code_edges ("
            "  repo TEXT NOT NULL,"
            "  src TEXT NOT NULL,"
            # The destination's repo — '' means EXTERNAL (a third-party
            # package: flask, react, d3-force). Those edges are kept rather
            # than dropped: "what does this file reach out to" is the same
            # question whether the answer is in the repo or not, and a caller
            # that only wants internal flow filters on dst_repo != ''.
            "  dst_repo TEXT NOT NULL,"
            "  dst TEXT NOT NULL,"
            # 'import' — a static dependency read out of the source.
            "  kind TEXT NOT NULL,"
            # JSON array of the names crossing this edge ('mutate', 'DATA_DIR',
            # 'useState'). This is the part that makes an edge readable rather
            # than merely present: not just "server.py touches store.py" but
            # which of store's surface it actually uses.
            "  symbols TEXT NOT NULL DEFAULT '[]',"
            "  PRIMARY KEY (repo, src, dst_repo, dst, kind)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS code_edges_by_dst"
            " ON code_edges (dst_repo, dst)"
        )
    if version < 17:
        # One captured request, followed through the code in order
        # (runtime_trace.py). NOT derived and NOT re-derivable: a trace is a
        # recording of a moment that has passed, which is the opposite of
        # code_files/code_edges beside it. It is bounded by retention instead —
        # runtime_trace.KEEP_TRACES newest survive, the rest are dropped on
        # write, because a debugging artifact that grows forever becomes the
        # thing it was meant to diagnose.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS traces ("
            "  id TEXT PRIMARY KEY,"
            "  label TEXT NOT NULL DEFAULT '',"
            # 'http' | 'turn' | 'manual' — where the trace was taken. A send
            # produces both an http trace and a turn trace SHARING one id, so
            # the two processes' halves read as one path.
            "  kind TEXT NOT NULL,"
            # What was being done: 'POST /api/observatory/conversation/x/send'.
            "  entry TEXT NOT NULL DEFAULT '',"
            "  started_at TEXT NOT NULL,"
            "  duration_us INTEGER NOT NULL DEFAULT 0,"
            "  span_count INTEGER NOT NULL DEFAULT 0,"
            # Set when the trace hit MAX_SPANS. A truncated trace is still
            # useful, but it must never be mistaken for a complete one.
            "  truncated INTEGER NOT NULL DEFAULT 0,"
            "  pid INTEGER,"
            # A trace that continues in ANOTHER PROCESS is its own row pointing
            # back here, not more spans on this one. It has to be: the two
            # processes have independent perf_counter origins, so their t0_us
            # columns are not on the same clock and laying them end to end
            # would draw a timeline that never happened. Parent + parts is the
            # honest shape — "this request, and the turn it spawned".
            "  parent_id TEXT"
            ")"
        )
        # Self-heal a `traces` made before parent_id existed. A create that
        # tolerates an existing table skips it entirely, so a column added to
        # this rung AFTER the table was first created never lands — and the
        # miss stays invisible until something forces a replay. It surfaced
        # here as the index below failing with "no such column: parent_id" on
        # a database whose traces table had nine columns instead of ten.
        # Same ALTER-and-swallow-duplicate shape rung 14 uses.
        try:
            conn.execute("ALTER TABLE traces ADD COLUMN parent_id TEXT")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
        conn.execute(
            "CREATE INDEX IF NOT EXISTS traces_by_parent ON traces (parent_id)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS trace_spans ("
            "  trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,"
            "  seq INTEGER NOT NULL,"
            "  depth INTEGER NOT NULL,"
            # NULL src = the call came from outside our code entirely (Flask
            # dispatch, the interpreter). That is an ENTRY POINT, and it is the
            # row that answers "where does this actually get in".
            "  src_repo TEXT,"
            "  src TEXT,"
            "  src_func TEXT,"
            "  dst_repo TEXT NOT NULL,"
            "  dst TEXT NOT NULL,"
            "  dst_func TEXT NOT NULL,"
            # Microseconds from the start of the trace, so spans are comparable
            # without anyone having to parse a timestamp.
            "  t0_us INTEGER NOT NULL,"
            "  t1_us INTEGER,"
            "  PRIMARY KEY (trace_id, seq)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS trace_spans_by_dst"
            " ON trace_spans (dst_repo, dst)"
        )
    if version < 18:
        # Entity #9: her notes, one row each (see notestore.py). Every other
        # typed table in this file is a REPORT rebuilt from a blob in `docs`;
        # this is the first one that is the DESTINATION — the app writes here,
        # and dev_notes.json / idea_notes.json become photographs of these rows
        # rather than the other way round. There is deliberately no rebuild():
        # there would be nothing to rebuild from.
        #
        # Dev notes and idea notes share ONE table, told apart by `kind`,
        # because "send this to ideas" then becomes an UPDATE of one column.
        # The old move — delete from one document, append to the other — kept
        # the note's id and date only because the code remembered to. Here the
        # row never moves, so keeping them is not something anyone can forget.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notes ("
            # Which of the two panels the note lives in: friction ('dev') or a
            # want ('idea').
            "  kind TEXT NOT NULL CHECK (kind IN ('dev','idea')),"
            # Her note's permanent id. Text with NO shape rule: almost all are
            # 8 hex characters from secrets.token_hex(4), but one was typed by
            # hand ('store-future'), and a format check would refuse it.
            "  id TEXT NOT NULL,"
            # Which page's panel she wrote it on. Free text on purpose — mostly
            # the same slugs the `page` tags use, plus four that are not pages
            # at all ('global', 'general', 'rodeo', 'usage'). A CHECK listing
            # the real pages would refuse a note on any of those.
            "  page TEXT NOT NULL,"
            "  text TEXT NOT NULL,"
            # 'YYYY-MM-DD HH:MM', local, exactly as the document stores it. NOT
            # converted to a real timestamp: the conversion would have to invent
            # a timezone and seconds that were never recorded, and this string
            # already sorts correctly as text.
            "  created TEXT,"
            # Where the note sits in its page's list. A table is a bag of rows
            # with no order of its own, and `created` cannot supply one — six
            # pairs of notes share a minute, one of which is a note beginning
            # '^' that refers to the note above it. This is also the column a
            # drag-to-rearrange would write.
            "  position INTEGER NOT NULL,"
            # The night crew's question, when a worker could not tell what the
            # note meant (scripts/nightcrew_run.py). Cleared when she edits the
            # text, because her amended words answer the ask. A COLUMN rather
            # than a table on purpose: one blob of prose, one per note, never
            # filtered or searched — a table would hold exactly one row per
            # parent and nothing to join on.
            "  questions TEXT,"
            # Any key a writer puts on a note that has no column here, kept
            # verbatim as JSON. A blob took any shape for free; a table does
            # not, and quietly dropping a field some later feature adds would
            # be data loss nothing announces. Empty for all 192 notes today —
            # if it is ever filled, that is the signal something wants a real
            # column.
            "  extra TEXT,"
            # When this ROW last changed — not when she wrote the note. Never
            # appears in the exported document.
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            # (kind, id) rather than id alone, because the two kinds really do
            # overlap for one write: undoing a send-to-ideas puts the note back
            # in dev notes and SAVES before removing it from ideas
            # (routes/devnotes.py), so for that moment the same id is both.
            "  PRIMARY KEY (kind, id)"
            ")"
        )
        # The one question every reader asks: give me this page's notes, in
        # order. Matches the ORDER BY as_document() uses.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS notes_by_page"
            " ON notes (kind, page, position)"
        )
        # What she decided about a note, and when — the append-only record
        # devnote_judgments.py describes, now rows instead of a list inside the
        # note. Its own table because a note has a GROWING LIST of judgments,
        # and a column holds one value: the alternative is JSON in a column,
        # which is the blob problem this rung exists to end.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS note_judgments ("
            "  note_kind TEXT NOT NULL,"
            "  note_id TEXT NOT NULL,"
            # Which judgment this is: 1st, 2nd, 3rd. Load-bearing, because the
            # LAST entry is the note's current verdict and `at` cannot order
            # them — it is stamped to the minute, and changing her mind twice
            # inside one minute is an ordinary thing.
            "  seq INTEGER NOT NULL,"
            "  verdict TEXT NOT NULL"
            "    CHECK (verdict IN ('approved','unsure','denied','open')),"
            # Her own words about the ruling. The document calls this key
            # `note`; renamed here because `note` beside `note_id` in a table
            # called note_judgments reads as the wrong thing.
            "  comment TEXT,"
            # 'outdated' or 'completed', and only on a denial. A closed
            # vocabulary is what makes denials countable — the point of
            # recording them is to see how many notes died of rot versus of
            # already being done.
            "  reason TEXT,"
            # Minute-resolution, and in two formats across her history
            # ('2026-05-14 08:02' and '2026-08-06T13:15'). Kept verbatim: the
            # record should not look tidier than it was.
            "  at TEXT,"
            # Who appended it. Live values: 'her' (she tapped), 'card' (the
            # morning card), 'review' (a pass that re-read her own comments and
            # downgraded four approvals). 'moon' and 'edit' exist in the code
            # and have never fired. This column is what keeps a judgment made
            # on her behalf from reading as one she made.
            "  by TEXT,"
            # Same safety valve as `extra` on notes above.
            "  extra TEXT,"
            "  PRIMARY KEY (note_kind, note_id, seq),"
            # Delete a note and its rulings go with it, enforced here rather
            # than by every caller remembering. Needs PRAGMA foreign_keys=ON,
            # which _connect sets.
            "  FOREIGN KEY (note_kind, note_id) REFERENCES notes(kind, id)"
            "    ON DELETE CASCADE"
            ")"
        )
    if version < 19:
        # Entity #10: the usage record, event by event (the four tables below
        # share one idea, so they share one rung). Until now most of what the
        # owner did was counted at write time — clicks per page per DAY,
        # requests per feature per DAY — and a count has no clock: it cannot
        # be laid beside a journal card or a file write, and it cannot be
        # asked a question it wasn't shaped for. Every counter can be rebuilt
        # from events; no event can be rebuilt from a counter. So these
        # tables keep the events, and the counters become a view of them.
        #
        # One clock for all four: LOCAL naive ISO with milliseconds
        # ('2026-09-24T12:56:29.403'), the clock attention_segments keeps,
        # with the fraction kept because tool calls land several to a second
        # and their order matters. String-comparable with every other table.
        #
        # Which agent tool ran, on what, and how it went (toolcallstore.py).
        # DERIVED: every row is re-readable from the conversation logs under
        # data/bot_chats/ and from Claude Code's own transcripts under
        # ~/.claude/projects, so the table can be dropped and rebuilt. The
        # tool call's own id is the key, and it is the same id in both
        # sources, which is what lets the two be walked without counting the
        # Observatory's turns twice.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tool_calls ("
            "  tool_use_id TEXT PRIMARY KEY,"
            # Which record it was first read from: 'observatory' (bot_chats)
            # or 'claude' (the harness's transcripts). A tmux or terminal
            # session only ever has the second.
            "  source TEXT NOT NULL,"
            # The Observatory conversation, when this was one — joins to
            # sessions.id, and through it to lane. NULL for terminal work.
            "  conv TEXT,"
            # Claude Code's own session uuid, present in both sources.
            "  session_id TEXT,"
            # The Agent call this ran under, when a subagent made it.
            "  parent_tool_use_id TEXT,"
            "  at TEXT NOT NULL,"
            "  day TEXT NOT NULL,"
            "  hour INTEGER NOT NULL,"
            "  name TEXT NOT NULL,"
            # The one handle worth an index: the file for Read/Edit/Write,
            # the command for Bash, the pattern for Grep/Glob, the url for a
            # fetch. Bounded to a few hundred characters.
            "  target TEXT,"
            # The whole input as JSON, capped (input_truncated says when).
            # This is the granular part: the command that ran, the edit that
            # was made. It is the owner's own record and lives in her vault.
            "  input TEXT,"
            "  input_truncated INTEGER NOT NULL DEFAULT 0,"
            # Filled in when the matching tool_result line is read. NULL
            # means the result never came back (a killed turn) or hasn't
            # been scanned yet.
            "  result_at TEXT,"
            "  duration_ms INTEGER,"
            "  result_chars INTEGER,"
            "  is_error INTEGER,"
            "  cwd TEXT,"
            "  model TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS tool_calls_by_day ON tool_calls (day)")
        conn.execute("CREATE INDEX IF NOT EXISTS tool_calls_by_name ON tool_calls (name, at)")
        conn.execute("CREATE INDEX IF NOT EXISTS tool_calls_by_conv ON tool_calls (conv, at)")
        conn.execute("CREATE INDEX IF NOT EXISTS tool_calls_by_session ON tool_calls (session_id, at)")
        conn.execute("CREATE INDEX IF NOT EXISTS tool_calls_by_target ON tool_calls (target)")
        # The incremental watermark, same shape as command_sources: how far
        # into each log file has been read, plus the last clock seen there
        # so a turn's result (which carries no timestamp of its own) can be
        # dated even when the scan resumes mid-turn.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tool_call_sources ("
            "  path TEXT PRIMARY KEY,"
            "  size INTEGER NOT NULL,"
            "  scanned_at TEXT NOT NULL,"
            "  last_at TEXT,"
            "  results INTEGER NOT NULL DEFAULT 0"
            ")"
        )
        # What each Observatory turn cost and how it ended (toolcallstore.py,
        # from the `result` event the harness emits at the end of a turn).
        # DERIVED from the same bot_chats logs. `seq` is the turn's ordinal
        # within its conversation; the result event has no id of its own.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS turn_results ("
            "  conv TEXT NOT NULL,"
            "  seq INTEGER NOT NULL,"
            "  session_id TEXT,"
            "  at TEXT,"
            "  day TEXT,"
            "  subtype TEXT,"
            "  stop_reason TEXT,"
            "  is_error INTEGER,"
            "  duration_ms INTEGER,"
            "  duration_api_ms INTEGER,"
            "  num_turns INTEGER,"
            "  cost_usd REAL,"
            "  input_tokens INTEGER,"
            "  cache_creation_tokens INTEGER,"
            "  cache_read_tokens INTEGER,"
            "  output_tokens INTEGER,"
            "  thinking_tokens INTEGER,"
            "  model TEXT,"
            "  PRIMARY KEY (conv, seq)"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS turn_results_by_day ON turn_results (day)")
        # Every tap on a tracked control and every page open, as events
        # (uieventstore.py). DERIVED, exactly like attention_segments: the
        # record is an append-only JSONL per day under data/ui_events/,
        # backed up by the vault's hourly commit; wipe this and rebuild().
        # feature_usage's per-day click counts are untouched and now
        # redundant — they are what these rows sum to.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ui_events ("
            "  id INTEGER PRIMARY KEY,"
            # 'click' (a [data-track] control) or 'open' (a tab came into
            # view, whether by navigation or first load).
            "  kind TEXT NOT NULL,"
            "  tab TEXT NOT NULL,"
            "  conv TEXT,"
            # The control's data-track name; NULL for an open.
            "  control TEXT,"
            "  at TEXT NOT NULL,"
            "  day TEXT NOT NULL"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ui_events_by_day ON ui_events (day)")
        conn.execute("CREATE INDEX IF NOT EXISTS ui_events_by_tab ON ui_events (tab, at)")
        # Every /api/ request the web app served (requestlog.py). NOT
        # derived — the access log it replaces rotates every few hours and,
        # with several gunicorn workers each rotating it independently,
        # loses and duplicates lines. This table is the only reliable copy,
        # written from the request path itself, so like job_runs it must
        # never be on a rebuild button.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS requests ("
            "  id INTEGER PRIMARY KEY,"
            "  at TEXT NOT NULL,"
            "  day TEXT NOT NULL,"
            "  hour INTEGER NOT NULL,"
            "  method TEXT NOT NULL,"
            "  path TEXT NOT NULL,"
            # The first path segment after /api/ — the same 'feature' the
            # daily rollup used, so the two agree.
            "  feature TEXT,"
            "  status INTEGER NOT NULL,"
            "  duration_ms INTEGER,"
            # The worker process that served it, for telling one worker's
            # slowness from the app's.
            "  pid INTEGER"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS requests_by_day ON requests (day)")
        conn.execute("CREATE INDEX IF NOT EXISTS requests_by_feature ON requests (feature, at)")
    if version < 20:
        # Entity #11: the kitchen as connected rows (foodstore.py). Until now
        # every food was a loose string typed separately in each feature —
        # "beef chuck roast" in a recipe, "Chuck roast" on the list, "HEB
        # chuck roast" on the map — so nothing could be joined. These tables
        # give each food ONE row that everything else points at.
        #
        # Two halves, and the difference matters for the rebuild button:
        #
        #   HER RECORD (not derived — never on a rebuild): foods, food_names,
        #   products, receipt_names, food_links, recipe_makes, meal_rotation.
        #   Decisions she makes once ("these two names are the same food").
        #   Backed up as the food_catalog.json mirror after every write.
        #
        #   DERIVED (wiped and re-read from the kitchen blobs on every
        #   rebuild): recipes, recipe_lines, shopping_trips, shopping_lines,
        #   grocery_list. The kitchen screens still write the blobs; these
        #   rows are a view of them with the names resolved to foods.
        #
        # A food: the thing a recipe asks for — "quinoa", "bone broth". Not
        # necessarily raw; boxed bone broth is as much a food as kale. `kind`
        # lets the same catalog hold what shares a receipt with the food
        # (shampoo, foil) without pretending it is edible.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS foods ("
            "  id INTEGER PRIMARY KEY,"
            "  name TEXT NOT NULL UNIQUE COLLATE NOCASE,"
            "  kind TEXT NOT NULL DEFAULT 'food'"
            "    CHECK (kind IN ('food', 'household', 'body', 'other')),"
            # The kitchen's shopping category (produce, dairy, @aisles…).
            "  category TEXT,"
            # How it sits with her body. NULL means not judged yet, which is
            # different from 'unsure'.
            "  safety TEXT CHECK (safety IS NULL OR safety IN ('safe', 'hurts', 'unsure')),"
            "  note TEXT,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # Every way a food has been written, lowercased. This is what turns a
        # recipe's "beef chuck roast" and the list's "Chuck roast" into the
        # same row: both names point here at one food.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS food_names ("
            "  name TEXT PRIMARY KEY,"
            "  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS food_names_by_food ON food_names (food_id)")
        # A product: one tangible thing on a shelf — "HEB bone broth, 32oz".
        # Belongs to a food (NULL until someone says which). Where-it-comes-
        # from lives here rather than on the food, because two brands of the
        # same food come from two different places.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS products ("
            "  id INTEGER PRIMARY KEY,"
            "  food_id INTEGER REFERENCES foods(id) ON DELETE SET NULL,"
            "  name TEXT NOT NULL,"
            "  brand TEXT,"
            "  store TEXT,"
            "  size TEXT,"
            "  note TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS products_by_food ON products (food_id)")
        # How a store prints a product on a receipt ("PRIME CHUCK ROAST
        # BNLS"), uppercased. Learned once, recognised on every receipt after.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS receipt_names ("
            "  store TEXT NOT NULL,"
            "  text TEXT NOT NULL,"
            "  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,"
            "  PRIMARY KEY (store, text)"
            ")"
        )
        # A food or a product tied to something elsewhere in the app: an
        # ecosystem-map source or a research entry, by that thing's own id.
        # Exactly one of food_id / product_id is set.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS food_links ("
            "  id INTEGER PRIMARY KEY,"
            "  food_id INTEGER REFERENCES foods(id) ON DELETE CASCADE,"
            "  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,"
            "  target TEXT NOT NULL CHECK (target IN ('ecosystem', 'research')),"
            "  target_id TEXT NOT NULL,"
            "  note TEXT,"
            "  CHECK ((food_id IS NULL) <> (product_id IS NULL))"
            ")"
        )
        # One link per pair. COALESCE because a plain UNIQUE treats every
        # NULL as distinct, which would let the same link in twice.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS food_links_once ON food_links"
            " (target, target_id, COALESCE(food_id, 0), COALESCE(product_id, 0))"
        )
        # Which food a recipe makes: the Bone Broth recipe makes "bone
        # broth", so a recipe asking for bone broth can be met by the box
        # from the store OR by a batch from the pot. Keyed by the recipe
        # blob's own id.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS recipe_makes ("
            "  recipe_id TEXT PRIMARY KEY,"
            "  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE"
            ")"
        )
        # The meals that recur, and how often — so "what I eat" is a standing
        # fact instead of something logged every week.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS meal_rotation ("
            "  recipe_id TEXT PRIMARY KEY,"
            "  per_week REAL NOT NULL DEFAULT 1 CHECK (per_week > 0),"
            "  since TEXT,"
            "  note TEXT"
            ")"
        )
        # --- derived from here down: foodstore.rebuild() refills these ---
        conn.execute(
            "CREATE TABLE IF NOT EXISTS recipes ("
            "  id TEXT PRIMARY KEY,"
            "  name TEXT NOT NULL,"
            "  servings INTEGER,"
            "  prep_min INTEGER,"
            "  cook_min INTEGER,"
            "  archived INTEGER NOT NULL DEFAULT 0,"
            # The recipe this one was adapted from ("my way" versions).
            "  parent_id TEXT,"
            "  source_url TEXT"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS recipe_lines ("
            "  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,"
            "  seq INTEGER NOT NULL,"
            # Exactly as the recipe writes it.
            "  text TEXT NOT NULL,"
            "  amount TEXT,"
            "  note TEXT,"
            # The recipe marks salt, oil and spices as usually-on-hand.
            "  usually_have INTEGER NOT NULL DEFAULT 0,"
            # Resolved through food_names; NULL = a name nobody has matched.
            "  food_id INTEGER REFERENCES foods(id) ON DELETE SET NULL,"
            "  PRIMARY KEY (recipe_id, seq)"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS recipe_lines_by_food ON recipe_lines (food_id)")
        # One shopping trip, merged from the two trip lists the kitchen keeps
        # (grocery_trips has line items, kitchen_trips only totals).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS shopping_trips ("
            "  id INTEGER PRIMARY KEY,"
            "  date TEXT NOT NULL,"
            "  store TEXT,"
            # Money as integer cents, same reason as the expenses table.
            "  total_cents INTEGER,"
            "  saved_cents INTEGER,"
            "  units INTEGER,"
            "  receipt TEXT,"
            # The Money tab's expense row for this trip (expenses.id).
            "  expense_id TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS shopping_trips_by_date ON shopping_trips (date)")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS shopping_lines ("
            "  trip_id INTEGER NOT NULL REFERENCES shopping_trips(id) ON DELETE CASCADE,"
            "  seq INTEGER NOT NULL,"
            # The receipt's own text.
            "  text TEXT NOT NULL,"
            "  qty REAL,"
            # What the line cost in total (qty already multiplied in).
            "  price_cents INTEGER,"
            # The name she picked for this line when the receipt was imported.
            "  picked_name TEXT,"
            "  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,"
            "  food_id INTEGER REFERENCES foods(id) ON DELETE SET NULL,"
            "  PRIMARY KEY (trip_id, seq)"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS shopping_lines_by_food ON shopping_lines (food_id)")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS grocery_list ("
            "  seq INTEGER PRIMARY KEY,"
            "  text TEXT NOT NULL,"
            "  amount TEXT,"
            "  category TEXT,"
            "  checked INTEGER NOT NULL DEFAULT 0,"
            "  food_id INTEGER REFERENCES foods(id) ON DELETE SET NULL"
            ")"
        )
        # Two views that answer the first questions worth asking. Dropped and
        # recreated so a change to one lands on a database that already has
        # the old version.
        #
        # The last time each food was bought, and what it cost then.
        conn.execute("DROP VIEW IF EXISTS food_last_price")
        conn.execute(
            "CREATE VIEW food_last_price AS"
            " WITH ranked AS ("
            "   SELECT l.food_id, t.date, l.price_cents, l.qty,"
            "          ROW_NUMBER() OVER (PARTITION BY l.food_id"
            "                             ORDER BY t.date DESC, t.id DESC) AS nth,"
            "          COUNT(*) OVER (PARTITION BY l.food_id) AS times_bought"
            "   FROM shopping_lines l JOIN shopping_trips t ON t.id = l.trip_id"
            "   WHERE l.food_id IS NOT NULL AND l.price_cents IS NOT NULL)"
            " SELECT f.id AS food_id, f.name AS food, r.date AS last_bought,"
            "        r.price_cents AS last_price_cents, r.qty AS last_qty,"
            "        r.times_bought"
            " FROM ranked r JOIN foods f ON f.id = r.food_id WHERE r.nth = 1"
        )
        # A rough cost for each recipe: the last price paid for each food it
        # asks for, skipping what the recipe says is usually on hand. Rough
        # on purpose — it prices the whole package bought, not the share of
        # it the recipe uses — and `priced_lines` says how much it knows.
        conn.execute("DROP VIEW IF EXISTS recipe_cost")
        conn.execute(
            "CREATE VIEW recipe_cost AS"
            " SELECT r.id AS recipe_id, r.name AS recipe,"
            "        COUNT(*) AS lines_to_buy,"
            "        COUNT(p.last_price_cents) AS priced_lines,"
            "        SUM(p.last_price_cents) AS known_cents"
            " FROM recipes r"
            " JOIN recipe_lines l ON l.recipe_id = r.id AND l.usually_have = 0"
            " LEFT JOIN food_last_price p ON p.food_id = l.food_id"
            " GROUP BY r.id"
        )
    if version < 22:
        # (21 is the research tables, built on a parallel branch; the ladder
        # replays any rung whose tables are missing, so the two land safely
        # in either order.)
        #
        # Whether a product is organic. On the product, not the food: the
        # grocery list says "milk" and doesn't care, while the receipt knows
        # which carton it was. NULL = not known; foodstore fills it from the
        # receipt text ("ORG", "ORGANIC") and never overwrites a value set by
        # hand. ALTER-and-swallow-duplicate, the same shape rung 14 uses, so
        # a replay of the ladder doesn't fail on a column already there.
        try:
            conn.execute(
                "ALTER TABLE products ADD COLUMN organic INTEGER"
                " CHECK (organic IS NULL OR organic IN (0, 1))")
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc):
                raise
        # Every receipt photo on disk, one row each (foodstore.rebuild reads
        # the receipts folder). DERIVED: the photos and their .parsed.json
        # transcriptions are the record; wipe this and rebuild.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS receipts ("
            # Same form the trips use: 'receipts/grocery/<file>'.
            "  path TEXT PRIMARY KEY,"
            # Which door it came in by: 'kitchen' (the Kitchen tab's scan
            # button, the grocery/ folder) or 'money' (attached to an expense
            # on the Money tab, the folder's top level).
            "  folder TEXT NOT NULL,"
            "  bytes INTEGER,"
            # The day it was uploaded, from the file name the upload gave it.
            # Not the file's clock: copying the folder between machines
            # restamps that.
            "  uploaded_on TEXT,"
            # What the photo was read as — NULL until it has been read.
            "  store TEXT,"
            "  receipt_date TEXT,"
            "  total_cents INTEGER,"
            "  line_count INTEGER,"
            "  status TEXT NOT NULL"
            "    CHECK (status IN ('unread', 'read', 'imported')),"
            "  trip_id INTEGER REFERENCES shopping_trips(id) ON DELETE SET NULL,"
            "  expense_id TEXT"
            ")"
        )
    if version < 23:
        # A word index over the journal cards, for the journal's search box
        # (cardsearch.py reads it). SQLite's built-in full-text search (FTS5),
        # with the porter stemmer so "bartending" also finds "bartender".
        #
        # A STANDALONE index keyed by card id, not an external-content one
        # pointing at `cards.rowid`: `cards` has a text primary key, so its
        # hidden rowids may be renumbered by a VACUUM, and an index pointing
        # at them would quietly start answering with the wrong cards. This
        # costs a second copy of each body (a few MB) and can't drift.
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5("
            "  card_id UNINDEXED, body,"
            "  tokenize = 'porter unicode61 remove_diacritics 2'"
            ")"
        )
        # Keep the index in step with `cards` — three triggers, one per kind
        # of change. The update one fires only when the body really changed:
        # the hourly sync rewrites every row, and re-indexing thousands of
        # unchanged bodies each hour would be pure waste.
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS cards_fts_insert AFTER INSERT ON cards"
            " BEGIN"
            "  INSERT INTO cards_fts (card_id, body) VALUES (new.id, new.body);"
            " END"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS cards_fts_update AFTER UPDATE OF body ON cards"
            " WHEN old.body IS NOT new.body"
            " BEGIN"
            "  DELETE FROM cards_fts WHERE card_id = old.id;"
            "  INSERT INTO cards_fts (card_id, body) VALUES (new.id, new.body);"
            " END"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS cards_fts_delete AFTER DELETE ON cards"
            " BEGIN"
            "  DELETE FROM cards_fts WHERE card_id = old.id;"
            " END"
        )
        # Fill it from whatever cards are already mirrored. Wipe-and-refill
        # rather than insert-missing, so replaying the ladder can never
        # double an entry — the index is derived, rebuilding it is free.
        conn.execute("DELETE FROM cards_fts")
        conn.execute("INSERT INTO cards_fts (card_id, body) SELECT id, body FROM cards")
    if version < 24:
        # Entity #11: the research pool as rows (see researchstore.py). The
        # research document — topics, entries, sessions — and the annotations
        # document were two blobs in `docs`; these tables replace them the way
        # rung 18 replaced the notes blob: the app writes HERE, research.json /
        # annotations.json become photographs of these rows, and the routes
        # keep seeing the old document because researchstore rebuilds it.
        #
        # Why now: a claim ("X does Y") needs to point at the sources that back
        # it, with a stance and the exact highlighted passage — a link between
        # two rows, with its own columns. A blob can only nest, and a claim's
        # sources are not inside it; they are other entries. `claim_sources`
        # and `claim_values` below are the first tables that only make sense
        # once entries are rows.
        #
        # Every list in the document keeps its order through a `position` (or
        # `seq`) column: the live entries are in neither created-order nor
        # id-order, and id text sorts '-10' before '-2'.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_topics ("
            # The slugified name ('wearables-signal-taxonomy'), with '-2', '-3'
            # on a collision. Text, no shape rule.
            "  id TEXT PRIMARY KEY,"
            "  name TEXT NOT NULL,"
            # 'active', 'dormant' or 'settled' (routes/research.py). Not a
            # CHECK: the vocabulary is the route's to change.
            "  status TEXT,"
            # 'YYYY-MM-DD HH:MM', local, kept verbatim.
            "  created TEXT,"
            # Where the topic sits in the document's list.
            "  position INTEGER NOT NULL DEFAULT 0,"
            # Any key with no column of its own, kept verbatim as JSON so a
            # blob-era field is never silently dropped. Empty today.
            "  extra TEXT,"
            # When this ROW last changed — not when she made the topic. Never
            # appears in the document.
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # Which life domains a topic sits on — ids from fronts.json, one row
        # per (topic, front). Its own table because it is a list, and because
        # "which topics are on the health front" is a question worth an index.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_topic_fronts ("
            "  topic_id TEXT NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,"
            "  front TEXT NOT NULL,"
            # Order within the topic's `fronts` list.
            "  seq INTEGER NOT NULL,"
            "  PRIMARY KEY (topic_id, front)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS research_topic_fronts_by_front"
            " ON research_topic_fronts (front)"
        )
        # The pool itself: one row per atomic entry, whatever its kind.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_entries ("
            # 'YYYY-MM-DD.HHMM' with '-2', '-3' ... on a same-minute collision.
            "  id TEXT PRIMARY KEY,"
            # The four kinds routes/research.py accepts. This one IS a CHECK,
            # because everything downstream (claim_sources, the claims view)
            # keys off it.
            "  kind TEXT NOT NULL CHECK (kind IN ('note','source','claim','question')),"
            "  text TEXT NOT NULL,"
            "  url TEXT,"
            # Per kind: claims carry ''/real/shaky/interesting, sources
            # ''/verified, the rest ''. Enforced by the route, not here.
            "  verdict TEXT,"
            # Questions carry 'open'/'answered'; every other kind ''.
            "  status TEXT,"
            # The entry this one answers, when it is a reply. Loose reference
            # on purpose — replies to a since-deleted entry exist.
            "  reply_to TEXT,"
            # 'YYYY-MM-DD HH:MM', local, kept verbatim.
            "  created TEXT,"
            # 'llm' when the runner wrote it back; NULL means the owner's own.
            "  author TEXT,"
            # Three yes/no flags, stored 0/1, NULL when the document never set
            # them — the document shows the key only when it was set, so the
            # difference between 'false' and 'never said' is kept.
            "  reviewed INTEGER,"
            "  flagged INTEGER,"
            "  processed INTEGER,"
            # The session that produced an llm reply. Loose reference: the
            # session rows are rebuilt from the same document and may lag.
            "  session TEXT,"
            # The passage the owner was pointing at when she wrote this.
            "  re_quote TEXT,"
            # The research library file an llm reply left behind.
            "  file TEXT,"
            # Where an imported entry came from ('note:<file>', research_import).
            "  origin TEXT,"
            # Where the entry sits in the document's list — the order the
            # blob kept, which is neither created-order nor id-order.
            "  position INTEGER NOT NULL DEFAULT 0,"
            # Keys with no column, kept verbatim as JSON: today that is a
            # source's fetched `meta` block (routes/research_sources.py), a
            # nested record that belongs to a later rung.
            "  extra TEXT,"
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS research_entries_by_kind"
            " ON research_entries (kind, position)"
        )
        # Which topics an entry is tagged with — the `topics` list, one row per
        # tag. topic_id is indexed but NOT a foreign key: an entry may keep the
        # id of a topic that no longer exists, and the blob allowed that.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_entry_topics ("
            "  entry_id TEXT NOT NULL REFERENCES research_entries(id) ON DELETE CASCADE,"
            "  topic_id TEXT NOT NULL,"
            "  seq INTEGER NOT NULL,"
            "  PRIMARY KEY (entry_id, topic_id)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS research_entry_topics_by_topic"
            " ON research_entry_topics (topic_id)"
        )
        # The entries an entry was written in the context of — the
        # `context_ids` list. Its own table rather than JSON in `extra` so
        # "what was written with this entry in view" can be asked of the
        # database. Loose references, same as reply_to.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_entry_context ("
            "  entry_id TEXT NOT NULL REFERENCES research_entries(id) ON DELETE CASCADE,"
            "  seq INTEGER NOT NULL,"
            "  context_id TEXT NOT NULL,"
            "  PRIMARY KEY (entry_id, seq)"
            ")"
        )
        # One research-runner run: what was sent, and what came of it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_sessions ("
            # Same id scheme as entries.
            "  id TEXT PRIMARY KEY,"
            "  created TEXT,"
            # 'queued', 'running', 'done', 'failed' — the dispatcher's words.
            "  status TEXT,"
            # The one-line report the runner leaves behind.
            "  report TEXT,"
            # 'regular', 'deep' or 'distill'; NULL on the oldest sessions.
            "  mode TEXT,"
            # 1 when the session is queued for scripts/research_dispatcher.py
            # rather than spawned directly. NULL when the document never said.
            "  worker INTEGER,"
            # How many times the dispatcher has tried to run it.
            "  attempts INTEGER,"
            # The Claude session and working directory the runner used.
            "  claude_session TEXT,"
            "  claude_cwd TEXT,"
            # Two seams for a later phase: the Observatory conversation that
            # ran this session, and the run-queue id. Nullable; nothing here
            # writes them yet.
            "  conv_id TEXT,"
            "  run_id TEXT,"
            "  position INTEGER NOT NULL DEFAULT 0,"
            "  extra TEXT,"
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # The entries a session was sent — its `entry_ids` list, in order.
        # Loose references: the runner has sent entries that were later deleted.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_session_entries ("
            "  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,"
            "  seq INTEGER NOT NULL,"
            "  entry_id TEXT NOT NULL,"
            "  PRIMARY KEY (session_id, seq)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS research_session_entries_by_entry"
            " ON research_session_entries (entry_id)"
        )
        # The union of topics across what a session was sent — its `topics`.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_session_topics ("
            "  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,"
            "  topic_id TEXT NOT NULL,"
            "  seq INTEGER NOT NULL,"
            "  PRIMARY KEY (session_id, topic_id)"
            ")"
        )
        # A highlighted passage in a document, with a note on it — the
        # annotations blob (routes/annotations.py) as rows. The document's
        # nested `selector` and `content` maps are flattened into columns;
        # researchstore folds them back when it rebuilds the document.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_annotations ("
            # 'ann-YYYY-MM-DD.HHMM' with '-2', '-3' ... on a collision. The
            # prefix keeps these out of the entry-id namespace.
            "  id TEXT PRIMARY KEY,"
            # Which document: 'entry:<entry id>' for an extracted source text,
            # 'note:<file>' for a research markdown. docstore.py is the one
            # place that knows what a doc id means.
            "  doc TEXT NOT NULL,"
            # The selector: character offsets into the document's text as it
            # was when the highlight was made, and the exact words there.
            # Whether they still resolve is recomputed on read, never stored.
            "  char_start INTEGER,"
            "  char_end INTEGER,"
            "  exact TEXT,"
            # The content map's three conventional keys: what kind of mark
            # ('highlight'), the note on it, and who made it ('human'/'llm').
            "  kind TEXT,"
            "  note TEXT,"
            "  source TEXT,"
            # 1 when a machine made it and no one has looked yet. A human
            # annotating IS the review, so theirs are born 0.
            "  needs_review INTEGER,"
            "  created TEXT,"
            "  position INTEGER NOT NULL DEFAULT 0,"
            # Keys with no column — including any content or selector key
            # beyond the ones above — kept verbatim as JSON.
            "  extra TEXT,"
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS research_annotations_by_doc"
            " ON research_annotations (doc, position)"
        )
        # Which sources back which claim, and how. The first table here that
        # only exists because entries are rows: a link between two of them,
        # with a stance and (optionally) the exact highlighted passage that
        # is the evidence. Both ends are real foreign keys — delete either
        # entry and the link goes with it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS claim_sources ("
            "  claim_id TEXT NOT NULL REFERENCES research_entries(id) ON DELETE CASCADE,"
            "  source_id TEXT NOT NULL REFERENCES research_entries(id) ON DELETE CASCADE,"
            # What the source says about the claim.
            "  stance TEXT NOT NULL DEFAULT 'supports'"
            "    CHECK (stance IN ('supports','contradicts','context')),"
            # The highlighted passage that is the evidence, when one was
            # marked. Deleting the annotation keeps the link and blanks this.
            "  annotation_id TEXT REFERENCES research_annotations(id) ON DELETE SET NULL,"
            # Why this source is on this claim, in the linker's words.
            "  note TEXT,"
            "  created TEXT,"
            "  PRIMARY KEY (claim_id, source_id)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS claim_sources_by_source"
            " ON claim_sources (source_id)"
        )
        # The number inside a claim, when it has one: "X does Y" pulled apart
        # into subject / measure / amount / unit so claims can be compared and
        # laid beside other records. One per claim, so the claim id is the key.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS claim_values ("
            "  claim_id TEXT PRIMARY KEY REFERENCES research_entries(id) ON DELETE CASCADE,"
            # What the claim is about, as plain text. Deliberately NOT a
            # foreign key to anything: it is meant to match a name in another
            # table later (a food, say) without that table having to exist.
            "  subject TEXT,"
            # What was measured ('protein', 'half-life').
            "  measure TEXT,"
            "  amount REAL,"
            "  unit TEXT,"
            # Per what ('100 g', 'per day').
            "  basis TEXT,"
            # The year the figure is from.
            "  year INTEGER,"
            # How far the figure is trusted, in free text ('verified',
            # 'works-but-unverified'). Free on purpose: the vocabulary is
            # still being found.
            "  tier TEXT,"
            "  extra TEXT"
            ")"
        )
    if version < 25:
        # Research tables (hazardstore.py): what is IN a food, number by
        # number, each tied to the study it came from and to the owner's
        # review of it — and, kept apart, the verdicts drawn from those
        # numbers. Four layers: a hazard map (a kind-of graph she arranges),
        # measurements (food × hazard × measure → a number), judgments (food ×
        # lens → a verdict, grounded on measurements), and the tables she
        # directs (saved views over the first three).
        #
        # Every hazard is a node; `hazard_parents` says which kinds it is a
        # kind of. More than one parent is allowed on purpose: DDE is both a
        # pesticide residue and a persistent pollutant, and a strict tree would
        # make her pick one.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS hazards ("
            "  id INTEGER PRIMARY KEY,"
            "  name TEXT NOT NULL UNIQUE COLLATE NOCASE,"
            "  note TEXT,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # Every way a hazard gets written ('total arsenic' → arsenic), stored
        # lowercased. Matching happens here, the way food_names does it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS hazard_names ("
            "  name TEXT PRIMARY KEY,"
            "  hazard_id INTEGER NOT NULL REFERENCES hazards(id) ON DELETE CASCADE"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS hazard_parents ("
            "  hazard_id INTEGER NOT NULL REFERENCES hazards(id) ON DELETE CASCADE,"
            "  parent_id INTEGER NOT NULL REFERENCES hazards(id) ON DELETE CASCADE,"
            "  PRIMARY KEY (hazard_id, parent_id),"
            "  CHECK (hazard_id <> parent_id)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS hazard_parents_by_parent ON hazard_parents (parent_id)"
        )
        # One number about one food: how much of a hazard is in it, or how
        # often it was found. Never more than one number per row; two studies
        # on the same food and hazard are two rows.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS hazard_measures ("
            "  id INTEGER PRIMARY KEY,"
            "  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,"
            "  hazard_id INTEGER NOT NULL REFERENCES hazards(id) ON DELETE CASCADE,"
            # What kind of number: 'concentration' (how much, in ppb) or
            # 'detection_rate' (share of samples it was found in, in %). The
            # vocabulary lives in hazardstore.MEASURES, not a CHECK.
            "  measure TEXT NOT NULL,"
            "  amount REAL NOT NULL,"
            "  unit TEXT NOT NULL,"
            # The figure exactly as the source printed it, when it had to be
            # converted ('0.012 mg/kg' stored as 12 ppb).
            "  as_reported TEXT,"
            "  sample_size INTEGER,"
            # What the number is a summary of ('mean of TDS samples').
            "  basis TEXT,"
            "  year INTEGER,"
            # When the study tested something standing in for this food
            # ('sirloin steak' for chuck roast), what it was. NULL = the food itself.
            "  measured_on TEXT,"
            # The study, the exact passage in it, and the prose claim this
            # number came from. Loose on delete: the number outlives a
            # deleted entry, and the grid shows it as unsourced.
            "  source_id TEXT REFERENCES research_entries(id) ON DELETE SET NULL,"
            "  annotation_id TEXT REFERENCES research_annotations(id) ON DELETE SET NULL,"
            "  claim_id TEXT REFERENCES research_entries(id) ON DELETE SET NULL,"
            # What ground it stands on, in the research room's words.
            "  tier TEXT,"
            "  note TEXT,"
            "  author TEXT NOT NULL DEFAULT 'llm' CHECK (author IN ('llm','owner')),"
            "  review TEXT NOT NULL DEFAULT 'unreviewed'"
            "    CHECK (review IN ('unreviewed','confirmed','disputed')),"
            "  reviewed_at TEXT,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS hazard_measures_by_food ON hazard_measures (food_id, hazard_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS hazard_measures_by_hazard ON hazard_measures (hazard_id)"
        )
        # A verdict about one food through one lens ('health',
        # 'sustainability'): buy organic or not. With a hazard, the verdict is
        # about that hazard alone — "organic does nothing for cadmium".
        conn.execute(
            "CREATE TABLE IF NOT EXISTS food_judgments ("
            "  id INTEGER PRIMARY KEY,"
            "  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,"
            # The vocabulary lives in hazardstore.LENSES.
            "  lens TEXT NOT NULL,"
            "  hazard_id INTEGER REFERENCES hazards(id) ON DELETE CASCADE,"
            "  verdict TEXT NOT NULL"
            "    CHECK (verdict IN ('organic','some','conventional','open')),"
            "  reasoning TEXT,"
            "  tier TEXT,"
            "  author TEXT NOT NULL DEFAULT 'llm' CHECK (author IN ('llm','owner')),"
            "  review TEXT NOT NULL DEFAULT 'unreviewed'"
            "    CHECK (review IN ('unreviewed','confirmed','disputed')),"
            "  reviewed_at TEXT,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # One verdict per food, lens and hazard — "no hazard" counted as one
        # value, which a plain UNIQUE would not do (SQL treats NULLs as distinct).
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS food_judgments_one_per_lens"
            " ON food_judgments (food_id, lens, IFNULL(hazard_id, 0))"
        )
        # Which measurements a verdict rests on. When one of them is disputed,
        # the verdict shows as shaken.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS judgment_grounds ("
            "  judgment_id INTEGER NOT NULL REFERENCES food_judgments(id) ON DELETE CASCADE,"
            "  measure_id INTEGER NOT NULL REFERENCES hazard_measures(id) ON DELETE CASCADE,"
            "  PRIMARY KEY (judgment_id, measure_id)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS judgment_grounds_by_measure ON judgment_grounds (measure_id)"
        )
        # What a measurement or verdict said before it was changed. Edits are
        # never silent: the old version is kept here whole, as JSON.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS hazard_history ("
            "  id INTEGER PRIMARY KEY,"
            "  kind TEXT NOT NULL CHECK (kind IN ('measure','judgment')),"
            "  row_id INTEGER NOT NULL,"
            "  snapshot TEXT NOT NULL,"
            "  replaced_by TEXT,"
            "  replaced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS hazard_history_by_row ON hazard_history (kind, row_id)"
        )
        # The tables she directs: saved views. A 'measures' table shows foods
        # down the side and one branch of the hazard map across the top; a
        # 'judgments' table shows foods down the side and the lenses across.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS research_tables ("
            "  id INTEGER PRIMARY KEY,"
            "  name TEXT NOT NULL UNIQUE COLLATE NOCASE,"
            "  kind TEXT NOT NULL CHECK (kind IN ('measures','judgments')),"
            # The research topic this table belongs to. Loose, like an entry's topics.
            "  topic_id TEXT,"
            # Measures tables: the branch whose children are the columns, and
            # which kind of number the cells show.
            "  hazard_id INTEGER REFERENCES hazards(id) ON DELETE SET NULL,"
            "  measure TEXT,"
            # Which foods are the rows: 'all', 'recipes' (in any recipe) or
            # 'rotation' (in a recipe on the meal rotation).
            "  foods TEXT NOT NULL DEFAULT 'all' CHECK (foods IN ('all','recipes','rotation')),"
            "  note TEXT,"
            "  position INTEGER NOT NULL DEFAULT 0,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # Two views for the SQL console: every measurement and every verdict
        # with its names spelled out, so a query needs no joins.
        conn.execute("DROP VIEW IF EXISTS hazard_findings")
        conn.execute(
            "CREATE VIEW hazard_findings AS"
            " SELECT m.id, f.name AS food, h.name AS hazard, m.measure, m.amount, m.unit,"
            "        m.year, m.measured_on, m.tier, m.review, m.author,"
            "        s.text AS source, s.url AS source_url"
            " FROM hazard_measures m"
            " JOIN foods f ON f.id = m.food_id"
            " JOIN hazards h ON h.id = m.hazard_id"
            " LEFT JOIN research_entries s ON s.id = m.source_id"
        )
        conn.execute("DROP VIEW IF EXISTS food_verdicts")
        conn.execute(
            "CREATE VIEW food_verdicts AS"
            " SELECT j.id, f.name AS food, j.lens, h.name AS hazard, j.verdict,"
            "        j.reasoning, j.tier, j.review, j.author"
            " FROM food_judgments j"
            " JOIN foods f ON f.id = j.food_id"
            " LEFT JOIN hazards h ON h.id = j.hazard_id"
        )
    if version < 26:
        # Rung 26: Claude's estimate of buy-organic-or-not for a food, made
        # from what the model already knows rather than from measurements —
        # the grocery list shows it until real research exists. Kept apart
        # from food_judgments on purpose: a verdict there must rest on
        # numbers, and a guess must never pass as one. Written only by
        # estimatestore.py.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS food_estimates ("
            "  id INTEGER PRIMARY KEY,"
            "  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,"
            # The vocabulary lives in hazardstore.LENSES.
            "  lens TEXT NOT NULL,"
            "  verdict TEXT NOT NULL"
            "    CHECK (verdict IN ('organic','some','conventional','open')),"
            "  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),"
            # Why, in two to four plain sentences.
            "  summary TEXT NOT NULL,"
            # JSON: a list of words from estimatestore.QUALIFIERS.
            "  qualifiers TEXT NOT NULL DEFAULT '[]',"
            # JSON: what else is known to get into this food besides
            # pesticide residue (PFAS, heavy metals…), each with whether
            # organic helps and how solid the evidence is.
            "  contaminants TEXT NOT NULL DEFAULT '[]',"
            "  model TEXT,"
            "  review TEXT NOT NULL DEFAULT 'unreviewed'"
            "    CHECK (review IN ('unreviewed','confirmed','disputed')),"
            "  reviewed_at TEXT,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  UNIQUE (food_id, lens)"
            ")"
        )
    if version < 27:
        # Rung 27: which of her research claims an estimate drew on (JSON list
        # of claim ids), so the popup can say the guess leaned on her studies.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(food_estimates)")}
        if "claims" not in columns:
            conn.execute("ALTER TABLE food_estimates ADD COLUMN claims TEXT NOT NULL DEFAULT '[]'")
    if version < 28:
        # Rung 28: mark the real Keeper sessions. `bot` says "keeper" on nearly every
        # session (a leftover default from when the Keeper was the only bot),
        # so it can't tell the journal apart from a coding session; a
        # journaling session can (lanes.is_keeper). The `lane` column beside
        # it is now filled by derivation for sessions that never stored one
        # (codestore.sync_sessions). Same ALTER-and-swallow-duplicate shape
        # rung 14 uses, so a replayed ladder doesn't fail on it.
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN is_keeper INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
    if version < 29:
        # Rung 29: the agents' mailbox (peermail.py). One row per message sent
        # INTO a session — by another agent (kind 'A'), or by the owner while
        # a turn was running (kind 'B'). The table also allows kind 'S' (see
        # rung 42); nothing sends one. This is the record, not a mirror: the
        # transcripts only hold a message once it has been delivered, so a
        # message still waiting exists nowhere else.
        _create_agent_messages(conn, "agent_messages")
    if version < 30:
        # Rung 30: token accounting per model call, and swarms (docs/swarms.md).
        #
        # One row per call to the model (toolcallstore.py). DERIVED from the
        # Observatory logs, like tool_calls: input and cache tokens come from
        # the `assistant` lines, the final output count from the `call-usage`
        # line the turn loop writes when the call finishes. `context_tokens` is
        # everything the model read on that call — the session's context size
        # at that moment, which is what the self-continuing cap watches.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS model_calls ("
            "  message_id TEXT PRIMARY KEY,"
            "  conv TEXT,"
            "  session_id TEXT,"
            # The Agent call a subagent made this under; NULL at top level.
            "  parent_tool_use_id TEXT,"
            "  at TEXT,"
            "  day TEXT,"
            "  model TEXT,"
            "  input_tokens INTEGER,"
            "  cache_creation_tokens INTEGER,"
            "  cache_read_tokens INTEGER,"
            "  context_tokens INTEGER,"
            # NULL until the call's call-usage line is read; the partial count
            # in the assistant line is never stored.
            "  output_tokens INTEGER,"
            # JSON list of the tool_use ids this call asked for — the join to
            # tool_calls.
            "  tool_use_ids TEXT NOT NULL DEFAULT '[]'"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS model_calls_by_conv ON model_calls (conv, at)")
        conn.execute("CREATE INDEX IF NOT EXISTS model_calls_by_day ON model_calls (day)")
        # Swarms (swarms.py): sessions linked by having messaged each other.
        # The RECORD for names, helpers and summaries; membership is re-derived
        # from agent_messages but kept, because it only ever grows.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS swarms ("
            "  id INTEGER PRIMARY KEY,"
            # The helper names it; NULL until then.
            "  name TEXT,"
            "  lane TEXT,"
            # The helper's own Observatory session, once it has one.
            "  helper_conv TEXT,"
            # The helper's current summary of the whole swarm — replaced on
            # every update, never appended.
            "  summary TEXT,"
            "  summary_at TEXT,"
            "  created_at TEXT NOT NULL,"
            "  updated_at TEXT NOT NULL,"
            # Set when a link joined this swarm into an older one.
            "  merged_into INTEGER REFERENCES swarms(id)"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS swarm_members ("
            "  swarm_id INTEGER NOT NULL REFERENCES swarms(id),"
            "  conv TEXT NOT NULL,"
            "  joined_at TEXT NOT NULL,"
            # The helper's current summary of this member, replaced each time.
            "  summary TEXT,"
            "  summary_at TEXT,"
            "  PRIMARY KEY (swarm_id, conv)"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS swarm_members_by_conv ON swarm_members (conv)")
        # Every time a helper ran: what it was given and what it wrote back, so
        # the owner can see exactly what information it used.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS swarm_helper_runs ("
            "  id INTEGER PRIMARY KEY,"
            "  swarm_id INTEGER NOT NULL REFERENCES swarms(id),"
            "  at TEXT NOT NULL,"
            "  trigger TEXT,"
            "  input TEXT,"
            "  output TEXT,"
            "  cost_usd REAL,"
            "  error TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS swarm_helper_runs_by_swarm"
                     " ON swarm_helper_runs (swarm_id, at)")
    if version < 31:
        # Rung 31: how much of a model call's output was thinking — the final
        # count arrives with its output total in the call-usage line.
        try:
            conn.execute("ALTER TABLE model_calls ADD COLUMN thinking_tokens INTEGER")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
    if version < 32:
        # Rung 32: the ecosystem map's sources, moved out of ecosystem.json so
        # they sit beside the foods and products they belong to (the links
        # already live in food_links, target 'ecosystem'). Her record, written
        # only by sourcestore.py and backed up with the food catalog. The id
        # stays TEXT so the ids the JSON file gave out (and food_links already
        # points at) carry over unchanged.
        #
        # Three honest axes, each held to its vocabulary by a CHECK so no
        # value outside it can land: transparency (how disclosed the supply
        # chain is), precision (a crisp spot or a rough area), and geo_source
        # (how the dot itself got placed — a USDA proxy must never pass as a
        # placement). The origin_* columns are a fourth thing: where the
        # placement information came from and when it was looked up.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS food_sources ("
            "  id TEXT PRIMARY KEY,"
            "  layer TEXT NOT NULL DEFAULT 'food',"
            "  name TEXT NOT NULL,"
            "  note TEXT NOT NULL DEFAULT '',"
            "  lat REAL NOT NULL,"
            "  lng REAL NOT NULL,"
            "  precision TEXT NOT NULL DEFAULT 'point' CHECK (precision IN ('point', 'area')),"
            "  radius_km REAL NOT NULL DEFAULT 0,"
            "  area_kind TEXT NOT NULL DEFAULT 'circle'"
            "    CHECK (area_kind IN ('circle', 'counties', 'state')),"
            "  region_name TEXT NOT NULL DEFAULT '',"
            "  transparency TEXT NOT NULL DEFAULT 'unrated'"
            "    CHECK (transparency IN ('disclosed', 'partial', 'opaque', 'unrated')),"
            "  geo_source TEXT NOT NULL DEFAULT 'unrated'"
            "    CHECK (geo_source IN ('placed', 'proxy', 'guess', 'unrated')),"
            # Where the placement came from — the vocabulary and what each
            # word means live in sourcestore.ORIGINS.
            "  origin TEXT NOT NULL DEFAULT 'unknown'"
            "    CHECK (origin IN ('usda-nass', 'geocoded', 'package', 'visit',"
            "                      'research', 'hand', 'unknown')),"
            # The citation in words: which dataset, query, address or label.
            "  origin_detail TEXT NOT NULL DEFAULT '',"
            "  origin_url TEXT NOT NULL DEFAULT '',"
            # The day the information was looked up (YYYY-MM-DD), '' if not known.
            "  origin_date TEXT NOT NULL DEFAULT '',"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # The county outlines an area source is drawn as, one row per county,
        # with what USDA reported for it when that's where they came from
        # (value + unit, e.g. 1,204,000 HEAD), so the number behind the
        # outline can be shown and re-checked.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS food_source_counties ("
            "  source_id TEXT NOT NULL REFERENCES food_sources(id) ON DELETE CASCADE,"
            "  fips TEXT NOT NULL CHECK (length(fips) = 5),"
            "  seq INTEGER NOT NULL DEFAULT 0,"
            "  county TEXT NOT NULL DEFAULT '',"
            "  state TEXT NOT NULL DEFAULT '',"
            "  value REAL,"
            "  unit TEXT NOT NULL DEFAULT '',"
            "  PRIMARY KEY (source_id, fips)"
            ")"
        )
    if version < 33:
        # Rung 33: her requests to have a food's origin found — the "Request
        # linking" button on an untraced food. A request links nothing; it
        # queues the food for the research pass, which answers it with
        # proposals a machine checker rules on (rung 34). Her record, written
        # only by sourcestore.py and backed up with the food catalog.
        #
        # A recipe line can name something that isn't a food yet, so food_id
        # may be empty and food_name carries the words. food_key is whichever
        # of the two identifies it ('id:12' or 'name:chuck roast'), and the
        # partial unique index keeps at most one OPEN request per key — asking
        # twice returns the first request instead of making another.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS source_requests ("
            "  id INTEGER PRIMARY KEY,"
            "  food_id INTEGER REFERENCES foods(id),"
            "  food_name TEXT NOT NULL DEFAULT '',"
            "  food_key TEXT NOT NULL,"
            "  product_id INTEGER REFERENCES products(id),"
            "  asked_from TEXT NOT NULL DEFAULT '',"
            "  status TEXT NOT NULL DEFAULT 'open'"
            "    CHECK (status IN ('open', 'answered', 'withdrawn')),"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  closed_at TEXT"
            ")"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS source_requests_one_open"
            " ON source_requests (food_key) WHERE status = 'open'")
    if version < 34:
        # Rung 34: the machine's proposals for where a food comes from — the
        # research pass's answers to her requests, kept apart from
        # food_sources, which stays her record. propose_sources.py writes a
        # proposal and check_proposals.py rules on it (a separate model call
        # re-reads every cited page, and the USDA figures are re-fetched); a
        # pass closes the request it answers. Written only by proposalstore.py.
        # Machine output, but backed up with the food catalog: only a paid
        # model run would produce it again.
        #
        # The place columns are food_sources' own, with the same vocabularies,
        # except geo_source: a machine may never claim 'placed' (a location
        # someone actually confirmed). amends_source_id set means "a suggested
        # fix to one of her sources"; empty means a new source. A re-run never
        # deletes — it points the old proposal at its replacement.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS source_proposals ("
            "  id INTEGER PRIMARY KEY,"
            "  food_id INTEGER REFERENCES foods(id),"
            "  product_id INTEGER REFERENCES products(id),"
            "  request_id INTEGER REFERENCES source_requests(id),"
            "  amends_source_id TEXT REFERENCES food_sources(id),"
            "  name TEXT NOT NULL,"
            "  note TEXT NOT NULL DEFAULT '',"
            "  lat REAL NOT NULL,"
            "  lng REAL NOT NULL,"
            "  precision TEXT NOT NULL DEFAULT 'point' CHECK (precision IN ('point', 'area')),"
            "  radius_km REAL NOT NULL DEFAULT 0,"
            "  area_kind TEXT NOT NULL DEFAULT 'circle'"
            "    CHECK (area_kind IN ('circle', 'counties', 'state')),"
            "  region_name TEXT NOT NULL DEFAULT '',"
            "  country TEXT NOT NULL DEFAULT '',"
            "  transparency TEXT NOT NULL DEFAULT 'unrated'"
            "    CHECK (transparency IN ('disclosed', 'partial', 'opaque', 'unrated')),"
            "  geo_source TEXT NOT NULL CHECK (geo_source IN ('proxy', 'guess')),"
            "  origin TEXT NOT NULL DEFAULT 'unknown'"
            "    CHECK (origin IN ('usda-nass', 'geocoded', 'package', 'visit',"
            "                      'research', 'hand', 'unknown')),"
            "  origin_detail TEXT NOT NULL DEFAULT '',"
            "  origin_url TEXT NOT NULL DEFAULT '',"
            "  origin_date TEXT NOT NULL DEFAULT '',"
            # The USDA NASS commodity (commodity_desc) the county figures were
            # pulled for, so the checker can re-fetch them.
            "  usda_commodity TEXT NOT NULL DEFAULT '',"
            "  summary TEXT NOT NULL DEFAULT '',"
            "  worst_trace_seq INTEGER,"
            "  worst_health_seq INTEGER,"
            "  check_status TEXT NOT NULL DEFAULT 'unchecked'"
            "    CHECK (check_status IN ('unchecked', 'passed', 'failed')),"
            "  check_reason TEXT NOT NULL DEFAULT '',"
            "  checked_at TEXT,"
            "  model TEXT NOT NULL DEFAULT '',"
            "  run_id TEXT NOT NULL DEFAULT '',"
            "  superseded_by INTEGER REFERENCES source_proposals(id),"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  CHECK (food_id IS NOT NULL OR product_id IS NOT NULL)"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS source_proposals_food"
            " ON source_proposals (food_id) WHERE superseded_by IS NULL")
        # The county outlines a proposal is drawn as — food_source_counties'
        # shape exactly, so one drawing path serves both.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS source_proposal_counties ("
            "  proposal_id INTEGER NOT NULL REFERENCES source_proposals(id) ON DELETE CASCADE,"
            "  fips TEXT NOT NULL CHECK (length(fips) = 5),"
            "  seq INTEGER NOT NULL DEFAULT 0,"
            "  county TEXT NOT NULL DEFAULT '',"
            "  state TEXT NOT NULL DEFAULT '',"
            "  value REAL,"
            "  unit TEXT NOT NULL DEFAULT '',"
            "  PRIMARY KEY (proposal_id, fips)"
            ")"
        )
        # One row per ingredient of a multi-ingredient product, each rated on
        # how traceable it is and how bad for health. health_basis says where
        # the health rating came from: 'estimate:<id>' reuses one of her
        # organic estimates, 'model' means the model was asked.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS source_proposal_parts ("
            "  proposal_id INTEGER NOT NULL REFERENCES source_proposals(id) ON DELETE CASCADE,"
            "  seq INTEGER NOT NULL,"
            "  ingredient TEXT NOT NULL,"
            "  food_id INTEGER REFERENCES foods(id),"
            "  place TEXT NOT NULL DEFAULT '',"
            "  transparency TEXT NOT NULL DEFAULT 'unrated'"
            "    CHECK (transparency IN ('disclosed', 'partial', 'opaque', 'unrated')),"
            "  geo_source TEXT NOT NULL DEFAULT 'unrated'"
            "    CHECK (geo_source IN ('proxy', 'guess', 'unrated')),"
            "  health_concern TEXT NOT NULL DEFAULT 'unknown'"
            "    CHECK (health_concern IN ('high', 'some', 'low', 'unknown')),"
            "  health_basis TEXT NOT NULL DEFAULT '',"
            "  note TEXT NOT NULL DEFAULT '',"
            "  PRIMARY KEY (proposal_id, seq)"
            ")"
        )
        # The evidence behind a proposal: each cited page, USDA query and
        # model claim is a research_entries row (author 'llm', unreviewed),
        # linked here with the checker's verdict on it. entry_id is a loose
        # reference, like reply_to, so it has no foreign key.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS source_proposal_evidence ("
            "  proposal_id INTEGER NOT NULL REFERENCES source_proposals(id) ON DELETE CASCADE,"
            "  entry_id TEXT NOT NULL,"
            "  role TEXT NOT NULL CHECK (role IN ('usda', 'web', 'model')),"
            "  check_status TEXT NOT NULL DEFAULT 'unchecked'"
            "    CHECK (check_status IN ('unchecked', 'passed', 'failed')),"
            "  check_reason TEXT NOT NULL DEFAULT '',"
            "  PRIMARY KEY (proposal_id, entry_id)"
            ")"
        )
    if version < 35:
        # Rung 35: the USDA commodity on a proposal. Rung 34 creates the column
        # on a fresh database; one that climbed 34 before it was added gets it
        # here.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(source_proposals)")}
        if "usda_commodity" not in columns:
            conn.execute("ALTER TABLE source_proposals"
                         " ADD COLUMN usda_commodity TEXT NOT NULL DEFAULT ''")
    if version < 36:
        # Rung 36: verifiable exposure scores (exposurestore.py). A buy-organic
        # verdict here is a calculation anyone can redo from public data: USDA
        # residue samples (parsed into commons.db, beside the files, not here)
        # scored against EPA's chronic safe daily doses. What lives in exo.db
        # is what the owner reviews, what was computed, and the memory of what
        # has been pulled. See docs/exposure.md.
        #
        # One fact about one contaminant — its CAS number, what kind of
        # pesticide it is, EPA's chronic safe dose, its cancer rating, a health
        # effect — each with the source and passage it came from, and her
        # review. A table of facts rather than a wide profile row, so every
        # single fact carries its own source, and metals fit as well as
        # pesticides. The fact vocabulary lives in exposurestore.FACTS.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS hazard_facts ("
            "  id INTEGER PRIMARY KEY,"
            "  hazard_id INTEGER NOT NULL REFERENCES hazards(id) ON DELETE CASCADE,"
            "  fact TEXT NOT NULL,"
            # The fact as words ('Group C: possible human carcinogen') and, when
            # it is a number, the number and its unit (0.005, 'mg/kg/day').
            "  value TEXT NOT NULL,"
            "  amount REAL,"
            "  unit TEXT,"
            # What the number is ('cRfD', 'cPAD' — the FQPA-adjusted one).
            "  basis TEXT,"
            "  source_id TEXT REFERENCES research_entries(id) ON DELETE SET NULL,"
            "  annotation_id TEXT REFERENCES research_annotations(id) ON DELETE SET NULL,"
            # Where it was read when the source isn't in the pool yet — a
            # table row on an agency page.
            "  url TEXT,"
            "  note TEXT,"
            # 'code' = parsed from a published table by a loader, 'llm' = an
            # agent wrote it, 'owner' = she did. Only hers is born confirmed.
            "  author TEXT NOT NULL DEFAULT 'llm' CHECK (author IN ('llm','owner','code')),"
            "  review TEXT NOT NULL DEFAULT 'unreviewed'"
            "    CHECK (review IN ('unreviewed','confirmed','disputed')),"
            "  reviewed_at TEXT,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS hazard_facts_by_hazard ON hazard_facts (hazard_id, fact)"
        )
        # Which USDA PDP commodity a food is, so the residue samples can be
        # found for it. A food may be more than one ('ST' fresh and frozen);
        # commtype '' means any form.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS food_pdp_codes ("
            "  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,"
            "  commodity TEXT NOT NULL,"
            "  commtype TEXT NOT NULL DEFAULT '',"
            "  PRIMARY KEY (food_id, commodity, commtype)"
            ")"
        )
        # The memory: every pull of public data, which file it came from (by
        # checksum), what it held and which loader read it. Pulling the same
        # thing again with the same loader finds its row here and does nothing.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS data_pulls ("
            "  id INTEGER PRIMARY KEY,"
            "  dataset TEXT NOT NULL,"
            "  year INTEGER NOT NULL DEFAULT 0,"
            # What part of the dataset: a PDP commodity code, or '' for all of it.
            "  scope TEXT NOT NULL DEFAULT '',"
            "  file_path TEXT NOT NULL,"
            "  file_sha256 TEXT NOT NULL,"
            "  rows INTEGER NOT NULL DEFAULT 0,"
            # Counts worth seeing at a glance, as JSON ({"samples": 709, ...}).
            "  detail TEXT NOT NULL DEFAULT '{}',"
            "  loader_version INTEGER NOT NULL,"
            "  pulled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  UNIQUE (dataset, year, scope, loader_version)"
            ")"
        )
        # One computed score: a food, which samples (organic, conventional or
        # all; which years), which method — and the verdict the method's
        # written bands give. Rebuilt whenever it is recomputed; the terms
        # below show the working.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS exposure_scores ("
            "  id INTEGER PRIMARY KEY,"
            "  food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,"
            "  method TEXT NOT NULL,"
            "  claim TEXT NOT NULL CHECK (claim IN ('conventional','organic','all')),"
            # The data years as text: '2023', or '2017,2018' when combined.
            "  years TEXT NOT NULL,"
            "  sample_count INTEGER NOT NULL,"
            "  pesticide_count INTEGER NOT NULL,"
            "  detected_count INTEGER NOT NULL,"
            # Pesticides found with no EPA chronic dose to score them against.
            "  no_dose_count INTEGER NOT NULL,"
            "  total_dri REAL NOT NULL,"
            "  max_dri REAL NOT NULL,"
            "  verdict TEXT NOT NULL CHECK (verdict IN ('organic','some','conventional','open')),"
            # The reference person and serving the score assumed, as JSON.
            "  reference TEXT NOT NULL DEFAULT '{}',"
            "  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
            "  UNIQUE (food_id, method, claim, years)"
            ")"
        )
        # The working behind a score: one line per pesticide tested.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS exposure_terms ("
            "  score_id INTEGER NOT NULL REFERENCES exposure_scores(id) ON DELETE CASCADE,"
            "  pesticide_code TEXT NOT NULL,"
            "  pesticide TEXT NOT NULL,"
            "  hazard_id INTEGER REFERENCES hazards(id) ON DELETE SET NULL,"
            "  samples_tested INTEGER NOT NULL,"
            "  samples_detected INTEGER NOT NULL,"
            # Mean over every sample tested, a non-detect counted as zero; and
            # the highest single sample. Both in ppb.
            "  mean_ppb REAL NOT NULL,"
            "  max_ppb REAL,"
            # The chronic safe dose used (mg/kg/day) and the fact it came from.
            "  dose REAL,"
            "  dose_fact_id INTEGER REFERENCES hazard_facts(id) ON DELETE SET NULL,"
            "  dri REAL,"
            "  PRIMARY KEY (score_id, pesticide_code)"
            ")"
        )
        # A source's own file (a PDF) kept in the commons, so it can be shown
        # beside its claims exactly as published.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS source_files ("
            "  source_id TEXT PRIMARY KEY REFERENCES research_entries(id) ON DELETE CASCADE,"
            "  commons_path TEXT NOT NULL,"
            "  sha256 TEXT NOT NULL,"
            "  pages INTEGER,"
            "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # Which page of that file a highlighted passage falls on, so the PDF
        # opens at it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS passage_pages ("
            "  annotation_id TEXT PRIMARY KEY"
            "    REFERENCES research_annotations(id) ON DELETE CASCADE,"
            "  page INTEGER NOT NULL"
            ")"
        )
    if version < 37:
        # Rung 37: the room helper (room_helper.py) — one helper per room, a
        # layer above the swarm helpers, that forms, joins, splits and
        # releases swarms. RECORDS, all of them: nothing here can be rebuilt.
        #
        # Its summary of each session working alone. Swarm members' summaries
        # live on swarm_members; this is the same thing for everyone else.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS session_summaries ("
            "  conv TEXT PRIMARY KEY,"
            "  summary TEXT,"
            "  summary_at TEXT"
            ")"
        )
        # Where the room helper put a session. A placement OVERRIDES who has
        # messaged whom: messages between this session and anyone, sent at
        # or before `at`, no longer link it (swarms.sync). swarm_id NULL means
        # released — working alone. One row per session; the latest wins.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS swarm_pins ("
            "  conv TEXT PRIMARY KEY,"
            "  swarm_id INTEGER REFERENCES swarms(id),"
            "  at TEXT NOT NULL,"
            "  move_id INTEGER"
            ")"
        )
        # Every move the room helper made, with its reason and what it
        # replaced, so any move can be undone.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS room_moves ("
            "  id INTEGER PRIMARY KEY,"
            "  at TEXT NOT NULL,"
            "  room TEXT NOT NULL,"
            # form (a new swarm from sessions working alone), join, split, release.
            "  kind TEXT NOT NULL,"
            # JSON list of the sessions moved, continuation chains included.
            "  convs TEXT NOT NULL,"
            "  from_swarm INTEGER,"
            "  to_swarm INTEGER,"
            "  reason TEXT,"
            # JSON {conv: [swarm_id, at] or null}: each session's placement
            # before this move — what an undo puts back.
            "  before TEXT NOT NULL,"
            "  undone_at TEXT"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS room_helper_runs ("
            "  id INTEGER PRIMARY KEY,"
            "  room TEXT NOT NULL,"
            "  at TEXT NOT NULL,"
            "  trigger TEXT,"
            "  input TEXT,"
            "  output TEXT,"
            "  cost_usd REAL,"
            "  error TEXT"
            ")"
        )
    if version < 38:
        # Rung 38: the states and provinces a proposal is drawn as, anywhere in
        # the world — Peru's Junín, Mexico's Sinaloa and Sonora, Texas. One row
        # per region, keyed by its ISO 3166-2 code ('PE-JUN', 'US-TX'), with
        # its name. A proposal with rows here has area_kind 'state' (a
        # first-level region, not only a US state); the outlines themselves
        # come from Natural Earth in the commons (georegions.py). Machine
        # output, like the rest of the proposal tables.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS source_proposal_regions ("
            "  proposal_id INTEGER NOT NULL REFERENCES source_proposals(id) ON DELETE CASCADE,"
            "  code TEXT NOT NULL CHECK (code LIKE '__-%'),"
            "  seq INTEGER NOT NULL DEFAULT 0,"
            "  name TEXT NOT NULL DEFAULT '',"
            "  PRIMARY KEY (proposal_id, code)"
            ")"
        )
    if version < 39:
        # Rung 39: what a recipe gives, nutrient by nutrient (recipe_nutrition.py).
        # Two of her RECORDS, written only through foodstore.py and backed up
        # in food_catalog.json with the rest of the catalog.
        #
        # Which USDA FoodData Central entry a catalog food is: "carrots" is
        # fdc 170393 "Carrots, raw". One per food. A food without a row here
        # gets a suggested entry by name, counted but marked as a guess.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS food_usda ("
            "  food_id INTEGER PRIMARY KEY REFERENCES foods(id) ON DELETE CASCADE,"
            "  fdc_id INTEGER NOT NULL,"
            "  set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
            ")"
        )
        # Her own weight for one recipe line, when the amount as written
        # ("a drizzle", "1 small") can't be weighed or was weighed wrong.
        # Keyed by the line's text, not its position, so reordering the
        # recipe keeps it; `for_amount` is the amount it was set against, so
        # an edited amount shows the weight as out of date instead of using it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS recipe_line_grams ("
            "  recipe_id TEXT NOT NULL,"
            "  line TEXT NOT NULL,"
            "  grams REAL NOT NULL CHECK (grams >= 0),"
            "  for_amount TEXT,"
            "  PRIMARY KEY (recipe_id, line)"
            ")"
        )
    if version < 40:
        # Rung 40: a helper's watches (watches.py). When a helper promises
        # her "I'll tell you when session X ships", it sets a watch; the
        # minute tick checks each one and wakes the helper's chat once when
        # it fires. RECORDS: what was promised, and what happened.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS helper_watches ("
            "  id INTEGER PRIMARY KEY,"
            # The helper (or any session) that set it, and is woken.
            "  owner_conv TEXT NOT NULL,"
            # The session watched — moved on to its continuation if it hands off.
            "  conv TEXT NOT NULL,"
            # Comma list of what to watch for: done, asked, committed, stalled, error.
            "  kinds TEXT NOT NULL,"
            # What the helper promised, in its own words.
            "  note TEXT NOT NULL,"
            "  created_at TEXT NOT NULL,"
            # How far into `conv`'s transcript (bytes) was already there when it
            # was set: only lines after this count as news.
            "  since_offset INTEGER NOT NULL DEFAULT 0,"
            # watching, fired, dropped or expired.
            "  status TEXT NOT NULL DEFAULT 'watching',"
            "  closed_at TEXT,"
            # What happened, as the wake-up said it.
            "  event TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS helper_watches_status"
                     " ON helper_watches (status, owner_conv)")
    if version < 41:
        # Rung 41: what each Observatory turn really cost, per model
        # (toolcallstore.py). DERIVED from the logs, like turn_results.
        #
        # turn_results can't be summed for this. When one harness process
        # runs several turns, its result event's total_cost_usd and
        # modelUsage are RUNNING TOTALS for the process (only `usage` is per
        # turn), and turn_results.model is just the first model listed. So
        # turn_results keeps the raw figures, now including the raw
        # modelUsage (the next turn needs it to subtract), and turn_usage
        # holds the per-turn, per-model share: the table to add up.
        # Guarded, like rung 31's: a replayed ladder finds the column there.
        try:
            conn.execute("ALTER TABLE turn_results ADD COLUMN model_usage TEXT")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
        conn.execute(
            "CREATE TABLE IF NOT EXISTS turn_usage ("
            "  conv TEXT NOT NULL,"
            "  seq INTEGER NOT NULL,"
            # '' when the log didn't say (a helper's summary, an old turn).
            "  model TEXT NOT NULL,"
            "  input_tokens INTEGER NOT NULL DEFAULT 0,"
            "  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,"
            "  cache_read_tokens INTEGER NOT NULL DEFAULT 0,"
            "  output_tokens INTEGER NOT NULL DEFAULT 0,"
            "  thinking_tokens INTEGER NOT NULL DEFAULT 0,"
            # The harness's own estimate at API list prices, this turn only.
            "  cost_usd REAL NOT NULL DEFAULT 0,"
            "  PRIMARY KEY (conv, seq, model)"
            ")"
        )
    if version < 42:
        # Rung 42: file alerts (file_alerts.py). When two open sessions are in
        # the same file, the app writes it down — once per pair and file —
        # for the room helper to read. This table is that "once": its unique
        # key refuses a second row. RECORDS, not derived: the tool-call log
        # can't say which overlaps the helper has already been shown.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS file_alerts ("
            "  id INTEGER PRIMARY KEY,"
            "  at TEXT NOT NULL,"
            # 'same-file' (both changed it) or 'stale-copy' (one changed it
            # after the other read it).
            "  kind TEXT NOT NULL,"
            # The file, as an absolute path.
            "  path TEXT NOT NULL,"
            # The two lines of work, each named by its first session (a
            # session and its continuations are one line), lower id first.
            "  line_a TEXT NOT NULL,"
            "  line_b TEXT NOT NULL,"
            # For 'same-file': the two sessions carrying those lines when it
            # was noticed. For 'stale-copy': conv_a changed the file, conv_b had
            # read it.
            "  conv_a TEXT NOT NULL,"
            "  conv_b TEXT NOT NULL,"
            # What caught it: always 'tick', the minute check.
            "  source TEXT NOT NULL DEFAULT 'tick',"
            "  UNIQUE (path, line_a, line_b)"
            ")"
        )
        # Widen the mailbox's CHECK to allow kind 'S', a notice from the app.
        # Nothing sends one now: the code that did (file alerts told straight
        # to the sessions) was removed, and the wide CHECK is kept only so
        # every install's table has the same shape — a few old 'S' rows may
        # exist. SQLite can't alter a CHECK, so a mailbox made before this
        # rung is rebuilt: make the new table, copy every row, drop the old,
        # rename. A database made at this version already has the wide CHECK
        # (rung 29 makes it so), and this is skipped.
        made = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table'"
                            " AND name = 'agent_messages'").fetchone()
        if made and "'S'" not in made[0]:
            columns = ("id, at, kind, from_conv, to_conv, text, mode, hops, status,"
                       " held_reason, delivered_at, delivered_how, record")
            conn.execute("DROP TABLE IF EXISTS agent_messages_new")
            _create_agent_messages(conn, "agent_messages_new")
            conn.execute(f"INSERT INTO agent_messages_new ({columns})"
                         f" SELECT {columns} FROM agent_messages")
            conn.execute("DROP TABLE agent_messages")
            conn.execute("ALTER TABLE agent_messages_new RENAME TO agent_messages")
            _index_agent_messages(conn)
    if version < 43:
        # Rung 43: say whether the two sessions were told (file_alerts.py).
        # An overlap is only written down for the helpers, so new rows are
        # 0. An earlier build told the sessions too, and every row written
        # before this rung comes from it, so those are marked told.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(file_alerts)")}
        if "told" not in columns:
            conn.execute("ALTER TABLE file_alerts ADD COLUMN told INTEGER NOT NULL DEFAULT 0")
            conn.execute("UPDATE file_alerts SET told = 1")
    if version < 44:
        # Rung 44: the Linear feed (linear_feed.py). Once a minute the app
        # asks Linear what changed and writes down each thing someone other
        # than the owner did — once. This table is that "once": `key` is
        # unique, so the same comment or move read again adds nothing.
        # RECORDS: Linear keeps the history, but not which of it the Linear
        # helper has been told.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS linear_events ("
            "  id INTEGER PRIMARY KEY,"
            # What makes the event itself: Linear's id for the comment or
            # history row, plus what changed.
            "  key TEXT NOT NULL UNIQUE,"
            # When it happened, by Linear's clock (UTC), and when the app saw it.
            "  at TEXT NOT NULL,"
            "  seen_at TEXT NOT NULL,"
            # comment, created, status, assignee, title, description,
            # priority, labels, project, due, archived.
            "  kind TEXT NOT NULL,"
            "  issue_id TEXT,"
            "  identifier TEXT,"
            "  title TEXT,"
            "  url TEXT,"
            "  actor_id TEXT,"
            "  actor TEXT,"
            # One plain line: what they did. And a comment's own words.
            "  summary TEXT NOT NULL,"
            "  body TEXT,"
            # 1 when it calls on the owner: a comment, or an issue given to her.
            "  for_owner INTEGER NOT NULL DEFAULT 0,"
            # When the Linear helper was woken with it. Empty: still waiting.
            "  told_at TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS linear_events_at ON linear_events (at)")
    if version < 45:
        # Rung 45: closing summaries (swarm_helper.py). When a swarm closes,
        # its helper writes what the swarm did, in plain words, beside the
        # closing check built from git and the session records. One row per
        # time it closed: a swarm that opens again and closes again gets a
        # second row, and the first is kept. RECORDS: the transcripts stay,
        # but what the helper wrote about them can't be rebuilt.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS swarm_closings ("
            "  id INTEGER PRIMARY KEY,"
            "  swarm_id INTEGER NOT NULL REFERENCES swarms(id),"
            "  at TEXT NOT NULL,"
            # The swarm's name when it closed.
            "  name TEXT,"
            # The helper's account: one sentence, then the whole of it.
            # Both empty when the model call failed (see `error`).
            "  headline TEXT,"
            "  summary TEXT,"
            # The closing check: what git and the session records say.
            "  facts TEXT NOT NULL,"
            # Everything the model was handed, verbatim.
            "  input TEXT,"
            "  cost_usd REAL,"
            "  error TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS swarm_closings_by_swarm"
                     " ON swarm_closings (swarm_id, at)")
    if version < 46:
        # Rung 46: spinoff briefs (briefstore.py). What each spun-off session
        # was asked to do, the files preloaded into its instructions, and the
        # handoffs sessions write when they fill their context. They used to
        # be a folder of files per job (spinoffs/<slug>/BRIEF.md, CONTEXT.md,
        # HANDOFF.md). RECORDS: a brief is the only account of what a session
        # was asked for, so the briefs and handoffs are dumped as text by the
        # hourly backup. The contexts sit in a table of their own so that dump
        # stays small: a context is a copy of files that were on disk.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS spinoff_briefs ("
            "  id INTEGER PRIMARY KEY,"
            # The job's name: a few lowercase words joined by hyphens.
            "  slug TEXT NOT NULL,"
            "  written_at TEXT NOT NULL,"
            # The session that wrote it. Empty: the app itself, or a terminal.
            "  written_by TEXT,"
            # The brief, whole. It is the new session's first message.
            "  body TEXT NOT NULL,"
            # The session started on it. Empty until one is.
            "  conv TEXT,"
            "  opened_at TEXT,"
            # The session whose work this one carries on, for a continuation.
            "  continues TEXT,"
            # Which listed files were pasted into the instructions, and which
            # were too big and left for the session to read. JSON lists.
            "  preloaded TEXT,"
            "  too_big TEXT,"
            # The folder it was imported from, for a brief that began as a file.
            "  imported_from TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS spinoff_briefs_by_slug"
                     " ON spinoff_briefs (slug, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS spinoff_briefs_by_conv"
                     " ON spinoff_briefs (conv)")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS spinoff_contexts ("
            "  brief_id INTEGER PRIMARY KEY REFERENCES spinoff_briefs(id),"
            "  at TEXT NOT NULL,"
            # The session's hidden instructions: the Protocol and the files.
            "  body TEXT NOT NULL"
            ")"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS spinoff_handoffs ("
            "  id INTEGER PRIMARY KEY,"
            # The session that wrote it. Empty for an imported file whose
            # writer couldn't be worked out.
            "  conv TEXT,"
            "  at TEXT NOT NULL,"
            "  body TEXT NOT NULL,"
            # The session that took over from it. Empty until one does.
            "  to_conv TEXT,"
            # For an imported file: the job folder it sat in and its name.
            "  slug TEXT,"
            "  imported_from TEXT"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS spinoff_handoffs_by_conv"
                     " ON spinoff_handoffs (conv)")
    if version < _SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")


def _create_agent_messages(conn, name):
    """Make the mailbox table (peermail.py) under `name`, with its indexes.
    Rung 29 makes it; rung 42 makes it again under a spare name to swap in,
    because SQLite can't change a CHECK on a table that exists."""
    # (The statement's first two words are written apart so the test that
    # reads this file for table names doesn't take `{name}` for one.)
    conn.execute(
        "CREATE " f"TABLE IF NOT EXISTS {name} ("
        "  id INTEGER PRIMARY KEY,"
        "  at TEXT NOT NULL,"
        "  kind TEXT NOT NULL CHECK (kind IN ('A','B','S')),"
        # The sending session; NULL when the owner or the app sent it.
        "  from_conv TEXT,"
        "  to_conv TEXT NOT NULL,"
        "  text TEXT NOT NULL,"
        # What the SENDER asked for. The recipient's accept policy can
        # soften it at delivery time (peermail.effective_mode).
        "  mode TEXT NOT NULL DEFAULT 'inject'"
        "    CHECK (mode IN ('inject','queue','interrupt')),"
        # How many agent-to-agent wakes led here with no owner message in
        # between — the loop guard reads it.
        "  hops INTEGER NOT NULL DEFAULT 0,"
        # waiting -> delivered, or held (loop guard / daily cap, until the
        # owner releases it), or cancelled (the owner took it back).
        "  status TEXT NOT NULL DEFAULT 'waiting'"
        "    CHECK (status IN ('waiting','held','delivered','cancelled')),"
        "  held_reason TEXT,"
        "  delivered_at TEXT,"
        # 'handed' (written into a running agent, not read yet),
        # 'injected' (read mid-turn) or 'batched' (started a turn of its
        # own). delivered_at is when it was read or started the turn.
        "  delivered_how TEXT,"
        # Owner messages only: journaled or said off the record.
        "  record INTEGER NOT NULL DEFAULT 1"
        ")"
    )
    _index_agent_messages(conn)


def _index_agent_messages(conn):
    """The mailbox's two indexes, made only once the table has its real name."""
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table'"
                    " AND name = 'agent_messages'").fetchone():
        conn.execute("CREATE INDEX IF NOT EXISTS agent_messages_waiting"
                     " ON agent_messages (to_conv, status, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS agent_messages_by_day"
                     " ON agent_messages (kind, at)")


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
        begin_immediate(conn)
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
        begin_immediate(conn)
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
