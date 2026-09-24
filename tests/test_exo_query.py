"""The agents' SQL command line (scripts/exo_query.py).

Drives main() with an argv and reads what it printed. The database is a tiny
exo.db built with sqlite3 directly; the notes come from the real
table_notes.json, so `habits` (which has a note) and `scratch` (which never
will) show the two shapes a schema line can take.
"""
import importlib
import json
import sqlite3

import pytest

import config
from scripts import exo_query


@pytest.fixture
def db(data_dir):
    path = data_dir / "exo.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT, active INTEGER);
        INSERT INTO habits (name, active) VALUES ('Kefir', 1), ('Walk', 0);
        CREATE TABLE scratch (id INTEGER PRIMARY KEY, note TEXT);
        INSERT INTO scratch (note) VALUES ('tab\there' || char(10) || 'newline'), (NULL);
    """)
    conn.commit()
    conn.close()
    return path


# --- schema -------------------------------------------------------------------

def test_schema_lists_every_table_with_its_note(db, capsys):
    assert exo_query.main(["schema"]) == 0
    lines = capsys.readouterr().out.splitlines()
    habits = next(line for line in lines if line.startswith("habits  "))
    assert "(no note yet)" not in habits
    assert habits.split("  ")[1] in ("mirror", "record", "store", "mixed")
    assert "scratch  (no note yet)" in lines


def test_schema_for_one_table_lists_its_columns_with_notes(db, capsys):
    assert exo_query.main(["schema", "habits"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("habits\nholds: ")
    assert "source: " in out and "time_column: " in out
    assert "  active  " in out and "[values: " in out


def test_schema_marks_a_table_the_deny_list_fences(db, capsys, monkeypatch):
    monkeypatch.setattr(config, "SQL_AGENT_DENY_TABLES", frozenset({"habits"}))
    exo_query.main(["schema"])
    out = capsys.readouterr().out
    assert "habits" in out and "[off limits to agents]" in out


def test_schema_for_a_missing_table_exits_1(db, capsys):
    assert exo_query.main(["schema", "nope"]) == 1
    assert "nope" in capsys.readouterr().err


def test_schema_without_a_database_exits_1(data_dir, capsys):
    assert exo_query.main(["schema"]) == 1
    assert "no_database" in capsys.readouterr().err


# --- query --------------------------------------------------------------------

def test_query_prints_tsv_with_a_header_and_a_row_count_on_stderr(db, capsys):
    assert exo_query.main(["query", "SELECT id, name FROM habits ORDER BY id"]) == 0
    captured = capsys.readouterr()
    assert captured.out == "id\tname\n1\tKefir\n2\tWalk\n"
    assert captured.err.strip() == "# 2 rows"


def test_query_keeps_every_row_on_one_line(db, capsys):
    exo_query.main(["query", "SELECT note FROM scratch ORDER BY id"])
    out = capsys.readouterr().out
    assert out == "note\ntab\\there\\nnewline\n\n"


def test_query_limit_announces_truncation(db, capsys):
    exo_query.main(["query", "SELECT name FROM habits", "--limit", "1"])
    captured = capsys.readouterr()
    assert captured.out.count("\n") == 2
    assert captured.err.strip() == "# 1 rows (truncated)"


def test_query_json_prints_the_run_query_dict(db, capsys):
    assert exo_query.main(["query", "SELECT id, name FROM habits ORDER BY id", "--json"]) == 0
    body = json.loads(capsys.readouterr().out)
    assert body["columns"] == ["id", "name"]
    assert body["rows"] == [[1, "Kefir"], [2, "Walk"]]
    assert body["truncated"] is False
    assert "plan" in body


def test_query_refusal_exits_1_with_the_reason_on_stderr(db, capsys):
    assert exo_query.main(["query", "DELETE FROM habits"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "not_read_only" in captured.err and "allowed" in captured.err.lower()


def test_query_honours_the_config_deny_list(db, capsys, monkeypatch):
    monkeypatch.setattr(config, "SQL_AGENT_DENY_TABLES", frozenset({"habits"}))
    assert exo_query.main(["query", "SELECT * FROM habits"]) == 1
    assert "denied_table" in capsys.readouterr().err


def test_deny_list_is_parsed_from_the_environment(monkeypatch):
    monkeypatch.setenv("EXOCORTEX_SQL_AGENT_DENY_TABLES", "tool_calls, requests,")
    try:
        assert importlib.reload(config).SQL_AGENT_DENY_TABLES == {"tool_calls", "requests"}
    finally:
        monkeypatch.delenv("EXOCORTEX_SQL_AGENT_DENY_TABLES")
        importlib.reload(config)
    assert config.SQL_AGENT_DENY_TABLES == frozenset()
