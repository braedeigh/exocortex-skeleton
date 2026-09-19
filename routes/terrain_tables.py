"""Terrain tables — the database's tables, described so the map can draw them.

The Terrain map (routes/terrain.py) draws every FILE as a dot, and leaves the
database out on purpose: exo.db is one binary file, so on a map of files it
could only ever be one anonymous dot. This module answers the other question —
what is INSIDE that file — so the map can give every table its own body:

  GET /api/observatory/terrain/tables       every table, described
  GET /api/observatory/terrain/tables/rows  one table's actual rows, a page at
                                            a time, optionally only the rows
                                            that contain a search word
  GET /api/observatory/terrain/tables/row   one whole row, nothing cut short

For each table it says how many rows it holds, how many bytes it takes on
disk, every column (name, type, primary key, NOT NULL), its indexes, and which
other tables it points at through foreign keys. It also says two things a
schema can't: what the table is FOR, in plain English (hand-written notes in
table_notes.json, beside sqlstore.py), and which code files touch it — found
by scanning the app's Python for SQL that names the table, so that list is
read from the code as it is today and can't go stale. The frontend
(frontend/src/features/terrain/tableNodes.ts) turns each one into a rectangle
as wide as its columns and as tall as its rows, and draws the foreign keys as
lines between them.

It also says WHERE on the map the tables belong: which repo holds the data
directory, and the database file's path inside it, so the tables hang off the
folder the database really lives in.

Owner only. The map itself is open to visitors (public_config.PUBLIC_PATHS),
but this endpoint is not in that list, so the auth gate closes it — table and
column names describe what the owner keeps, the same reason /terrain/sql is
guarded. That is also why this is its own endpoint rather than a field on the
terrain payload: that payload is cached and served to visitors too.

Reads exo.db directly and read-only (the same way routes/sqlab.py does),
because the subject is the tables themselves, not the collections store.py
serves. Touches: store.py (where the data directory and the app checkout are),
routes/observatory.py (`_terrain_repos`, the repo roots), table_notes.json
(the descriptions; tests/test_terrain_tables.py fails if a table in
sqlstore.py has none), and is registered in server.py beside routes/terrain.py.

Prompt that produced this file: "is there a way to visualize sql tables in my
terrain view? curious to put my tables on there somewhere" / "i want them to
be sized by how much is in there and learn more about the shapes of the tables
through this exercise" / "for each one i want a description of the information
it contains and the files that created it and write to it or that otherwise
interact with it" / "make it such that i can click into it to see the actual
rows themselves with a search function within the rows".
"""
import contextlib
import json
import os
import re
import sqlite3
import time
from pathlib import Path

from flask import jsonify, request

import store
from routes import observatory


def _database_place(path):
    """Find which repo the database file sits in, and its path inside it.

    Returns (repo id, repo-relative path), or (None, None) when the data
    directory is outside both repos — the map then has no folder to hang the
    tables off, and says so by drawing none rather than guessing a spot."""
    for repo in observatory._terrain_repos():
        try:
            rel = os.path.relpath(path, repo["root"])
        except ValueError:
            continue   # never happens on one filesystem; defensive
        if rel == os.curdir or rel.startswith(os.pardir):
            continue   # not under this repo's root
        return repo["id"], rel.replace(os.sep, "/")
    return None, None


def _table_bytes(conn):
    """Measure how much disk each table and each index takes, in bytes.

    `dbstat` is SQLite's own page accounting: one row per table or index, with
    the total size of the pages it owns. It is a compile-time option, so an
    SQLite built without it raises — that comes back as {} and every size is
    reported as null ("not measured") rather than as zero."""
    try:
        return {name: size for name, size in conn.execute(
            "SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE")}
    except sqlite3.Error:
        return {}


def _describe_tables(conn):
    """Describe every table: rows, bytes, columns, indexes, foreign keys.

    Table names come from sqlite_master, not from the request, so putting them
    into the SQL text can't be injection — but they are still quoted, because
    a table named `order` would otherwise break the statement."""
    sizes = _table_bytes(conn)
    names = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
        " AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    # Which table each index belongs to, so an index's bytes can be added to
    # its table's total. Includes the automatic indexes SQLite makes for
    # PRIMARY KEY / UNIQUE, which can be as big as the table itself.
    index_owner = {name: table for name, table in conn.execute(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")}

    tables = []
    for name in names:
        columns = [
            {"name": c[1], "type": c[2] or "", "notnull": bool(c[3]), "pk": bool(c[5])}
            for c in conn.execute(f'PRAGMA table_info("{name}")')
        ]
        indexes = [
            {"name": i[1], "unique": bool(i[2])}
            for i in conn.execute(f'PRAGMA index_list("{name}")')
        ]
        # One entry per foreign-key column: "my `column` holds a value from
        # `table`.`to`". `to` is null when the key was declared without naming
        # the target column, which means "that table's primary key".
        foreign_keys = [
            {"column": f[3], "table": f[2], "to": f[4]}
            for f in conn.execute(f'PRAGMA foreign_key_list("{name}")')
        ]
        rows = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        index_bytes = sum(sizes.get(index, 0) for index, owner in index_owner.items()
                          if owner == name)
        tables.append({
            "name": name,
            "rows": rows,
            "bytes": sizes.get(name) if sizes else None,
            "index_bytes": index_bytes if sizes else None,
            "columns": columns,
            "indexes": indexes,
            "foreign_keys": foreign_keys,
        })
    return tables


# --- what each table is for: the hand-written notes ---------------------------

_NOTES_PATH = Path(__file__).resolve().parent.parent / "table_notes.json"


def load_notes():
    """Read the hand-written table notes: {table name: {holds, source, rebuildable}}.

    A missing or broken notes file comes back as {} — every table then simply
    has no description on its card, which is honest, rather than the whole map
    layer failing over prose."""
    try:
        notes = json.loads(_NOTES_PATH.read_text())
    except (OSError, ValueError):
        return {}
    return notes if isinstance(notes, dict) else {}


# --- which code touches each table: a scan of the Python source ---------------
#
# The scan looks for SQL KEYWORDS IN CAPITALS followed by a table name —
# `INSERT INTO todos`, `FROM cards`. Capitals on purpose: several tables are
# ordinary English words (files, tags, docs, cards), and Python itself writes
# `from files import …` in lowercase, so matching case is what keeps prose and
# imports out of the answer. It is a text search, not a SQL parser, so it has
# SQL quoted in `backticks` is skipped as prose. It has two known blind spots,
# both of which UNDER-report rather than invent:
#   - SQL whose table name is a variable (`f'SELECT … FROM "{name}"'`) — the
#     generic tools that read EVERY table (routes/sqlab.py, this file) are
#     deliberately not listed against each one;
#   - code that reaches a table only through another module's functions. The
#     to-do page never names the `todos` table; it writes the todos collection
#     and todostore.py mirrors it. The notes' `source` line is where that
#     indirect path is written down.

# Folders the scan never walks: not the app's own code, or not code at all.
_SCAN_SKIP_DIRS = {"venv", "node_modules", "tests", "shed", "__pycache__", "frontend",
                   ".git", ".claude", "dist", "worktrees"}
_SCAN_TTL_SEC = 300     # a cache that expires after five minutes: source files
                        # change on the order of commits, not requests
_scan_cache = {"built_at": 0.0, "tables": None, "result": None}

# Between the keyword and the table name there may be plain whitespace, or the
# seam where one Python string literal ends and the next begins
# (`"… FROM "` newline `"cards …"`), since long SQL here is written that way.
_GAP = r'''(?:\s|["\']\s*\n\s*f?["\'])+'''
_VERBS = (
    ("creates", r"CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?"),
    ("writes", r"INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM"
               r"|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?"),
    ("reads", r"(?<!DELETE\s)FROM|JOIN"),
)


def scan_code(table_names, root=None):
    """Find which Python files create, write to, and read each table.

    Returns {table: {"creates": [...], "writes": [...], "reads": [...]}}, each a
    sorted list of {"path": repo-relative path, "line": first matching line}.
    One pass over the app checkout's .py files; see the block above for what
    the search can and can't see."""
    root = Path(root or store.BUILD_DIR)
    names = sorted(table_names, key=len, reverse=True)   # longest first, so
    if not names:                                        # `todo_fronts` isn't
        return {}                                        # read as `todo`
    alternation = "|".join(re.escape(n) for n in names)
    patterns = [(verb, re.compile(rf'(?:{keywords}){_GAP}["`]?({alternation})\b'))
                for verb, keywords in _VERBS]
    found = {name: {"creates": {}, "writes": {}, "reads": {}} for name in names}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SCAN_SKIP_DIRS and not d.startswith(".")]
        for filename in filenames:
            if not filename.endswith(".py"):
                continue
            path = Path(dirpath) / filename
            try:
                text = path.read_text(errors="replace")
            except OSError:
                continue
            relpath = str(path.relative_to(root)).replace(os.sep, "/")
            for verb, pattern in patterns:
                for match in pattern.finditer(text):
                    # Skip SQL quoted inside `backticks` — that's prose ABOUT a
                    # statement (a docstring saying what it blocks), not code
                    # that runs one. An odd number of backticks before the
                    # match on its line means we're inside such a span.
                    line_start = text.rfind("\n", 0, match.start()) + 1
                    if text.count("`", line_start, match.start()) % 2 == 1:
                        continue
                    line = text.count("\n", 0, match.start()) + 1
                    found[match.group(1)][verb].setdefault(relpath, line)

    return {
        name: {verb: [{"path": p, "line": line} for p, line in sorted(hits.items())]
               for verb, hits in verbs.items()}
        for name, verbs in found.items()
    }


def _scan_code_cached(table_names):
    """scan_code, remembered for _SCAN_TTL_SEC — and redone at once if the set
    of tables changed, so a new table never waits out the cache."""
    now = time.monotonic()
    key = tuple(sorted(table_names))
    fresh = now - _scan_cache["built_at"] < _SCAN_TTL_SEC
    if _scan_cache["result"] is None or not fresh or _scan_cache["tables"] != key:
        _scan_cache.update(built_at=now, tables=key, result=scan_code(table_names))
    return _scan_cache["result"]


def build_tables():
    """Build the whole answer. Any database trouble — no exo.db yet, a torn
    file — comes back as an empty table list rather than an error: the tables
    are an optional layer on the map, and the map must still draw."""
    path = store.DATA_DIR / "exo.db"
    repo, relpath = _database_place(path)
    empty = {"repo": repo, "path": relpath, "tables": []}
    if not path.is_file():
        return empty
    conn = None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        conn.execute("PRAGMA query_only = ON")
        tables = _describe_tables(conn)
    except sqlite3.Error:
        return empty
    finally:
        if conn is not None:
            with contextlib.suppress(sqlite3.Error):
                conn.close()

    # Attach what a schema can't say: the notes, and the code that touches it.
    # `code_repo` tells the map which repo those file paths belong to.
    notes = load_notes()
    code = _scan_code_cached([t["name"] for t in tables])
    for table in tables:
        table["notes"] = notes.get(table["name"])
        table["code"] = code.get(table["name"], {"creates": [], "writes": [], "reads": []})
    return {"repo": repo, "path": relpath, "code_repo": "skeleton", "tables": tables}


# --- the rows themselves ------------------------------------------------------
#
# Reading rows is kept deliberately narrow — this is a window for LOOKING, and
# the SQL room (routes/sqlab.py) is the place for asking real questions:
#   - the table name must be one that exists (checked against sqlite_master),
#     so nothing from the request is ever put into SQL text except a name the
#     database itself just gave us;
#   - the search word travels as a bound parameter, never as SQL text;
#   - the connection is read-only, and a wall-clock cap stops a slow search
#     from pinning a worker;
#   - long cells are cut short in the list (one journal card or one whole
#     collection can be hundreds of kilobytes) and said to be cut, and the
#     single-row door returns them whole.

_ROWS_PAGE = 100           # rows per page when the client doesn't say
_ROWS_PAGE_MAX = 500       # ...and the most it may ask for
_CELL_CHARS = 240          # a cell longer than this is cut short in the list
_ROWS_DEADLINE_SEC = 3.0   # a search slower than this is stopped


def _open_read_only():
    """Open exo.db read-only, or None when there isn't one yet."""
    path = store.DATA_DIR / "exo.db"
    if not path.is_file():
        return None
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    conn.execute("PRAGMA query_only = ON")
    deadline = time.monotonic() + _ROWS_DEADLINE_SEC
    # SQLite calls this every few thousand steps; a non-zero answer aborts.
    conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 5000)
    return conn


def _real_table(conn, name):
    """Return the table's name as the database spells it, or None if there is
    no such table. This is the gate that makes it safe to put the name into
    SQL text below."""
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
        " AND name NOT LIKE 'sqlite_%' AND name = ?", (name,)).fetchone()
    return row[0] if row else None


def _like_pattern(word):
    """Turn a search word into a LIKE pattern that means "contains this, exactly".

    `%` and `_` are wildcards in LIKE, so a search for "50%" or "todo_id" would
    otherwise match far more than was typed; they are escaped with a backslash
    (the queries below declare ESCAPE '\\')."""
    escaped = word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _show_cell(value, word):
    """Make one cell fit for the list: (what to show, whether it was cut short).

    Text longer than _CELL_CHARS is cut. When the row is here BECAUSE of a
    search, the cut is taken around the first place the word appears rather
    than from the start — otherwise a match deep inside a long journal card
    would list the row with no visible reason for it being there."""
    if value is None or isinstance(value, (int, float)):
        return value, False
    if isinstance(value, bytes):
        return f"<{len(value):,} bytes of binary data>", False
    text = str(value)
    if len(text) <= _CELL_CHARS:
        return text, False
    at = text.lower().find(word.lower()) if word else -1
    if at > _CELL_CHARS - len(word) - 20:
        start = max(0, at - 60)
        return "…" + text[start:start + _CELL_CHARS] + "…", True
    return text[:_CELL_CHARS] + "…", True


def read_rows(table, word="", offset=0, limit=_ROWS_PAGE):
    """Read one page of a table's rows, in the order the database stores them.

    With a search word, only rows where SOME column contains it (any case, for
    plain letters) — every column is compared as text, so a number or a date
    can be searched for the same way a name can. Returns None when the table
    doesn't exist. `total` is the whole table; `matching` is how many rows the
    search found (equal to `total` when there is no search), so the page can
    say "37 of 2,773" honestly."""
    conn = _open_read_only()
    if conn is None:
        return None
    try:
        name = _real_table(conn, table)
        if name is None:
            return None
        columns = [c[1] for c in conn.execute(f'PRAGMA table_info("{name}")')]
        where, params = "", []
        if word:
            where = " WHERE " + " OR ".join(
                f"CAST(\"{c}\" AS TEXT) LIKE ? ESCAPE '\\'" for c in columns)
            params = [_like_pattern(word)] * len(columns)
        total = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        matching = (conn.execute(f'SELECT COUNT(*) FROM "{name}"{where}', params).fetchone()[0]
                    if word else total)
        # `rowid` is SQLite's own hidden row number. It rides along so the page
        # can ask for one whole row by it later; it is not one of her columns.
        fetched = conn.execute(
            f'SELECT rowid, * FROM "{name}"{where} ORDER BY rowid LIMIT ? OFFSET ?',
            params + [limit, offset]).fetchall()
        rows = []
        for record in fetched:
            cells, cut = [], []
            for value in record[1:]:
                shown, was_cut = _show_cell(value, word)
                cells.append(shown)
                cut.append(was_cut)
            rows.append({"rowid": record[0], "cells": cells, "cut": cut})
        return {"table": name, "columns": columns, "rows": rows, "total": total,
                "matching": matching, "offset": offset, "limit": limit, "search": word}
    finally:
        with contextlib.suppress(sqlite3.Error):
            conn.close()


def read_row(table, rowid):
    """Read ONE row whole — every value at full length. None when the table or
    the row doesn't exist. Binary values are still described, not sent."""
    conn = _open_read_only()
    if conn is None:
        return None
    try:
        name = _real_table(conn, table)
        if name is None:
            return None
        columns = [c[1] for c in conn.execute(f'PRAGMA table_info("{name}")')]
        record = conn.execute(f'SELECT * FROM "{name}" WHERE rowid = ?', (rowid,)).fetchone()
        if record is None:
            return None
        values = [f"<{len(v):,} bytes of binary data>" if isinstance(v, bytes) else v
                  for v in record]
        return {"table": name, "rowid": rowid, "columns": columns, "values": values}
    finally:
        with contextlib.suppress(sqlite3.Error):
            conn.close()


def _whole_number(raw, default, lowest, highest):
    """Read a whole number from the query string, held inside [lowest, highest]."""
    try:
        return max(lowest, min(highest, int(raw)))
    except (TypeError, ValueError):
        return default


def register(app):

    @app.route("/api/observatory/terrain/tables")
    def observatory_terrain_tables():
        return jsonify(build_tables())

    @app.route("/api/observatory/terrain/tables/rows")
    def observatory_terrain_table_rows():
        table = request.args.get("table", "")
        word = (request.args.get("q") or "").strip()[:200]
        offset = _whole_number(request.args.get("offset"), 0, 0, 10_000_000)
        limit = _whole_number(request.args.get("limit"), _ROWS_PAGE, 1, _ROWS_PAGE_MAX)
        try:
            page = read_rows(table, word, offset, limit)
        except sqlite3.OperationalError as e:
            # "interrupted" is the wall-clock cap firing: say what happened in
            # words she can act on, rather than a bare 500.
            if "interrupt" in str(e).lower():
                return jsonify({"error": "That search took too long and was stopped."}), 408
            return jsonify({"error": str(e)}), 500
        if page is None:
            return jsonify({"error": "no such table"}), 404
        return jsonify(page)

    @app.route("/api/observatory/terrain/tables/row")
    def observatory_terrain_table_row():
        table = request.args.get("table", "")
        rowid = _whole_number(request.args.get("rowid"), None, -2**62, 2**62)
        if rowid is None:
            return jsonify({"error": "rowid is required"}), 400
        try:
            row = read_row(table, rowid)
        except sqlite3.OperationalError as e:
            return jsonify({"error": str(e)}), 500
        if row is None:
            return jsonify({"error": "no such row"}), 404
        return jsonify(row)
