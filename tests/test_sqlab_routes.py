"""The SQL lab's HTTP contract (routes/sqlab.py).

This endpoint runs arbitrary SQL against the database of record, so most of
these tests are about what it REFUSES. The rest cover the two things that make
it a teaching tool rather than a raw console: the query plan comes back with
every result, and truncation is announced instead of silent.
"""
import pytest

import habitstore
import store


@pytest.fixture
def client(data_dir, tmp_path, monkeypatch):
    from flask import Flask
    from routes import sqlab
    content = tmp_path / "content"
    content.mkdir()
    (content / "HABITS.md").write_text("# Habits\n\n## Morning\n- [ ] Kefir\n")
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    store.write("habits_log", {"2026-06-10": {"morning|Kefir": True}})
    habitstore.rebuild()
    app = Flask(__name__)
    app.config.update(TESTING=True)
    sqlab.register(app)
    return app.test_client()


def run(client, sql):
    return client.post("/api/sql/query", json={"sql": sql})


# --- what it refuses ----------------------------------------------------------

@pytest.mark.parametrize("sql", [
    "DELETE FROM docs",
    "DROP TABLE habits",
    "UPDATE habits SET name = 'x'",
    "INSERT INTO habits (name) VALUES ('x')",
    "CREATE TABLE evil (x INT)",
    "PRAGMA user_version = 9",
])
def test_writes_and_pragmas_are_rejected(client, sql):
    r = run(client, sql)
    assert r.status_code == 400
    assert "allowed" in r.get_json()["error"].lower()


def test_second_statement_is_rejected(client):
    r = run(client, "SELECT 1; DROP TABLE docs")
    assert r.status_code == 400
    assert "one statement" in r.get_json()["error"].lower()


def test_the_data_really_is_untouched_after_a_rejected_write(client):
    run(client, "DELETE FROM docs")
    assert store.read("habits_log") == {"2026-06-10": {"morning|Kefir": True}}
    assert run(client, "SELECT COUNT(*) FROM habits").get_json()["rows"][0][0] == 1


def test_read_only_connection_blocks_a_write_that_passes_the_parser(client):
    """Belt and braces: even phrased as a WITH, SQLite itself refuses."""
    r = run(client, "WITH x AS (SELECT 1) DELETE FROM docs")
    assert r.status_code == 400


def test_empty_query_is_rejected(client):
    assert run(client, "   ").status_code == 400


# --- what it allows -----------------------------------------------------------

def test_select_returns_columns_and_rows(client):
    body = run(client, "SELECT name, section FROM habits").get_json()
    assert body["columns"] == ["name", "section"]
    assert body["rows"] == [["Kefir", "morning"]]
    assert body["truncated"] is False


def test_cte_and_window_functions_work(client):
    body = run(client, "WITH d AS (SELECT date FROM habit_entries)"
                       " SELECT COUNT(*) OVER () FROM d").get_json()
    assert body["rows"]


def test_query_plan_comes_back_with_results(client):
    body = run(client, "SELECT * FROM habit_entries WHERE habit_id = 1").get_json()
    assert body["plan"] and any("habit_entries" in step for step in body["plan"])


def test_explain_query_plan_is_allowed_directly(client):
    assert run(client, "EXPLAIN QUERY PLAN SELECT * FROM habits").status_code == 200


def test_truncation_is_announced_not_silent(client, monkeypatch):
    from routes import sqlab
    monkeypatch.setattr(sqlab, "MAX_ROWS", 2)
    body = run(client, "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3").get_json()
    assert body["truncated"] is True
    assert len(body["rows"]) == 2


def test_sql_error_returns_the_message_not_a_500(client):
    r = run(client, "SELECT * FROM no_such_table")
    assert r.status_code == 400
    assert "no_such_table" in r.get_json()["error"]


# --- schema + rebuild ---------------------------------------------------------

def test_schema_lists_tables_with_columns_and_counts(client):
    tables = {t["name"]: t for t in client.get("/api/sql/schema").get_json()["tables"]}
    assert {"docs", "habits", "habit_aliases", "habit_entries"} <= set(tables)
    assert tables["habits"]["rows"] == 1
    assert "merged_into" in [c["name"] for c in tables["habits"]["columns"]]
    assert any(c["pk"] for c in tables["habits"]["columns"])


def test_rebuild_endpoint_reruns_the_derivation(client):
    r = client.post("/api/sql/rebuild")
    assert r.status_code == 200 and r.get_json()["ok"] is True
    assert store.read("habits_log") == {"2026-06-10": {"morning|Kefir": True}}
