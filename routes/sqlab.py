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
  POST /api/sql/rebuild — re-derive every typed table from its source
                          (habitstore, expensestore, codestore, cardstore,
                          todostore), so experimenting is undoable.

**Why the plan comes back with every result.** The point of this page is to
build intuition, and `EXPLAIN QUERY PLAN` is where indexes stop being folklore:
run a query, see `SCAN habit_entries`, add an index, run it again, watch it
become `SEARCH habit_entries USING INDEX`. It costs one extra cheap call.

Safety — the query endpoint runs arbitrary SQL against the database of record.
All of its locks (read-only connection, one statement, SELECT/WITH/EXPLAIN
only, a wall-clock cap, the announced row cap) live in `sqlquery.py`, which is
shared with the agents' command line (`scripts/exo_query.py`) so both doors
are the same door. This file only shapes the response for the console.

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

from flask import jsonify, request

import attentionstore
import cardstore
import codestore
import expensestore
import habitstore
import sqlquery
import todostore
import uieventstore

# The console's caps, kept as names on this module so a test (or a future
# setting) can change them here without reaching into sqlquery. The query
# handler reads them at call time for the same reason.
MAX_ROWS = sqlquery.MAX_ROWS
TIMEOUT_SECONDS = sqlquery.TIMEOUT_SECONDS
ALLOWED_STARTS = sqlquery.ALLOWED_STARTS

# The tables that are real columns rather than a JSON blob. Listed rather than
# sniffed so the map can count them without guessing what qualifies. Note that
# 'expenses' appears here AND as a blob collection: during the migration the
# blob is still the source of truth and the table is derived from it, so both
# are real and the response keeps them in separate lists.
TYPED_TABLES = ("habits", "habit_aliases", "habit_entries",
                "expenses", "expense_categories",
                "files", "file_paths", "commits", "commit_files",
                "sessions", "session_files",
                "cards", "card_tags",
                "todos", "fronts", "todo_fronts", "todo_subtasks",
                "attention_segments",
                "tool_calls", "tool_call_sources", "turn_results",
                "ui_events", "requests")

_DATE_KEY = re.compile(r"^\d{4}-\d{2}-\d{2}")


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


def register(app):

    @app.route("/api/sql/schema")
    def sql_schema():
        conn = sqlquery.read_only_connection()
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
        conn = sqlquery.read_only_connection()
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
        """Run one read-only statement through the shared door and shape the
        answer for the console: `limit` is the cap it was cut at, `ms` how
        long it took, `plan` always a list (empty when the statement was
        itself an EXPLAIN). Every refusal is a 400 carrying the plain-English
        reason — the console shows that text as-is. No deny-list here: the
        console is the owner's own window, and she may look at everything.
        """
        sql = ((request.json or {}).get("sql") or "").strip()
        result = sqlquery.run_query(
            sql, max_rows=MAX_ROWS, timeout_seconds=TIMEOUT_SECONDS
        )
        if "error" in result:
            return jsonify({"error": result["message"]}), 400
        return jsonify({
            "columns": result["columns"],
            "rows": result["rows"],
            "truncated": result["truncated"],
            "limit": MAX_ROWS,
            "ms": result["elapsed_ms"],
            "plan": result["plan"] or [],
        })

    @app.route("/api/sql/rebuild", methods=["POST"])
    def sql_rebuild():
        """Re-derive every typed table from its source — the undo button.

        Nothing here can hurt the sources: all six rebuilds only read them
        (JSON blobs for habits, expenses and to-dos; git + the bot_chats
        sidecars for code history; the vault's card pool + deletion cast for
        cards; the append-only day files for attention).

        `job_runs`, `filer_nominations` and `filer_verdicts` are deliberately
        absent and must stay that way: they are the tables in exo.db that are
        not derived from anything, so a rebuild there would delete history that
        exists nowhere else. Their backup is a JSON mirror per sealed day, not
        a re-derivation. See jobstore.py and filerstore.py.

        The filer tables are the sharper case of the two. A `job_runs` row is
        telemetry; a `filer_verdicts` row is a decision the owner made once, by
        hand, and is the ground truth a model is meant to be trained on later.
        Nothing can regenerate it.
        """
        habits = habitstore.rebuild()
        expenses = expensestore.rebuild()
        code = codestore.rebuild()
        cards = cardstore.rebuild()
        todos = todostore.rebuild()
        attention = attentionstore.rebuild()
        # ui_events has the same day-file record attention has, so it
        # rebuilds the same way. tool_calls and turn_results are derived
        # too, but from gigabytes of logs — that rebuild is
        # scripts/usage_events.py --rebuild, not a button in a request.
        # `requests` has no source but itself and must never be here.
        ui_events = uieventstore.rebuild()
        return jsonify({"ok": True, "habits": habits, "expenses": expenses,
                        "code": code, "cards": cards, "todos": todos,
                        "attention": attention, "ui_events": ui_events})
