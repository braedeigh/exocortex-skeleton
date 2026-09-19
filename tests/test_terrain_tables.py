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
"""
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
