"""The SQL sandbox (routes/sandbox.py) — a database you're allowed to wreck.

The console's tests are about what it refuses; these are the opposite. What
matters here is that writes actually work, that each statement in a script
reports its own outcome, that an error doesn't abort the rest of the script
(otherwise a ROLLBACK after a failed INSERT could never run), and above all
that none of it can touch the real database.
"""
import sqlite3

import pytest

import store


@pytest.fixture
def client(data_dir, monkeypatch):
    from flask import Flask
    from routes import sandbox
    monkeypatch.setenv("EXOCORTEX_SANDBOX_DB", str(data_dir / "sandbox.db"))
    app = Flask(__name__)
    app.config.update(TESTING=True)
    sandbox.register(app)
    return app.test_client()


def run(client, sql):
    return client.post("/api/sandbox/exec", json={"sql": sql})


def results(client, sql):
    return run(client, sql).get_json()["results"]


# --- isolation from real data (the thing that makes the rest safe) ------------

def test_the_sandbox_is_a_different_file_from_the_real_database(client, data_dir):
    run(client, "CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);")
    assert (data_dir / "sandbox.db").exists()
    # exo.db is only created when something touches the real store.
    store.write("car_maintenance", {"entries": []})
    conn = sqlite3.connect(data_dir / "exo.db")
    try:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "t" not in names
    finally:
        conn.close()


def test_it_refuses_to_be_pointed_at_the_real_database(data_dir, monkeypatch):
    """This module allows DROP TABLE, so a misconfigured path here would be the
    most destructive line in the codebase."""
    from routes import sandbox
    monkeypatch.setenv("EXOCORTEX_SANDBOX_DB", str(data_dir / "exo.db"))
    with pytest.raises(RuntimeError):
        sandbox._db_path()


def test_dropping_everything_leaves_real_collections_alone(client, data_dir):
    store.write("car_maintenance", {"entries": [{"id": "a"}]})
    run(client, "CREATE TABLE t (id INTEGER);")
    client.post("/api/sandbox/reset")
    assert store.read("car_maintenance") == {"entries": [{"id": "a"}]}


# --- writes actually work -----------------------------------------------------

def test_create_insert_and_select(client):
    rows = results(client, """
        CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO people (name) VALUES ('Ada'), ('Blue');
        SELECT name FROM people ORDER BY name;
    """)
    assert [r["ok"] for r in rows] == [True, True, True]
    assert rows[1]["changed"] == 2
    assert rows[2]["rows"] == [["Ada"], ["Blue"]]


def test_each_statement_reports_separately(client):
    rows = results(client, "SELECT 1; SELECT 2; SELECT 3;")
    assert len(rows) == 3
    assert [r["rows"][0][0] for r in rows] == [1, 2, 3]


def test_a_semicolon_inside_a_string_does_not_split_the_statement(client):
    rows = results(client, "SELECT 'a;b' AS s;")
    assert len(rows) == 1
    assert rows[0]["rows"] == [["a;b"]]


def test_schema_comes_back_with_every_response(client):
    body = run(client, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);").get_json()
    t = {x["name"]: x for x in body["tables"]}["t"]
    assert [c["name"] for c in t["columns"]] == ["id", "name"]
    assert t["rows"] == 0


# --- errors are results, not failures ----------------------------------------

def test_a_failing_statement_does_not_abort_the_rest(client):
    """A ROLLBACK after a failed INSERT could never run otherwise."""
    rows = results(client, """
        CREATE TABLE t (id INTEGER PRIMARY KEY);
        INSERT INTO t VALUES (1);
        INSERT INTO t VALUES (1);
        SELECT COUNT(*) FROM t;
    """)
    assert rows[2]["ok"] is False
    assert "UNIQUE" in rows[2]["error"]
    assert rows[3]["ok"] is True and rows[3]["rows"] == [[1]]


def test_constraint_errors_keep_sqlites_own_wording(client):
    rows = results(client, """
        CREATE TABLE t (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0));
        INSERT INTO t (age) VALUES (-1);
    """)
    assert "CHECK constraint failed" in rows[1]["error"]


def test_the_failing_statement_is_attached_to_its_error(client):
    rows = results(client, "SELECT * FROM nope;")
    assert rows[0]["sql"] == "SELECT * FROM nope;"
    assert "nope" in rows[0]["error"]


# --- transactions -------------------------------------------------------------

def test_rollback_undoes_the_statements_that_succeeded(client):
    rows = results(client, """
        CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT UNIQUE);
        INSERT INTO t (id, email) VALUES (1, 'a@x');
        BEGIN;
        INSERT INTO t (id, email) VALUES (2, 'b@x');
        INSERT INTO t (id, email) VALUES (3, 'a@x');
        ROLLBACK;
        SELECT COUNT(*) FROM t;
    """)
    assert rows[3]["ok"] is True     # the good insert inside the transaction
    assert rows[4]["ok"] is False    # the duplicate
    assert rows[6]["rows"] == [[1]]  # ...and the good one was undone too


def test_commit_keeps_the_work(client):
    rows = results(client, """
        CREATE TABLE t (id INTEGER PRIMARY KEY);
        BEGIN;
        INSERT INTO t VALUES (1);
        COMMIT;
        SELECT COUNT(*) FROM t;
    """)
    assert rows[4]["rows"] == [[1]]


def test_a_script_left_mid_transaction_is_rolled_back_and_says_so(client):
    """An open transaction would hold SQLite's write lock past the request."""
    run(client, "CREATE TABLE t (id INTEGER PRIMARY KEY);")
    body = run(client, "BEGIN; INSERT INTO t VALUES (1);").get_json()
    assert body["rolled_back"] is True
    assert results(client, "SELECT COUNT(*) FROM t;")[0]["rows"] == [[0]]


def test_foreign_keys_are_enforced(client):
    rows = results(client, """
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
        INSERT INTO parent VALUES (1);
        INSERT INTO child VALUES (1, 1);
        DELETE FROM parent WHERE id = 1;
    """)
    assert rows[4]["ok"] is False
    assert "FOREIGN KEY" in rows[4]["error"]


# --- limits (worker protection, not data protection) --------------------------

def test_too_many_statements_is_refused(client):
    from routes import sandbox
    r = run(client, "SELECT 1;" * (sandbox.MAX_STATEMENTS + 1))
    assert r.status_code == 400
    assert "limit" in r.get_json()["error"]


def test_empty_script_is_refused(client):
    assert run(client, "   ").status_code == 400


def test_rows_are_capped_and_the_cap_is_announced(client, monkeypatch):
    from routes import sandbox
    monkeypatch.setattr(sandbox, "MAX_ROWS", 2)
    rows = results(client, "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3;")
    assert rows[0]["truncated"] is True
    assert len(rows[0]["rows"]) == 2


# --- reset and bulk fill ------------------------------------------------------

def test_reset_drops_every_table(client):
    run(client, "CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);")
    body = client.post("/api/sandbox/reset").get_json()
    assert body["dropped"] == 2
    assert body["tables"] == []


def test_reset_works_even_with_foreign_keys_between_tables(client):
    """Drop order shouldn't matter — a parent may be dropped before its child."""
    run(client, """
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id));
        INSERT INTO parent VALUES (1);
        INSERT INTO child VALUES (1, 1);
    """)
    assert client.post("/api/sandbox/reset").get_json()["dropped"] == 2


def test_bulk_fill_makes_a_table_big_enough_for_an_index_to_matter(client):
    body = client.post("/api/sandbox/bulk", json={"rows": 5000}).get_json()
    assert body["rows"] == 5000
    assert {t["name"]: t for t in body["tables"]}["big"]["rows"] == 5000
    assert results(client, "SELECT COUNT(*) FROM big WHERE category = 'cat-7';")[0]["rows"][0][0] > 0


def test_bulk_fill_rejects_an_absurd_row_count(client):
    assert client.post("/api/sandbox/bulk", json={"rows": 99_000_000}).status_code == 400
    assert client.post("/api/sandbox/bulk", json={"rows": 0}).status_code == 400
