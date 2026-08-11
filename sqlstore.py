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

_SCHEMA_VERSION = 11


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
    conn = sqlite3.connect(_db_path(), timeout=_BUSY_MS / 1000, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(f"PRAGMA busy_timeout={_BUSY_MS}")
    conn.execute("PRAGMA foreign_keys=ON")
    _migrate(conn)
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


# Every table a fully-migrated database must have. This is the cross-check that
# makes the version stamp trustworthy — see _migrate.
_EXPECTED_TABLES = (
    "docs",
    "habits", "habit_aliases", "habit_entries",
    "expenses", "expense_categories",
    "files", "file_paths", "commits", "commit_files",
    "sessions", "session_files", "session_turns",
    "cards", "card_tags",
    "todos", "fronts", "todo_fronts", "todo_subtasks",
    "job_runs",
    "attention_segments",
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
        _run_ladder(conn)
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass
        raise


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
