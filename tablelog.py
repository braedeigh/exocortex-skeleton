"""The table log: which table was written, when, and by which agent session.

This file answers a question nothing else in the app could: "when did this
table last have a row written, and who did it?" The write journal
(writelog.py) only sees writes that pass through store.py, which reach a
handful of tables; most tables are written with SQL directly. So this sits
one level lower, at the one door every writer opens exo.db through
(sqlstore._connect), and notes what goes past.

HOW IT SEES A WRITE. SQLite lets a connection register an "authorizer": a
function it calls while it reads a statement, once for each thing the
statement is about to do — "insert into todos", "update expenses.amount".
`watch(conn)` registers one that always says yes, and on the way remembers
the table's name together with the connection's running count of changed
rows. The table is written down only once that count has gone UP — at the
connection's next write, at its COMMIT, or when it closes — so a housekeeping
DELETE that removes nothing, or an INSERT OR IGNORE that inserts nothing, is
not a write. (One blur is left: a statement that changed nothing, followed on
the same connection by one that did, are both counted.)

WHAT IT KEEPS. One small row per (table, kind, session, process, day) in its
own database, `table_log.db`, beside exo.db — first time, last time, and a
count. Two kinds:
  rows       an INSERT, UPDATE or DELETE on the table
  structure  the table was created or its definition changed — noted by
             sqlstore's migration ladder (`structure_changed`), and by an
             ALTER TABLE seen going past
The session is the agent conversation the process belongs to
(EXOCORTEX_CONV_ID, which every Observatory turn hands to the commands it
runs); empty for the app's own writes and for cron jobs.

WHAT IT CANNOT SEE — it under-reports rather than guesses:
  - anything before the day it was switched on (`recording_since`);
  - a write that skips the door: the `sqlite3` command line, or a script that
    opens exo.db itself;
  - a statement run again on a connection that already read it — SQLite only
    asks once per statement text per connection. Connections here are opened
    per operation, so in practice the first of a burst is what gets noted;
  - a connection that is never closed and never commits: its last statement
    is never confirmed.

FAIL-OPEN, ALWAYS. This runs inside every statement on the database of
record, so nothing in here may raise, refuse a statement, or wait long: every
path is wrapped, the answer to SQLite is always "allowed", a table is noted at
most once a minute per process, and the log's own database gives up after a
tenth of a second rather than queue. Kill switch: EXOCORTEX_TABLE_LOG_OFF=1.

Touches: sqlstore.py (the only caller of `watch` and `structure_changed`),
store.py (where the data directory is), routes/terrain_tables.py (the reader:
the Terrain map outlines each table by these times and tethers the agent that
wrote it).

Prompt that produced this file: "I'm also wanting for when an agent modifies
an SQL database it's displayed on terrain. Additionally, I want databases to
have red heat map outlines and yellow activity outlines" / "make the new
recorder" / "red comes from if a migration to the table happened or it was
created. A row creation is yellow."
"""
from datetime import datetime
import os
import sqlite3
import time
import weakref

import store

DB_NAME = "table_log.db"
_BUSY_SEC = 0.1          # how long the log waits on its own lock before giving up
_DEBOUNCE_SEC = 60       # a table is noted at most this often per process
_ROW_TIMES_MAX = 40      # the most write times handed back for one table

ROWS = "rows"
STRUCTURE = "structure"

# SQLite's action codes for the things worth noting. For the three row codes
# the table's name is the first argument; for ALTER TABLE it is the second
# (the first is the database's name).
_ROW_ACTIONS = frozenset({sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE})
_ALTER_ACTION = sqlite3.SQLITE_ALTER_TABLE

_noted = {}              # (db path, table, kind) -> when this process last wrote it down
_schema_ready = set()    # db paths whose log table this process has already made


def _off():
    """Checked fresh on every call so tests can flip it per-test."""
    return os.environ.get("EXOCORTEX_TABLE_LOG_OFF", "") == "1"


def _db_path():
    """Resolved per call so tests that move store.DATA_DIR get their own log."""
    return store.DATA_DIR / DB_NAME


def _connect():
    """Open the log's own database, making its one table the first time."""
    path = _db_path()
    conn = sqlite3.connect(path, timeout=_BUSY_SEC, isolation_level=None)
    if str(path) not in _schema_ready:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS table_activity ("
            "  table_name TEXT NOT NULL,"
            "  kind TEXT NOT NULL,"            # 'rows' or 'structure'
            "  conv TEXT NOT NULL DEFAULT '',"  # agent session; '' = not an agent
            "  caller TEXT NOT NULL,"          # the process, as the write journal names it
            "  day TEXT NOT NULL,"             # local YYYY-MM-DD
            "  first_at INTEGER NOT NULL,"     # unix seconds
            "  last_at INTEGER NOT NULL,"
            "  count INTEGER NOT NULL DEFAULT 1,"
            "  PRIMARY KEY (table_name, kind, conv, caller, day)"
            ")"
        )
        _schema_ready.add(str(path))
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


# --- recording ---------------------------------------------------------------

class Connection(sqlite3.Connection):
    """An exo.db connection that settles its table log when it is closed —
    the last chance to see whether the final statement changed any rows.
    Otherwise an ordinary connection; sqlstore._connect opens this kind."""

    _table_watcher = None

    def close(self):
        try:
            if self._table_watcher is not None:
                self._table_watcher.settle(drop_rest=True)
        except Exception:
            pass
        super().close()


class _Watcher:
    """One connection's memory of the writes it has seen but not yet confirmed.

    `pending` maps a table to the connection's changed-row count at the moment
    a statement writing that table was read. If the count is higher later, the
    statement really changed rows."""

    __slots__ = ("connection", "pending")

    def __init__(self, conn):
        # A weak reference, so the watcher never keeps its connection alive.
        self.connection = weakref.ref(conn)
        self.pending = {}

    def authorize(self, action, first, second, database, _source):
        """Say yes to every statement, and remember the table when it is a
        write.

        SQLite treats an exception here as "refuse the statement", so the
        whole body is wrapped: a fault in the log must never cost a real
        write."""
        try:
            if action in _ROW_ACTIONS:
                # Skip SQLite's own bookkeeping tables, and scratch tables
                # that only exist for one connection.
                if first and not first.startswith("sqlite_") and database != "temp":
                    conn = self.connection()
                    if conn is not None:
                        if self.pending:
                            self.settle()
                        self.pending.setdefault(first, conn.total_changes)
            elif action == _ALTER_ACTION:
                if second and not second.startswith("sqlite_") and first != "temp":
                    _note(second, STRUCTURE)
            elif action == sqlite3.SQLITE_TRANSACTION:
                # A transaction's end is a clean boundary: everything before a
                # COMMIT has finished running, and a ROLLBACK undoes it all.
                if first == "ROLLBACK":
                    self.pending.clear()
                elif first == "COMMIT":
                    self.settle(drop_rest=True)
        except Exception:
            pass
        return sqlite3.SQLITE_OK

    def settle(self, drop_rest=False):
        """Write down every remembered table whose statement changed rows.
        `drop_rest` forgets the ones that changed nothing — right at a COMMIT
        or a close, when no statement can still be running."""
        conn = self.connection()
        if conn is None:
            return
        changes = conn.total_changes
        for table in [t for t, seen in self.pending.items() if changes > seen]:
            del self.pending[table]
            try:
                _note(table, ROWS)
            except Exception:
                pass
        if drop_rest:
            self.pending.clear()


def watch(conn):
    """Start noting the writes this connection makes. Never raises."""
    if _off():
        return
    try:
        watcher = _Watcher(conn)
        conn.set_authorizer(watcher.authorize)
        if isinstance(conn, Connection):
            conn._table_watcher = watcher
    except Exception:
        pass


def structure_changed(tables):
    """Note that these tables were just created or had their definition
    changed. Called by sqlstore's migration ladder with the tables whose
    definition differs from before it ran. Never raises."""
    if _off():
        return
    for table in tables:
        try:
            _note(table, STRUCTURE, force=True)
        except Exception:
            pass


# The app's own processes. One of these can be STARTED by an agent (a session
# that spins off another launches that session's turn host) and so inherit the
# agent's conversation id — but what it writes is the app's bookkeeping about a
# turn, not an agent changing a table.
_APP_CALLERS = frozenset({"turn_host", "gunicorn"})


def _session(caller):
    """Which agent session this process is writing for: the conversation id
    every Observatory turn hands to the commands it runs, or '' when the
    process is the app itself or nothing set one."""
    if caller in _APP_CALLERS:
        return ""
    return os.environ.get("EXOCORTEX_CONV_ID") or ""


def _note(table, kind, force=False):
    """Write one sighting down — this is a debounce: a table already noted by
    this process in the last minute is skipped, so a burst of a thousand
    inserts costs one small write, not a thousand."""
    now = time.time()
    key = (str(_db_path()), table, kind)
    if not force and now - _noted.get(key, 0) < _DEBOUNCE_SEC:
        return
    _noted[key] = now
    stamp = int(now)
    caller = store._stats_caller()
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO table_activity"
            " (table_name, kind, conv, caller, day, first_at, last_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(table_name, kind, conv, caller, day) DO UPDATE SET"
            "  last_at = excluded.last_at, count = count + 1",
            (table, kind, _session(caller), caller,
             datetime.fromtimestamp(now).strftime("%Y-%m-%d"), stamp, stamp),
        )
    finally:
        conn.close()


# --- reading -----------------------------------------------------------------
# Readers fail open too: off, missing or locked comes back as the empty shape.

def activity():
    """Everything the log knows, per table:

        {table: {"rows_at": newest row write (unix seconds) or None,
                 "row_times": the newest write times, newest first,
                 "structure_at": newest structure change or None,
                 "sessions": [{"id", "writes", "last", "structure"}]}}

    `sessions` lists only agent sessions (a row with a conversation id);
    `writes` is how many times that session was noted writing the table and
    `structure` whether it changed the table's definition."""
    try:
        if _off() or not _db_path().is_file():
            return {}
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT table_name, kind, conv, last_at, count FROM table_activity"
                " ORDER BY last_at DESC").fetchall()
        finally:
            conn.close()
    except Exception:
        return {}

    out = {}
    for table, kind, conv, last_at, count in rows:
        entry = out.setdefault(table, {"rows_at": None, "row_times": [],
                                       "structure_at": None, "sessions": {}})
        if kind == ROWS:
            entry["rows_at"] = max(entry["rows_at"] or 0, last_at)
            if len(entry["row_times"]) < _ROW_TIMES_MAX:
                entry["row_times"].append(last_at)
        elif kind == STRUCTURE:
            entry["structure_at"] = max(entry["structure_at"] or 0, last_at)
        if conv:
            session = entry["sessions"].setdefault(
                conv, {"id": conv, "writes": 0, "last": 0, "structure": False})
            session["writes"] += count
            session["last"] = max(session["last"], last_at)
            session["structure"] = session["structure"] or kind == STRUCTURE
    for entry in out.values():
        entry["sessions"] = sorted(entry["sessions"].values(), key=lambda s: -s["last"])
    return out


def recording_since():
    """When the log's oldest sighting was made (unix seconds), or None when
    it is off or has seen nothing — "not recorded" starts before this."""
    try:
        if _off() or not _db_path().is_file():
            return None
        conn = _connect()
        try:
            return conn.execute("SELECT MIN(first_at) FROM table_activity").fetchone()[0]
        finally:
            conn.close()
    except Exception:
        return None
