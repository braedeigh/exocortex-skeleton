"""SQL lab — a read-only window onto exo.db, for learning by poking at it.

Three endpoints:

  GET  /api/sql/schema  — every table, its columns, and its row count. This is
                          what the console's sidebar draws, and the seed of the
                          "shape of my data" view.
  POST /api/sql/query   — run ONE read-only statement and get columns + rows
                          back, along with the query plan and how long it took.
  POST /api/sql/rebuild — re-derive the habit tables from habits_log
                          (habitstore.rebuild), so experimenting is undoable.

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
import sqlite3
import time

from flask import jsonify, request

import habitstore
import store

MAX_ROWS = 500
TIMEOUT_SECONDS = 5.0

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
        """Re-derive the habit tables from habits_log — the undo button.

        Nothing here can hurt the log: rebuild() reads it and never writes it.
        """
        count = habitstore.rebuild()
        return jsonify({"ok": True, "habits": count})
