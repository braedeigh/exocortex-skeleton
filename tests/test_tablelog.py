"""The table log (tablelog.py): which table was written, when, by which agent.

The recorder sits at the door every writer opens exo.db through, so these
tests go through that door the way the app does (sqlstore.open_db) and then
ask the Terrain endpoint that reads the log back:
  - a row write is noted against its table, with the agent session the
    process belongs to; a read is not noted at all, nor is a write statement
    that changes no rows, nor one that is rolled back
  - the app's own writes (no session) still mark the table written, and name
    no agent
  - a table the migration ladder creates is noted as a structure change, and
    so is an ALTER TABLE run later
  - a broken log never costs a real write, and the kill switch records nothing
  - a visitor gets the times and no session ids
  - a table's definition time comes from the newest line of its CREATE TABLE
    statement or any ALTER TABLE naming it
"""
import sqlite3

import pytest
from flask import Flask

import sqlstore
import tablelog


@pytest.fixture
def client(data_dir):
    from routes import terrain_tables
    app = Flask(__name__)
    terrain_tables.register(app)
    return app.test_client()


def _activity(client):
    return client.get("/api/observatory/terrain/tables/activity").get_json()


def _add_todo(todo_id="t1"):
    conn = sqlstore.open_db()
    try:
        conn.execute("INSERT INTO todos (id, text, bucket, position) VALUES (?, ?, ?, ?)",
                     (todo_id, "x", "today", 0))
    finally:
        conn.close()


def test_an_agents_row_write_is_noted_against_the_table_and_the_agent(client, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "2026-01-01.000000")
    _add_todo()
    todos = _activity(client)["tables"]["todos"]
    assert todos["rows_at"] is not None and todos["row_times"] == [todos["rows_at"]]
    assert [(s["id"], s["structure"]) for s in todos["sessions"]] == [("2026-01-01.000000", False)]


def test_the_apps_own_write_marks_the_table_and_names_no_agent(client, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_CONV_ID", raising=False)
    _add_todo()
    todos = _activity(client)["tables"]["todos"]
    assert todos["rows_at"] is not None
    assert todos["sessions"] == []


def test_the_turn_hosts_bookkeeping_is_not_an_agents_write(client, monkeypatch):
    """A turn host can inherit the id of the agent that started it; what it
    writes is the app recording a turn, so it names no agent."""
    import store
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "2026-01-01.000000")
    monkeypatch.setattr(store, "_stats_caller_cache", "turn_host")
    _add_todo()
    todos = _activity(client)["tables"]["todos"]
    assert todos["rows_at"] is not None and todos["sessions"] == []


def test_reading_a_table_is_not_a_write(client, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "2026-01-01.000000")
    conn = sqlstore.open_db()
    conn.execute("SELECT * FROM todos").fetchall()
    conn.close()
    body = _activity(client)
    assert body["tables"]["todos"]["rows_at"] is None
    assert body["recording_since"] is None


def test_a_write_statement_that_changes_no_rows_is_not_a_write(client):
    conn = sqlstore.open_db()
    conn.execute("DELETE FROM todos WHERE id = 'nobody'")
    conn.execute("UPDATE todos SET text = 'y' WHERE id = 'nobody'")
    conn.close()
    assert _activity(client)["tables"]["todos"]["rows_at"] is None


def test_a_write_inside_a_transaction_counts_once_committed_and_not_if_rolled_back(client):
    for ending, written in (("ROLLBACK", False), ("COMMIT", True)):
        conn = sqlstore.open_db()
        sqlstore.begin_immediate(conn)
        conn.execute("INSERT INTO todos (id, text, bucket, position) VALUES (?, 'x', 'today', 0)",
                     (ending,))
        conn.execute(ending)
        conn.close()
        assert (_activity(client)["tables"]["todos"]["rows_at"] is not None) is written


def test_an_alter_table_is_noted_as_a_structure_change(client, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "2026-01-01.000000")
    conn = sqlstore.open_db()
    conn.execute("ALTER TABLE todos ADD COLUMN scratch TEXT")
    conn.close()
    todos = _activity(client)["tables"]["todos"]
    assert todos["migrated_at"] is not None and todos["rows_at"] is None
    assert [s["structure"] for s in todos["sessions"]] == [True]


@pytest.mark.fresh_db
def test_tables_the_migration_ladder_creates_are_noted_as_structure(client):
    sqlstore.open_db().close()
    tables = _activity(client)["tables"]
    assert tables["todos"]["migrated_at"] is not None
    # Climbing the ladder is not a row write, whatever its rungs insert.
    assert tables["todos"]["rows_at"] is None
    # A second connection finds the schema in place and reports no change.
    before = tables["todos"]["migrated_at"]
    tablelog._noted.clear()
    sqlstore.open_db().close()
    assert _activity(client)["tables"]["todos"]["migrated_at"] == before


def test_a_broken_log_never_costs_a_real_write(client, data_dir):
    (data_dir / tablelog.DB_NAME).mkdir()      # the log can't be opened at all
    _add_todo()
    conn = sqlstore.open_db()
    assert conn.execute("SELECT COUNT(*) FROM todos").fetchone()[0] == 1
    conn.close()
    assert _activity(client)["tables"]["todos"]["rows_at"] is None


def test_the_kill_switch_records_nothing(client, data_dir, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_TABLE_LOG_OFF", "1")
    _add_todo()
    assert not (data_dir / tablelog.DB_NAME).exists()
    assert _activity(client)["tables"]["todos"]["rows_at"] is None


def test_a_visitor_gets_the_times_and_no_session_ids(data_dir, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "2026-01-01.000000")
    import server
    _add_todo()
    got = server.app.test_client().get("/api/observatory/terrain/tables/activity")
    assert got.status_code == 200
    todos = got.get_json()["tables"]["todos"]
    assert todos["rows_at"] is not None and todos["sessions"] == []


def test_definition_time_is_the_newest_line_of_the_create_or_any_alter(tmp_path, monkeypatch):
    from routes import terrain_tables
    (tmp_path / "schema.py").write_text(
        'conn.execute(\n'                                    # line 1, stamp 10
        '    "CREATE TABLE IF NOT EXISTS books ("\n'         # 2, 20
        '    "  id INTEGER,"\n'                              # 3, 50  <- newest in the statement
        '    ")"\n'                                          # 4, 30
        ')\n'                                                # 5, 99  (after the statement)
        'conn.execute("CREATE TABLE IF NOT EXISTS pens (id INTEGER)")\n'   # 6, 40
        ')\n'                                                # 7, 5
        'conn.execute("ALTER TABLE pens ADD COLUMN ink TEXT")\n')          # 8, 70
    monkeypatch.setattr(terrain_tables, "_blame_times",
                        lambda root, relpath: [10, 20, 50, 30, 99, 40, 5, 70, 1])
    code = terrain_tables.scan_code(["books", "pens", "ghosts"], root=tmp_path)
    creates = {name: verbs["creates"] for name, verbs in code.items()}
    found = terrain_tables.definition_times(["books", "pens", "ghosts"], creates, root=tmp_path)
    assert found == {"books": 50, "pens": 70}
