"""Terrain tables — the database's tables, described so the map can draw them.

The Terrain map (routes/terrain.py) draws every FILE as a dot, and leaves the
database out on purpose: exo.db is one binary file, so on a map of files it
could only ever be one anonymous dot. This module answers the other question —
what is INSIDE that file — so the map can give every table its own body:

  GET /api/observatory/terrain/tables

For each table it says how many rows it holds, how many bytes it takes on
disk, every column (name, type, primary key, NOT NULL), its indexes, and which
other tables it points at through foreign keys. The frontend
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
serves. Touches: store.py (where the data directory is), routes/observatory.py
(`_terrain_repos`, the repo roots), and is registered in server.py beside
routes/terrain.py.

Prompt that produced this file: "is there a way to visualize sql tables in my
terrain view? curious to put my tables on there somewhere" / "i want them to
be sized by how much is in there and learn more about the shapes of the tables
through this exercise".
"""
import contextlib
import os
import sqlite3

from flask import jsonify

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
        return {"repo": repo, "path": relpath, "tables": _describe_tables(conn)}
    except sqlite3.Error:
        return empty
    finally:
        if conn is not None:
            with contextlib.suppress(sqlite3.Error):
                conn.close()


def register(app):

    @app.route("/api/observatory/terrain/tables")
    def observatory_terrain_tables():
        return jsonify(build_tables())
