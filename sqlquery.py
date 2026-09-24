"""One safe, read-only SQL door onto exo.db — shared by the SQL console and the agents.

Two callers use this file: the browser's SQL lab (`routes/sqlab.py`,
POST /api/sql/query) and the research agents' command line
(`scripts/exo_query.py`). Both used to need the same locks, and the console
had them inline; keeping one copy here means a hole fixed for one caller is
fixed for both. `run_query()` is the only thing most callers need.

Safety — this runs arbitrary SQL against the database of record, so it is
locked down four ways, none of which is sufficient alone:

  1. The connection is opened `mode=ro`. SQLite itself refuses any write, so a
     statement that slips past the parser check still cannot change anything.
  2. Exactly one statement per call, checked with sqlite3.complete_statement
     — no `SELECT 1; DROP TABLE docs`.
  3. The statement must start with SELECT, WITH, or EXPLAIN. PRAGMA is excluded
     deliberately: some pragmas write, and a read-only connection's error for
     them is confusing rather than instructive.
  4. A wall-clock cap via a progress handler, so a runaway cross join returns an
     error instead of pinning a gunicorn worker or an agent's turn.

A fifth, optional lock is `deny_tables`: a set of table names the caller is
not allowed to read. It is a FENCE, NOT A PROOF — see `_denied_table()` for
exactly what it checks and what it can miss.

Results are capped at `max_rows` and the result says when it truncated — a
silent cut would read as "that's all there is", which is the one lie a
learning tool (or a research agent) must not be told.

Reads exo.db directly rather than through store.py because the whole point is
the tables, not the blob collections. Touches: store.py (for DATA_DIR only),
routes/sqlab.py and scripts/exo_query.py (the two callers).

Prompt that produced this file: "Extract the read-only query core out of
routes/sqlab.py into one module both the SQL console and the agents' CLI can
call: same guard semantics, a row cap that reports truncation, a timeout, and
an optional deny-list of tables."
"""
import re
import sqlite3
import time

import store

MAX_ROWS = 500
TIMEOUT_SECONDS = 5.0

# Everything else is rejected before it reaches SQLite. WITH is here so CTEs and
# window-function queries work — those are most of what's worth learning.
ALLOWED_STARTS = ("select", "with", "explain")


def db_path():
    """Where exo.db is right now — resolved on every call, never cached, so a
    test that re-points store.DATA_DIR at a temp folder is honoured."""
    return store.DATA_DIR / "exo.db"


def read_only_connection():
    """A connection SQLite itself will not let anything write through."""
    conn = sqlite3.connect(f"file:{db_path()}?mode=ro", uri=True, timeout=5)
    conn.execute("PRAGMA query_only = ON")
    return conn


def guard(sql):
    """Refuse anything that isn't a single read-only statement.

    Returns (code, plain-English message) for a refusal, or None when the
    statement may run. The checks are textual and cheap; the read-only
    connection is the real wall behind them.
    """
    stripped = sql.strip().rstrip(";").strip()
    if not stripped:
        return "not_read_only", "Empty query."
    if not stripped.lower().startswith(ALLOWED_STARTS):
        return "not_read_only", "Only SELECT, WITH, and EXPLAIN queries are allowed here."
    # complete_statement is SQLite's own parser: if the text up to the first
    # semicolon already forms a whole statement, anything after it is a second
    # one. Needs the trailing ';' to judge completeness.
    head, sep, tail = stripped.partition(";")
    if sep and tail.strip() and sqlite3.complete_statement(head + ";"):
        return "multiple_statements", "One statement at a time."
    return None


def _deadline_handler(deadline):
    """SQLite calls this every N opcodes; returning non-zero aborts the query."""
    def handler():
        return 1 if time.monotonic() > deadline else 0
    return handler


def _mentions_table(text, table):
    """True when `table` appears in `text` as a whole word, any case."""
    return re.search(rf"\b{re.escape(table)}\b", text, re.IGNORECASE) is not None


def _denied_table(sql, plan, deny_tables):
    """Name the first denied table this query seems to touch, or None.

    Two checks, and a hit on either refuses: a case-insensitive whole-word
    match on the SQL text, and the same match on every line of SQLite's
    EXPLAIN QUERY PLAN (which names the real table behind a view or a CTE
    alias — `SCAN tool_calls`). This errs toward refusing: a query whose
    string literal merely contains a denied table's name is refused too.

    What it cannot promise: a table reached in a way neither the text nor
    the plan names — say, a plan SQLite chose not to compute because the
    statement was itself an EXPLAIN — passes. It is a fence, not a proof;
    the deny-list is for keeping an agent out of a table by default, not
    for keeping a determined adversary out.
    """
    for table in sorted(deny_tables):
        if _mentions_table(sql, table):
            return table
        if any(_mentions_table(step, table) for step in plan or ()):
            return table
    return None


def run_query(sql, *, max_rows=MAX_ROWS, timeout_seconds=TIMEOUT_SECONDS,
              deny_tables=frozenset(), explain=True):
    """Run one read-only statement and return what came back, or why it didn't.

    Success:
        {"columns": [...], "rows": [[...], ...], "truncated": bool,
         "row_count": int, "plan": [...] or None, "elapsed_ms": int}
      `plan` is the EXPLAIN QUERY PLAN steps; None when `explain` is False
      or the statement is itself an EXPLAIN. `row_count` counts the rows
      returned, which is at most `max_rows`.

    Refusal or failure:
        {"error": "<code>", "message": "<plain English>"}
      codes: not_read_only, multiple_statements, denied_table, timeout,
      sql_error, no_database.
    """
    sql = sql.strip()
    problem = guard(sql)
    if problem:
        code, message = problem
        return {"error": code, "message": message}
    if not db_path().exists():
        return {"error": "no_database", "message": f"No database at {db_path()}."}

    # Refuse a denied table by its name in the text before opening anything —
    # the plan check below catches the rest.
    is_explain = sql.lower().startswith("explain")
    denied = _denied_table(sql, None, deny_tables)
    if denied:
        return {"error": "denied_table",
                "message": f"The table '{denied}' is off limits through this door."}

    conn = read_only_connection()
    conn.set_progress_handler(_deadline_handler(time.monotonic() + timeout_seconds), 10_000)
    try:
        # The plan is taken BEFORE the query runs, for two reasons: the deny
        # check needs it before any denied row is read, and taking it after a
        # slow query would run it into the deadline the query just used up.
        # An unplannable statement (a typo, a missing table) is let through
        # to the real run, whose error message is the useful one.
        plan = None
        if not is_explain and (explain or deny_tables):
            try:
                plan = [step[3] for step in conn.execute(f"EXPLAIN QUERY PLAN {sql}")]
            except sqlite3.Error:
                plan = None
        denied = _denied_table(sql, plan, deny_tables)
        if denied:
            return {"error": "denied_table",
                    "message": f"The table '{denied}' is off limits through this door."}

        # Fetch one row past the cap: that extra row is how truncation is
        # detected without counting the whole result.
        started = time.monotonic()
        cursor = conn.execute(sql)
        rows = cursor.fetchmany(max_rows + 1)
        elapsed_ms = int(round((time.monotonic() - started) * 1000))
        truncated = len(rows) > max_rows
        rows = rows[:max_rows]
        columns = [d[0] for d in cursor.description] if cursor.description else []
        return {
            "columns": columns,
            "rows": [list(row) for row in rows],
            "truncated": truncated,
            "row_count": len(rows),
            "plan": plan if explain else None,
            "elapsed_ms": elapsed_ms,
        }
    except sqlite3.OperationalError as e:
        # The progress handler aborts with this same generic message, so say
        # which one it was rather than showing "interrupted" for a typo.
        if "interrupted" in str(e).lower():
            return {"error": "timeout",
                    "message": f"Query took longer than {timeout_seconds:.0f}s and was stopped."}
        return {"error": "sql_error", "message": str(e)}
    except sqlite3.Error as e:
        return {"error": "sql_error", "message": str(e)}
    finally:
        conn.close()
