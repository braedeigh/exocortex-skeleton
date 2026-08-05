"""SQL sandbox — a database you are allowed to wreck.

The console at /api/sql is read-only, because it points at the database of
record. That makes it useless for learning the other half of SQL: you cannot
write a row, cannot have a constraint reject you, cannot watch a transaction
roll back. This is the other half. It runs against a **separate file**
(`sandbox.db`), so every guard the console needs can be dropped.

What it does differently from the console:

  - **Any statement type.** INSERT, UPDATE, DELETE, CREATE, DROP, BEGIN,
    ROLLBACK. Nothing is filtered.
  - **Many statements per request, run one at a time**, each with its own
    result. That's what makes transactions legible: you see the INSERT succeed,
    the second one fail, and the ROLLBACK undo both — as three separate
    outcomes rather than one opaque error.
  - **The schema comes back with every response**, so the table list and row
    counts update the instant a statement changes them.

Statements run on ONE connection per request with `isolation_level=None`, so
Python adds no implicit transaction of its own — BEGIN / COMMIT / ROLLBACK mean
exactly what they say. That is the entire point of the transaction lesson.

Safety is by isolation, not by restriction: `_db_path()` refuses to resolve to
exo.db, so there is no statement you can type here that reaches real data. The
only limits kept are a statement cap, a row cap and a wall-clock cap, which
exist to protect the gunicorn worker rather than the data.

The file defaults to DATA_DIR/sandbox.db and is gitignored in the vault — the
index lesson puts a few hundred thousand rows in it, which has no business in
an hourly backup commit.

Registered in server.py, so it sits behind the app's auth gate.

Prompt that produced this file: "make a sandbox with all the options selectable
and the outputs and stuff" — a writable scratch database where the statement
types and clauses are pickable rather than remembered, and each one shows what
it did.
"""
import os
import sqlite3
import time

from flask import jsonify, request

import store

MAX_ROWS = 500
MAX_STATEMENTS = 50
TIMEOUT_SECONDS = 10.0
MAX_BULK_ROWS = 500_000


def _db_path():
    """The sandbox file — never, ever the real database.

    The guard is not paranoia about a typo: this module deliberately allows
    DROP TABLE, so a misconfigured path here would be the single most
    destructive line in the codebase.
    """
    configured = os.environ.get("EXOCORTEX_SANDBOX_DB")
    path = configured or str(store.DATA_DIR / "sandbox.db")
    if os.path.basename(path) == "exo.db":
        raise RuntimeError("refusing to use the real database as a sandbox")
    return path


def _connect():
    """isolation_level=None: Python opens no transaction behind your back, so
    BEGIN/COMMIT/ROLLBACK behave literally. Foreign keys ON, because half the
    lessons here are about what a foreign key refuses to let you do."""
    conn = sqlite3.connect(_db_path(), timeout=5, isolation_level=None)
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _split(sql):
    """Split a script into whole statements, using SQLite's own parser.

    Naively splitting on ';' would cut a semicolon inside a string literal or a
    trigger body in half. complete_statement knows the difference.

    Scans character by character rather than line by line: `SELECT 1; SELECT 2;`
    is two statements even though it's one line, and a line-based split would
    hand the whole thing to SQLite, which executes exactly one statement per
    call and would either error or silently run only the first.
    """
    out, buf = [], []
    for ch in sql:
        buf.append(ch)
        if ch == ";":
            candidate = "".join(buf)
            if sqlite3.complete_statement(candidate):
                if candidate.strip():
                    out.append(candidate.strip())
                buf = []
    tail = "".join(buf)
    if tail.strip():
        out.append(tail.strip())
    return out


def _schema(conn):
    """Every table with its columns and live row count — sent back after every
    request so the UI's schema panel can never drift from reality."""
    tables = []
    for (name,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
        " AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall():
        cols = [
            {"name": c[1], "type": c[2] or "", "notnull": bool(c[3]), "pk": bool(c[5])}
            for c in conn.execute(f'PRAGMA table_info("{name}")')
        ]
        count = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        indexes = [
            {"name": i[1], "unique": bool(i[2])}
            for i in conn.execute(f'PRAGMA index_list("{name}")')
        ]
        tables.append({"name": name, "columns": cols, "rows": count, "indexes": indexes})
    return tables


def _run_one(conn, sql):
    """Execute one statement and describe what it did.

    An error is a RESULT here, not a failure: 'UNIQUE constraint failed' is the
    lesson, so it comes back as data with the statement attached, and the rest
    of the script keeps running. Only that way does a ROLLBACK after a failed
    INSERT actually get to execute.
    """
    started = time.perf_counter()
    try:
        cur = conn.execute(sql)
        rows = cur.fetchmany(MAX_ROWS + 1) if cur.description else []
        truncated = len(rows) > MAX_ROWS
        return {
            "sql": sql,
            "ok": True,
            "columns": [d[0] for d in cur.description] if cur.description else [],
            "rows": [list(r) for r in rows[:MAX_ROWS]],
            "truncated": truncated,
            # -1 means "not a row-changing statement" in sqlite3; show nothing
            # rather than a confusing -1.
            "changed": cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else None,
            "ms": round((time.perf_counter() - started) * 1000, 3),
            "error": None,
        }
    except sqlite3.Error as e:
        return {
            "sql": sql,
            "ok": False,
            "columns": [], "rows": [], "truncated": False, "changed": None,
            "ms": round((time.perf_counter() - started) * 1000, 3),
            # The raw SQLite message on purpose — "UNIQUE constraint failed:
            # people.email" teaches more than any rewording of it would.
            "error": f"{type(e).__name__}: {e}",
        }


def register(app):

    @app.route("/api/sandbox/schema")
    def sandbox_schema():
        conn = _connect()
        try:
            return jsonify({"tables": _schema(conn)})
        finally:
            conn.close()

    @app.route("/api/sandbox/exec", methods=["POST"])
    def sandbox_exec():
        sql = ((request.json or {}).get("sql") or "").strip()
        if not sql:
            return jsonify({"error": "Nothing to run."}), 400
        statements = _split(sql)
        if not statements:
            return jsonify({"error": "Nothing to run."}), 400
        if len(statements) > MAX_STATEMENTS:
            return jsonify({"error": f"That's {len(statements)} statements; "
                                     f"the limit is {MAX_STATEMENTS}."}), 400

        conn = _connect()
        deadline = time.monotonic() + TIMEOUT_SECONDS
        results = []
        try:
            for stmt in statements:
                if time.monotonic() > deadline:
                    results.append({
                        "sql": stmt, "ok": False, "columns": [], "rows": [],
                        "truncated": False, "changed": None, "ms": 0,
                        "error": f"Stopped — the script passed {TIMEOUT_SECONDS:.0f}s.",
                    })
                    break
                results.append(_run_one(conn, stmt))
            # A script that ends mid-transaction would hold SQLite's write lock
            # past the request. Roll the leftover back and say so, rather than
            # leaving a lock nobody can see.
            open_txn = conn.in_transaction
            if open_txn:
                conn.execute("ROLLBACK")
            return jsonify({
                "results": results,
                "tables": _schema(conn),
                "rolled_back": open_txn,
            })
        finally:
            conn.close()

    @app.route("/api/sandbox/reset", methods=["POST"])
    def sandbox_reset():
        """Drop every table. The undo button that makes wrecking things safe."""
        conn = _connect()
        try:
            names = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
                " AND name NOT LIKE 'sqlite_%'")]
            conn.execute("PRAGMA foreign_keys=OFF")  # drop order shouldn't matter
            for name in names:
                conn.execute(f'DROP TABLE IF EXISTS "{name}"')
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("VACUUM")  # actually shrink the file after the index lesson
            return jsonify({"ok": True, "dropped": len(names), "tables": _schema(conn)})
        finally:
            conn.close()

    @app.route("/api/sandbox/bulk", methods=["POST"])
    def sandbox_bulk():
        """Fill a table with N generated rows, so a query can be slow enough to
        feel. At 1,765 rows an index is 27x faster and still invisible; at
        200,000 the difference is the whole point."""
        body = request.json or {}
        raw = body.get("rows")
        try:
            # Explicitly None, not falsy: `or` would turn a deliberate 0 into
            # the default and quietly build 200k rows nobody asked for.
            count = 200_000 if raw is None else int(raw)
        except (TypeError, ValueError):
            return jsonify({"error": "rows must be a number"}), 400
        if count < 1 or count > MAX_BULK_ROWS:
            return jsonify({"error": f"rows must be between 1 and {MAX_BULK_ROWS:,}"}), 400

        conn = _connect()
        try:
            started = time.perf_counter()
            conn.execute("DROP TABLE IF EXISTS big")
            conn.execute(
                "CREATE TABLE big ("
                "  id INTEGER PRIMARY KEY,"
                "  category TEXT NOT NULL,"
                "  amount INTEGER NOT NULL,"
                "  day TEXT NOT NULL"
                ")"
            )
            # Generated inside SQLite rather than in Python: no million-tuple
            # list in memory, and it's an incidental look at a recursive CTE.
            conn.execute("BEGIN")
            conn.execute(
                "WITH RECURSIVE seq(n) AS ("
                "  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?"
                ") INSERT INTO big (id, category, amount, day)"
                " SELECT n,"
                "        'cat-' || (n % 50),"
                "        (n * 7919) % 1000,"
                "        DATE('2020-01-01', '+' || (n % 2000) || ' days')"
                " FROM seq",
                (count,),
            )
            conn.execute("COMMIT")
            return jsonify({
                "ok": True, "rows": count,
                "ms": round((time.perf_counter() - started) * 1000, 1),
                "tables": _schema(conn),
            })
        finally:
            conn.close()
