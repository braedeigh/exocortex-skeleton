"""The map's table layer (routes/terrain_tables.py).

GET /api/observatory/terrain/tables describes every table in exo.db so the
Terrain map can draw each one as a body: rows, columns, foreign keys, and
where in the repos the database file sits. These tests build a tiny exo.db by
hand in the isolated data dir and check:
  - a table's shape comes back as it really is (rows, columns, primary key)
  - a foreign key is reported as a link to the table it points at
  - the database is placed inside the repo that holds the data directory,
    and placed nowhere when no repo holds it
  - a missing database is an empty list, not an error
  - a visitor is refused — table names describe what the owner keeps
  - the code scan sorts files into creates / writes / reads, and is not fooled
    by lowercase Python imports or by SQL quoted in prose
  - every table sqlstore.py creates has a plain-English note
"""
import json
import re
import sqlite3
from pathlib import Path

import pytest
from flask import Flask

import store


@pytest.fixture
def vault(data_dir, monkeypatch):
    """Make the isolated data dir look like `<vault>/data`, the way a real
    install lays it out, so the database has a repo to be found in."""
    from routes import observatory
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "name": "Personal vault", "root": data_dir.parent},
    ))
    return data_dir


@pytest.fixture
def database(vault):
    """Two tables joined by a foreign key: three authors, two books."""
    conn = sqlite3.connect(vault / "exo.db")
    conn.executescript("""
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE books (
            id INTEGER PRIMARY KEY,
            author_id INTEGER NOT NULL REFERENCES authors(id),
            title TEXT
        );
        INSERT INTO authors (name) VALUES ('a'), ('b'), ('c');
        INSERT INTO books (author_id, title) VALUES (1, 'x'), (2, 'y');
    """)
    conn.commit()
    conn.close()


@pytest.fixture
def client(vault):
    from routes import terrain_tables
    app = Flask(__name__)
    terrain_tables.register(app)
    return app.test_client()


def _tables(client):
    payload = client.get("/api/observatory/terrain/tables").get_json()
    return {t["name"]: t for t in payload["tables"]}


def test_table_shape_is_reported_as_it_is(client, database):
    books = _tables(client)["books"]
    assert books["rows"] == 2
    assert [c["name"] for c in books["columns"]] == ["id", "author_id", "title"]
    assert [c["name"] for c in books["columns"] if c["pk"]] == ["id"]


def test_foreign_key_is_a_link_to_the_other_table(client, database):
    books = _tables(client)["books"]
    assert books["foreign_keys"] == [{"column": "author_id", "table": "authors", "to": "id"}]
    assert _tables(client)["authors"]["foreign_keys"] == []


def test_database_is_placed_in_the_repo_that_holds_it(client, database, vault):
    payload = client.get("/api/observatory/terrain/tables").get_json()
    assert payload["repo"] == "vault"
    assert payload["path"] == f"{vault.name}/exo.db"


def test_database_outside_every_repo_is_placed_nowhere(client, database, monkeypatch, tmp_path_factory):
    from routes import observatory
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "vault", "name": "Personal vault", "root": elsewhere},
    ))
    payload = client.get("/api/observatory/terrain/tables").get_json()
    assert payload["repo"] is None and payload["path"] is None


def test_missing_database_is_an_empty_list(client):
    resp = client.get("/api/observatory/terrain/tables")
    assert resp.status_code == 200
    assert resp.get_json()["tables"] == []


def test_visitor_is_refused(data_dir, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    visitor = server.app.test_client()
    assert visitor.get("/api/observatory/terrain/tables").status_code == 401


# --- which code touches a table: the scan --------------------------------------

def _scan(tmp_path, files, tables):
    from routes import terrain_tables
    for relpath, text in files.items():
        target = tmp_path / relpath
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    return terrain_tables.scan_code(tables, root=tmp_path)


def test_scan_sorts_files_into_creates_writes_and_reads(tmp_path):
    found = _scan(tmp_path, {
        "schema.py": 'conn.execute("CREATE TABLE IF NOT EXISTS books (id INTEGER)")\n',
        "bookstore.py": 'conn.execute("INSERT INTO books (id) VALUES (1)")\n'
                        'conn.execute("DELETE FROM books")\n',
        "routes/shelf.py": 'rows = conn.execute("SELECT id FROM books").fetchall()\n',
    }, ["books"])["books"]
    assert [h["path"] for h in found["creates"]] == ["schema.py"]
    assert [h["path"] for h in found["writes"]] == ["bookstore.py"]
    assert [h["path"] for h in found["reads"]] == ["routes/shelf.py"]


def test_scan_follows_sql_split_across_string_literals(tmp_path):
    found = _scan(tmp_path, {
        "report.py": 'conn.execute(\n    "SELECT id FROM "\n    "books WHERE id = 1")\n',
    }, ["books"])["books"]
    assert [h["path"] for h in found["reads"]] == ["report.py"]


def test_scan_ignores_python_imports_and_sql_quoted_in_prose(tmp_path):
    found = _scan(tmp_path, {
        "uses.py": "from books import thing\n",
        "guard.py": '"""Blocks things like `DROP TABLE books` outright."""\n',
    }, ["books"])["books"]
    assert found == {"creates": [], "writes": [], "reads": []}


def test_scan_does_not_mistake_a_longer_table_name_for_a_shorter_one(tmp_path):
    found = _scan(tmp_path, {
        "parts.py": 'conn.execute("SELECT 1 FROM book_parts")\n',
    }, ["book", "book_parts"])
    assert found["book"]["reads"] == []
    assert [h["path"] for h in found["book_parts"]["reads"]] == ["parts.py"]


def test_each_table_carries_its_note_and_its_code(client, database, monkeypatch):
    from routes import terrain_tables
    monkeypatch.setattr(terrain_tables, "load_notes",
                        lambda: {"books": {"holds": "Books.", "source": "By hand.", "kind": "record"}})
    monkeypatch.setitem(terrain_tables._scan_cache, "result", None)
    tables = _tables(client)
    assert tables["books"]["notes"]["holds"] == "Books."
    assert tables["authors"]["notes"] is None
    assert set(tables["books"]["code"]) == {"creates", "writes", "reads"}


# --- the notes file keeps up with the schema ------------------------------------

def test_every_table_in_the_schema_has_a_note():
    """Adding a table to sqlstore.py without describing it fails here — the
    card would otherwise show a table with no explanation, silently."""
    root = Path(store.BUILD_DIR)
    created = set(re.findall(r"CREATE TABLE(?: IF NOT EXISTS)? (\w+)", (root / "sqlstore.py").read_text()))
    notes = json.loads((root / "table_notes.json").read_text())
    described = {name for name in notes if not name.startswith("_")}
    assert created - described == set()
    for name in described:
        assert set(notes[name]) == {"holds", "source", "kind"}
        assert notes[name]["kind"] in {"mirror", "record", "store", "mixed"}
