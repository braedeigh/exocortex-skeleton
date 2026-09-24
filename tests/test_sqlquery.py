"""The shared read-only SQL door (sqlquery.py).

Two callers trust run_query to refuse — the browser console and the agents'
command line — so most of these are about what it REFUSES: a write, a second
statement, a denied table, a runaway. The rest cover the promises the callers
build on: the row cap is announced rather than silent, the plan comes back,
and every failure is a code a program can branch on.

The database is built with sqlite3 directly, not through sqlstore's migration
ladder, so these tests depend only on exo.db being a SQLite file.
"""
import sqlite3

import pytest

import sqlquery


@pytest.fixture
def db(data_dir):
    path = data_dir / "exo.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO habits (name) VALUES ('Kefir'), ('Walk'), ('Stretch');
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, text TEXT);
        INSERT INTO tool_calls (text) VALUES ('somebody else''s words');
        CREATE VIEW recent_calls AS SELECT id, text FROM tool_calls;
    """)
    conn.commit()
    conn.close()
    return path


def habit_count(path):
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT COUNT(*) FROM habits").fetchone()[0]
    finally:
        conn.close()


# --- what it refuses ----------------------------------------------------------

@pytest.mark.parametrize("sql", [
    "DELETE FROM habits",
    "DROP TABLE habits",
    "UPDATE habits SET name = 'x'",
    "INSERT INTO habits (name) VALUES ('x')",
    "CREATE TABLE evil (x INT)",
    "PRAGMA user_version = 9",
])
def test_a_write_is_refused_before_it_reaches_sqlite(db, sql):
    result = sqlquery.run_query(sql)
    assert result["error"] == "not_read_only"
    assert "allowed" in result["message"].lower()
    assert habit_count(db) == 3


def test_a_write_dressed_as_a_with_is_stopped_by_the_connection(db):
    """Belt and braces: the text check lets a WITH through, SQLite itself
    refuses on the read-only connection, and the data is untouched."""
    result = sqlquery.run_query("WITH x AS (SELECT 1) DELETE FROM habits")
    assert result["error"] == "sql_error"
    assert habit_count(db) == 3


def test_two_statements_are_refused(db):
    result = sqlquery.run_query("SELECT 1; DROP TABLE habits")
    assert result["error"] == "multiple_statements"
    assert habit_count(db) == 3


def test_an_empty_query_is_refused(db):
    assert sqlquery.run_query("   ;  ")["error"] == "not_read_only"


def test_a_runaway_query_times_out(db):
    result = sqlquery.run_query(
        "WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter)"
        " SELECT COUNT(*) FROM counter",
        timeout_seconds=0.05,
    )
    assert result["error"] == "timeout"


def test_a_missing_database_is_a_named_error(data_dir):
    result = sqlquery.run_query("SELECT 1")
    assert result["error"] == "no_database"


def test_a_sql_error_carries_sqlites_message(db):
    result = sqlquery.run_query("SELECT * FROM no_such_table")
    assert result["error"] == "sql_error"
    assert "no_such_table" in result["message"]


# --- the deny-list fence ------------------------------------------------------

def test_a_denied_table_is_refused_by_name(db):
    result = sqlquery.run_query("SELECT * FROM tool_calls",
                                deny_tables=frozenset({"tool_calls"}))
    assert result["error"] == "denied_table"
    assert "tool_calls" in result["message"]


def test_a_denied_table_is_refused_whatever_the_case(db):
    result = sqlquery.run_query('select * from "TOOL_CALLS"',
                                deny_tables=frozenset({"tool_calls"}))
    assert result["error"] == "denied_table"


def test_a_denied_table_is_refused_behind_a_view(db):
    """The view's name says nothing; the query plan names the real table."""
    result = sqlquery.run_query("SELECT * FROM recent_calls",
                                deny_tables=frozenset({"tool_calls"}))
    assert result["error"] == "denied_table"


def test_a_denied_table_does_not_block_other_tables(db):
    result = sqlquery.run_query("SELECT name FROM habits",
                                deny_tables=frozenset({"tool_calls"}))
    assert result["rows"] == [["Kefir"], ["Walk"], ["Stretch"]]


def test_an_empty_deny_list_fences_nothing(db):
    result = sqlquery.run_query("SELECT text FROM tool_calls")
    assert result["rows"] == [["somebody else's words"]]


# --- what it promises on success ----------------------------------------------

def test_select_returns_columns_rows_and_timing(db):
    result = sqlquery.run_query("SELECT id, name FROM habits ORDER BY id")
    assert result["columns"] == ["id", "name"]
    assert result["rows"] == [[1, "Kefir"], [2, "Walk"], [3, "Stretch"]]
    assert result["truncated"] is False
    assert result["row_count"] == 3
    assert isinstance(result["elapsed_ms"], int)


def test_the_row_cap_reports_truncated(db):
    result = sqlquery.run_query("SELECT name FROM habits", max_rows=2)
    assert result["truncated"] is True
    assert result["row_count"] == 2
    assert len(result["rows"]) == 2


def test_a_result_exactly_at_the_cap_is_not_truncated(db):
    result = sqlquery.run_query("SELECT name FROM habits", max_rows=3)
    assert result["truncated"] is False


def test_the_plan_comes_back_with_the_result(db):
    result = sqlquery.run_query("SELECT * FROM habits WHERE id = 1")
    assert any("habits" in step for step in result["plan"])


def test_the_plan_is_none_when_not_asked_for(db):
    assert sqlquery.run_query("SELECT 1", explain=False)["plan"] is None


def test_an_explain_statement_runs_and_has_no_plan_of_its_own(db):
    result = sqlquery.run_query("EXPLAIN QUERY PLAN SELECT * FROM habits")
    assert result["rows"]
    assert result["plan"] is None


def test_db_path_follows_the_store_at_call_time(data_dir):
    assert sqlquery.db_path() == data_dir / "exo.db"
