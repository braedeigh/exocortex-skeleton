"""SQL lab — a read-only window onto exo.db, for learning by poking at it.

Four endpoints:

  GET  /api/sql/schema  — every table, its columns, and its row count. This is
                          what the console's sidebar draws.
  GET  /api/sql/collections
                        — the map view's data: every blob collection sized and
                          classified (how many records, what shape, when last
                          written), plus the typed tables alongside.
  POST /api/sql/query   — run ONE read-only statement and get columns + rows
                          back, along with the query plan and how long it took.
  POST /api/sql/rebuild — re-derive every typed table from its JSON blob
                          (habitstore + expensestore), so experimenting is
                          undoable.

**Why the plan comes back with every result.** The point of this page is to
build intuition, and `EXPLAIN QUERY PLAN` is where indexes stop being folklore:
run a query, see `SCAN habit_entries`, add an index, run it again, watch it
become `SEARCH habit_entries USING INDEX`. It costs one extra cheap call.

Safety — this runs arbitrary SQL against the database of record, so it is
locked down four ways, none of which is sufficient alone:

  1. The connection is opened `mode=ro`. SQLite itself refuses any write, so a
     statement that slips past the parser check still cannot change anything.
  2. Exactly one statement per request, checked with sqlite3.complete_statement
     — no `SELECT 1; DROP TABLE docs`.
  3. The statement must start with SELECT, WITH, or EXPLAIN. PRAGMA is excluded
     deliberately: some pragmas write, and a read-only connection's error for
     them is confusing rather than instructive.
  4. A wall-clock cap via a progress handler, so a runaway cross join returns an
     error instead of pinning a gunicorn worker.

Results are capped at MAX_ROWS and the response says when it truncated — a
silent cut would read as "that's all there is", which is the one lie a learning
tool must not tell.

Registered in server.py, so it sits behind the app's auth gate like everything
else. Reads exo.db directly rather than through store.py because the whole
point is the tables, not the blob collections.

Prompt that produced this file: "Wire the typed tables up so I can mess with
them and understand them — a read-only SQL console over the database, with the
schema listed and the query plan shown."
"""
import json
import re
import sqlite3
import time

from flask import jsonify, request

import codestore
import expensestore
import habitstore
import store

MAX_ROWS = 500
TIMEOUT_SECONDS = 5.0

# The tables that are real columns rather than a JSON blob. Listed rather than
# sniffed so the map can count them without guessing what qualifies. Note that
# 'expenses' appears here AND as a blob collection: during the migration the
# blob is still the source of truth and the table is derived from it, so both
# are real and the response keeps them in separate lists.
TYPED_TABLES = ("habits", "habit_aliases", "habit_entries",
                "expenses", "expense_categories",
                "files", "file_paths", "commits", "commit_files",
                "sessions", "session_files")

_DATE_KEY = re.compile(r"^\d{4}-\d{2}-\d{2}")

# Everything else is rejected before it reaches SQLite. WITH is here so CTEs and
# window-function queries work — those are most of what's worth learning.
ALLOWED_STARTS = ("select", "with", "explain")


def _read_only_conn():
    """A connection SQLite itself will not let anything write through."""
    conn = sqlite3.connect(
        f"file:{store.DATA_DIR / 'exo.db'}?mode=ro", uri=True, timeout=5
    )
    conn.execute("PRAGMA query_only = ON")
    return conn


def _guard(sql):
    """Return an error string if this isn't a single read-only statement."""
    stripped = sql.strip().rstrip(";").strip()
    if not stripped:
        return "Empty query."
    if not stripped.lower().startswith(ALLOWED_STARTS):
        return "Only SELECT, WITH, and EXPLAIN queries are allowed here."
    # complete_statement is SQLite's own parser: if the text up to the first
    # semicolon already forms a whole statement, anything after it is a second
    # one. Needs the trailing ';' to judge completeness.
    head, sep, tail = stripped.partition(";")
    if sep and tail.strip() and sqlite3.complete_statement(head + ";"):
        return "One statement at a time."
    return None


def _unwrap(value):
    """Peel single-key envelopes: {"recipes": [...]} is 10 recipes, not 1 thing.

    Almost every collection wraps its payload in one named key, so counting the
    top level would report "1 record" for nearly all 50 of them and make the map
    say nothing at all.

    Stops at a date key. A log with exactly one day recorded — a fresh install,
    or the first day of a new collection — is a one-key dict too, and peeling it
    would report that log as whatever its single day happens to contain.
    """
    while isinstance(value, dict) and len(value) == 1:
        key = next(iter(value))
        if _DATE_KEY.match(str(key)):
            break
        inner = value[key]
        if not isinstance(inner, (list, dict)):
            break
        value = inner
    return value


def _classify(payload):
    """(kind, record count) for an unwrapped payload.

    The kinds are the three real shapes in this database, and they behave
    differently enough to be worth telling apart at a glance:

      log      — keyed by date, one entry per day, grows forever
      registry — a list of records you add to and edit
      config   — a small settings map that stays about this size
      keyed    — a dict keyed by name/page: a registry with lookup built in
    """
    if isinstance(payload, list):
        return "registry", len(payload)
    if isinstance(payload, dict):
        count = len(payload)
        dated = sum(1 for k in payload if _DATE_KEY.match(str(k)))
        if count and dated > count * 0.6:
            return "log", count
        return ("config" if count <= 8 else "keyed"), count
    return "scalar", 0


def _deadline_handler(deadline):
    """SQLite calls this every N opcodes; returning non-zero aborts the query."""
    def handler():
        return 1 if time.monotonic() > deadline else 0
    return handler


def register(app):

    @app.route("/api/sql/schema")
    def sql_schema():
        conn = _read_only_conn()
        try:
            tables = [
                r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                    " AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            ]
            out = []
            for name in tables:
                cols = [
                    {"name": c[1], "type": c[2] or "", "notnull": bool(c[3]),
                     "pk": bool(c[5])}
                    for c in conn.execute(f'PRAGMA table_info("{name}")')
                ]
                # Table names come from sqlite_master, not from user input, so
                # interpolating them here can't be injection — but they still
                # get quoted, because a table named `order` would break the SQL.
                count = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
                indexes = [
                    {"name": i[1], "unique": bool(i[2])}
                    for i in conn.execute(f'PRAGMA index_list("{name}")')
                ]
                out.append({"name": name, "columns": cols, "rows": count,
                            "indexes": indexes})
            return jsonify({"tables": out})
        finally:
            conn.close()

    @app.route("/api/sql/collections")
    def sql_collections():
        """Every collection, sized and classified — the map view's data.

        Blob collections and typed tables are returned SEPARATELY rather than in
        one sorted list, because their record counts live on different scales
        (a blob tops out around 120 records; habit_entries is in the thousands)
        and one shared axis would flatten every blob into an invisible sliver.
        Two charts, two scales — never one axis pretending to serve both.
        """
        conn = _read_only_conn()
        try:
            blobs = []
            for name, text, updated in conn.execute(
                "SELECT name, data, updated_at FROM docs ORDER BY name"
            ):
                try:
                    payload = _unwrap(json.loads(text))
                except ValueError:
                    kind, records = "unreadable", 0
                else:
                    kind, records = _classify(payload)
                blobs.append({
                    "name": name, "kind": kind, "records": records,
                    "bytes": len(text), "updated_at": updated,
                })

            typed = []
            for name in TYPED_TABLES:
                row = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()
                typed.append({"name": name, "kind": "table", "records": row[0]})
            return jsonify({"blobs": blobs, "typed": typed})
        except sqlite3.OperationalError as e:
            # The typed tables don't exist until the v3 migration has run.
            return jsonify({"error": str(e)}), 500
        finally:
            conn.close()

    @app.route("/api/sql/query", methods=["POST"])
    def sql_query():
        sql = ((request.json or {}).get("sql") or "").strip()
        problem = _guard(sql)
        if problem:
            return jsonify({"error": problem}), 400

        conn = _read_only_conn()
        conn.set_progress_handler(_deadline_handler(time.monotonic() + TIMEOUT_SECONDS), 10_000)
        try:
            started = time.monotonic()
            cur = conn.execute(sql)
            rows = cur.fetchmany(MAX_ROWS + 1)
            elapsed = (time.monotonic() - started) * 1000
            truncated = len(rows) > MAX_ROWS
            rows = rows[:MAX_ROWS]
            columns = [d[0] for d in cur.description] if cur.description else []

            plan = []
            if not sql.lower().startswith("explain"):
                try:
                    conn.set_progress_handler(None, 0)
                    plan = [r[3] for r in conn.execute(f"EXPLAIN QUERY PLAN {sql}")]
                except sqlite3.Error:
                    pass  # the plan is a nicety; never fail a good query over it
            return jsonify({
                "columns": columns,
                "rows": [list(r) for r in rows],
                "truncated": truncated,
                "limit": MAX_ROWS,
                "ms": round(elapsed, 1),
                "plan": plan,
            })
        except sqlite3.OperationalError as e:
            # The progress handler aborts with this same generic message, so say
            # which one it was rather than showing "interrupted" for a typo.
            if "interrupted" in str(e).lower():
                return jsonify({"error": f"Query took longer than {TIMEOUT_SECONDS:.0f}s "
                                         "and was stopped."}), 400
            return jsonify({"error": str(e)}), 400
        except sqlite3.Error as e:
            return jsonify({"error": str(e)}), 400
        finally:
            conn.close()

    @app.route("/api/sql/rebuild", methods=["POST"])
    def sql_rebuild():
        """Re-derive every typed table from its source — the undo button.

        Nothing here can hurt the sources: all three rebuilds only read them
        (JSON blobs for habits and expenses; git + the bot_chats sidecars for
        code history).
        """
        habits = habitstore.rebuild()
        expenses = expensestore.rebuild()
        code = codestore.rebuild()
        return jsonify({"ok": True, "habits": habits, "expenses": expenses,
                        "code": code})
