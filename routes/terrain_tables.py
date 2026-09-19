"""Terrain tables — the database's tables, described so the map can draw them.

The Terrain map (routes/terrain.py) draws every FILE as a dot, and leaves the
database out on purpose: exo.db is one binary file, so on a map of files it
could only ever be one anonymous dot. This module answers the other question —
what is INSIDE that file — so the map can give every table its own body:

  GET /api/observatory/terrain/tables       every table, described
  GET /api/observatory/terrain/tables/rows  one table's actual rows, a page at
                                            a time — searched, filtered by
                                            column, and sorted as asked, with
                                            the SQL that did it sent back too
  GET /api/observatory/terrain/tables/row   one whole row, nothing cut short
  GET /api/observatory/terrain/tables/column
                                            one column, profiled: how full it
                                            is, how many different values, and
                                            — when they're few — every value
                                            with how many rows carry it

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
rows themselves with a search function within the rows" / "a more robust
feature to filter and sort the sql tables … toggle rows, sort by oldest to
newest and reverse the direction" / "see all the value categories for a given
[column] and a description of what [it] contains for each one".
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
    """Read the hand-written table notes: {table name: {holds, source, kind,
    time_column, columns}} — see the `_about` entry in the file itself.

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


# What a filter may do to a column. A fixed list: the request picks one of
# these WORDS, and only the code below ever turns a word into SQL.
_FILTER_OPS = ("is", "is_not", "contains", "empty", "not_empty", "min", "max")
_FILTER_MAX = 12            # filters per request
_FILTER_VALUES_MAX = 50     # values in one "is" / "is_not"
_DAY_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class BadFilter(ValueError):
    """A filter or sort the request had no business asking for."""


def _sql_literal(value):
    """Write a value the way it would be typed into SQL — for the SQL that is
    SHOWN, never for the SQL that is run (that one uses bound parameters)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _filter_clause(spec, column_types):
    """Turn one filter into (SQL with ? placeholders, its parameters).

    `spec` is {"column", "op", "value" or "values"}. The column must be one of
    the table's real columns and the op one of _FILTER_OPS, or this raises
    BadFilter — the two checks that make it safe to put the column's name into
    SQL text. Every VALUE travels as a parameter."""
    if not isinstance(spec, dict):
        raise BadFilter("a filter must be an object")
    column, op = spec.get("column"), spec.get("op")
    if column not in column_types:
        raise BadFilter(f"no such column: {column}")
    if op not in _FILTER_OPS:
        raise BadFilter(f"no such filter: {op}")
    name = f'"{column}"'
    numeric = column_types[column].upper().startswith(("INT", "REAL", "NUM", "FLOAT", "DOUB"))

    if op in ("empty", "not_empty"):
        # "Empty" means nothing was stored: NULL, or text with nothing in it.
        return (f"({name} IS NULL OR {name} = '')" if op == "empty"
                else f"({name} IS NOT NULL AND {name} <> '')"), []

    if op in ("is", "is_not"):
        values = spec.get("values")
        if not isinstance(values, list) or not values or len(values) > _FILTER_VALUES_MAX:
            raise BadFilter("`values` must be a list of 1 to 50 values")
        wants_empty = any(v is None for v in values)
        listed = [v for v in values if v is not None]
        if any(not isinstance(v, (str, int, float)) or isinstance(v, bool) for v in listed):
            raise BadFilter("values must be text or numbers")
        parts, params = [], []
        if listed:
            parts.append(f"{name} IN ({', '.join('?' * len(listed))})")
            params = [str(v)[:200] if isinstance(v, str) else v for v in listed]
        if wants_empty:
            parts.append(f"{name} IS NULL")
        inside = " OR ".join(parts)
        if op == "is":
            return f"({inside})", params
        # NOT IN quietly drops rows whose value is NULL (NULL is "unknown", so
        # SQL won't say it ISN'T in the list). "Is not done" should keep the
        # rows with no value at all, so they are let back in by name.
        keep_nulls = "" if wants_empty else f" OR {name} IS NULL"
        return f"(NOT ({inside}){keep_nulls})", params

    value = spec.get("value")
    if not isinstance(value, (str, int, float)) or isinstance(value, bool) or value == "":
        raise BadFilter("`value` must be text or a number")
    if op == "contains":
        return f"CAST({name} AS TEXT) LIKE ? ESCAPE '\\'", [_like_pattern(str(value)[:200])]
    if numeric:
        try:
            value = float(value) if "." in str(value) else int(value)
        except ValueError as e:
            raise BadFilter(f"{column} holds numbers") from e
        return f"{name} {'>=' if op == 'min' else '<='} ?", [value]
    value = str(value)[:200]
    if op == "max" and _DAY_ONLY.match(value):
        # "Up to the 19th" must include the whole of the 19th. Times here are
        # text like 2026-09-19T14:03, which sorts AFTER the bare day, so the
        # comparison is made on the day part only.
        return f"substr({name}, 1, 10) <= ?", [value]
    return f"{name} {'>=' if op == 'min' else '<='} ?", [value]


def _shown_sql(template, params):
    """The SQL that was run, with the values written in — what she sees, and
    can paste into the SQL room. Same statement, same order; only the ?s are
    replaced, left to right."""
    pieces = template.split("?")
    assert len(pieces) == len(params) + 1
    out = pieces[0]
    for value, piece in zip(params, pieces[1:]):
        out += _sql_literal(value) + piece
    return out


def read_rows(table, word="", offset=0, limit=_ROWS_PAGE, filters=None, sort=None, descending=False):
    """Read one page of a table's rows — searched, filtered, and sorted.

    SEARCH (`word`): keep rows where SOME column contains it (any case, for
    plain letters); every column is compared as text, so a number or a date
    can be searched for the same way a name can.
    FILTERS: a list of {"column", "op", ...} (see _filter_clause); a row must
    pass ALL of them, and the search too.
    SORT: a column name, ascending unless `descending`. Rows with no value in
    that column always come LAST, whichever direction — "newest first" should
    not open with a page of blanks. With no sort, rows come in stored order.

    Returns None when the table doesn't exist; raises BadFilter for a filter or
    sort column that isn't real. `total` is the whole table and `matching` is
    how many rows passed, so the page can say "37 of 2,773" honestly. `sql` is
    the statement that produced the page, written out with its values."""
    conn = _open_read_only()
    if conn is None:
        return None
    try:
        name = _real_table(conn, table)
        if name is None:
            return None
        info = list(conn.execute(f'PRAGMA table_info("{name}")'))
        columns = [c[1] for c in info]
        column_types = {c[1]: c[2] or "" for c in info}

        clauses, params = [], []
        if word:
            clauses.append("(" + " OR ".join(
                f"CAST(\"{c}\" AS TEXT) LIKE ? ESCAPE '\\'" for c in columns) + ")")
            params += [_like_pattern(word)] * len(columns)
        filters = filters or []
        if not isinstance(filters, list) or len(filters) > _FILTER_MAX:
            raise BadFilter(f"at most {_FILTER_MAX} filters")
        for spec in filters:
            clause, clause_params = _filter_clause(spec, column_types)
            clauses.append(clause)
            params += clause_params
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

        if sort is not None and sort not in column_types:
            raise BadFilter(f"no such column: {sort}")
        order = (f' ORDER BY "{sort}" IS NULL, "{sort}" {"DESC" if descending else "ASC"}, rowid'
                 if sort else " ORDER BY rowid")

        total = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        matching = (conn.execute(f'SELECT COUNT(*) FROM "{name}"{where}', params).fetchone()[0]
                    if clauses else total)
        # `rowid` is SQLite's own hidden row number. It rides along so the page
        # can ask for one whole row by it later; it is not one of her columns.
        fetched = conn.execute(
            f'SELECT rowid, * FROM "{name}"{where}{order} LIMIT ? OFFSET ?',
            params + [limit, offset]).fetchall()
        rows = []
        for record in fetched:
            cells, cut = [], []
            for value in record[1:]:
                shown, was_cut = _show_cell(value, word)
                cells.append(shown)
                cut.append(was_cut)
            rows.append({"rowid": record[0], "cells": cells, "cut": cut})
        shown_order = "" if not sort else order.replace(", rowid", "")
        return {"table": name, "columns": columns, "rows": rows, "total": total,
                "matching": matching, "offset": offset, "limit": limit, "search": word,
                "sort": sort, "descending": bool(sort and descending),
                "sql": _shown_sql(f'SELECT * FROM "{name}"{where}{shown_order} LIMIT {limit}', params)}
    finally:
        with contextlib.suppress(sqlite3.Error):
            conn.close()


# --- one column, profiled -------------------------------------------------------

_VALUES_ALL_MAX = 40     # a column with this few different values lists them all
_VALUES_TOP = 12         # ...otherwise only its most common ones
_VALUE_CHARS_MAX = 60    # a column whose values average longer than this is
                         # prose (a card's body, a whole JSON document): listing
                         # "the different values" of prose is meaningless
_DATE_LIKE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def read_column(table, column):
    """Profile one column across the WHOLE table: how full it is, how many
    different values it has, its smallest and largest, and its values with how
    many rows carry each — all of them when they're few, the most common when
    they're many, none when the column is prose.

    `looks_like` is a plain guess at what kind of column it is, made from the
    data (not from its name), so the page can offer the right kind of filter:
    'yesno' (only 0 and 1), 'number', 'date' (values start YYYY-MM-DD),
    'category' (few different values), or 'text'. Returns None when the table
    or column doesn't exist."""
    conn = _open_read_only()
    if conn is None:
        return None
    try:
        name = _real_table(conn, table)
        if name is None:
            return None
        info = {c[1]: c for c in conn.execute(f'PRAGMA table_info("{name}")')}
        if column not in info:
            return None
        col = f'"{column}"'
        declared = info[column][2] or ""
        numeric = declared.upper().startswith(("INT", "REAL", "NUM", "FLOAT", "DOUB"))
        filled_where = f"{col} IS NOT NULL AND {col} <> ''"

        total, filled, distinct, average_chars, smallest, largest = conn.execute(
            f"SELECT COUNT(*), SUM({filled_where}), COUNT(DISTINCT {col}),"
            f" AVG(LENGTH(CAST({col} AS TEXT))),"
            f" MIN(CASE WHEN {filled_where} THEN {col} END),"
            f" MAX(CASE WHEN {filled_where} THEN {col} END) FROM \"{name}\"").fetchone()
        filled = filled or 0
        prose = (average_chars or 0) > _VALUE_CHARS_MAX
        average = None
        if numeric and filled:
            average = conn.execute(f'SELECT AVG({col}) FROM "{name}"').fetchone()[0]

        values, values_complete = None, False
        if not prose and distinct:
            values_complete = distinct <= _VALUES_ALL_MAX
            counted = conn.execute(
                f'SELECT {col}, COUNT(*) FROM "{name}" WHERE {col} IS NOT NULL'
                f" GROUP BY {col} ORDER BY COUNT(*) DESC, {col} LIMIT ?",
                (_VALUES_ALL_MAX if values_complete else _VALUES_TOP,)).fetchall()
            values = [{"value": v if not isinstance(v, bytes) else f"<{len(v):,} bytes>",
                       "rows": n} for v, n in counted]

        if numeric and distinct and distinct <= 2 and smallest in (0, 1) and largest in (0, 1):
            looks_like = "yesno"
        elif numeric:
            looks_like = "number"
        elif isinstance(smallest, str) and _DATE_LIKE.match(smallest) and _DATE_LIKE.match(str(largest)):
            looks_like = "date"
        elif values_complete:
            looks_like = "category"
        else:
            looks_like = "text"

        points_at = next(({"table": f[2], "column": f[4]}
                          for f in conn.execute(f'PRAGMA foreign_key_list("{name}")')
                          if f[3] == column), None)
        table_notes = load_notes().get(name) or {}
        return {
            "table": name, "column": column, "type": declared,
            "primary_key": bool(info[column][5]), "required": bool(info[column][3]),
            "points_at": points_at, "looks_like": looks_like,
            "total": total, "filled": filled, "empty": total - filled, "distinct": distinct,
            "smallest": smallest if not isinstance(smallest, bytes) else None,
            "largest": largest if not isinstance(largest, bytes) else None,
            "average": average, "prose": prose,
            "values": values, "values_complete": values_complete,
            "notes": (table_notes.get("columns") or {}).get(column),
        }
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
        # Filters arrive as one JSON list in the query string; the sort as a
        # column name plus a direction word.
        try:
            filters = json.loads(request.args.get("filters") or "[]")
        except ValueError:
            return jsonify({"error": "filters must be JSON"}), 400
        sort = request.args.get("sort") or None
        descending = request.args.get("dir") == "desc"
        try:
            page = read_rows(table, word, offset, limit, filters, sort, descending)
        except BadFilter as e:
            return jsonify({"error": str(e)}), 400
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

    @app.route("/api/observatory/terrain/tables/column")
    def observatory_terrain_table_column():
        try:
            profile = read_column(request.args.get("table", ""), request.args.get("column", ""))
        except sqlite3.OperationalError as e:
            if "interrupt" in str(e).lower():
                return jsonify({"error": "That took too long and was stopped."}), 408
            return jsonify({"error": str(e)}), 500
        if profile is None:
            return jsonify({"error": "no such column"}), 404
        return jsonify(profile)
