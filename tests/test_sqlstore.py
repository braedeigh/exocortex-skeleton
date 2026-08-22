"""Tests for the SQLite-backed store path (sqlstore.py + store.py dispatch).

SQL-backed collections (store.SQL_COLLECTIONS) must behave exactly like file
collections at the store.read/write/mutate contract — same round-trip, same
default-on-missing, same nothing-written-on-exception — while additionally:
the database is the source of truth for reads, the JSON file at the old path
is a current mirror after every write, and a legacy file is adopted (seeded)
on first touch so flipping a collection on needs no migration script.

Uses "car_maintenance" (a real member of SQL_COLLECTIONS) so the dispatch in
store.py is exercised, not just sqlstore directly.
"""
import json
import sqlite3

import pytest

import sqlstore
import store


def _db_row(data_dir, name):
    conn = sqlite3.connect(data_dir / "exo.db")
    try:
        row = conn.execute("SELECT data FROM docs WHERE name = ?", (name,)).fetchone()
        return None if row is None else json.loads(row[0])
    finally:
        conn.close()


def test_sql_write_read_roundtrip(data_dir):
    store.write("car_maintenance", {"entries": [{"id": "a1", "type": "oil"}]})
    assert store.read("car_maintenance") == {"entries": [{"id": "a1", "type": "oil"}]}


def test_sql_read_missing_returns_default(data_dir):
    assert store.read("car_maintenance", {"entries": []}) == {"entries": []}


def test_reads_come_from_the_database_not_the_file(data_dir):
    store.write("car_maintenance", {"entries": ["db"]})
    # Clobber the mirror file behind the store's back: reads must not see it.
    (data_dir / "car_maintenance.json").write_text(json.dumps({"entries": ["file"]}))
    assert store.read("car_maintenance") == {"entries": ["db"]}


def test_write_lands_in_sqlite_and_mirrors_to_json(data_dir):
    store.write("car_notes", {"text": "rotate tires"})
    assert _db_row(data_dir, "car_notes") == {"text": "rotate tires"}
    mirror = json.loads((data_dir / "car_notes.json").read_text())
    assert mirror == {"text": "rotate tires"}


def test_legacy_file_is_adopted_on_first_read(data_dir):
    # A pre-SQL data dir has only the JSON file; first touch seeds the DB row.
    (data_dir / "car_maintenance.json").write_text(json.dumps({"entries": ["legacy"]}))
    assert store.read("car_maintenance") == {"entries": ["legacy"]}
    assert _db_row(data_dir, "car_maintenance") == {"entries": ["legacy"]}


def test_malformed_legacy_file_is_not_adopted(data_dir):
    (data_dir / "car_maintenance.json").write_text("{not json")
    with pytest.raises(json.JSONDecodeError):
        store.read("car_maintenance")
    assert _db_row(data_dir, "car_maintenance") is None


def test_sql_mutate_persists_changes_and_mirror(data_dir):
    store.write("car_maintenance", {"entries": []})
    with store.mutate("car_maintenance") as d:
        d["entries"].append("first")
    assert store.read("car_maintenance")["entries"] == ["first"]
    mirror = json.loads((data_dir / "car_maintenance.json").read_text())
    assert mirror["entries"] == ["first"]


def test_sql_mutate_rolls_back_on_exception(data_dir):
    store.write("car_maintenance", {"entries": ["keep"]})
    with pytest.raises(ValueError):
        with store.mutate("car_maintenance") as d:
            d["entries"].append("doomed")
            raise ValueError("boom")
    assert store.read("car_maintenance")["entries"] == ["keep"]
    mirror = json.loads((data_dir / "car_maintenance.json").read_text())
    assert mirror["entries"] == ["keep"]


def test_sql_mutate_seeds_from_legacy_file(data_dir):
    (data_dir / "car_notes.json").write_text(json.dumps({"text": "old"}))
    with store.mutate("car_notes", {"text": ""}) as d:
        d["text"] += " + new"
    assert store.read("car_notes") == {"text": "old + new"}


def test_non_sql_collections_stay_on_files(data_dir):
    store.write("todos", {"now": {"items": []}})
    assert (data_dir / "todos.json").exists()
    assert not (data_dir / "exo.db").exists()


# --- the migration ladder must not trust its own stamp ------------------------

def _tables(data_dir):
    conn = sqlite3.connect(data_dir / "exo.db")
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()


def test_a_fresh_database_gets_every_table(data_dir):
    store.write("car_maintenance", {"entries": []})
    assert {"docs", "habits", "habit_aliases", "habit_entries",
            "expenses", "expense_categories"} <= _tables(data_dir)


def test_a_stamp_that_lies_is_repaired(data_dir):
    """Bumping _SCHEMA_VERSION before its rung exists stamps the new number
    anyway; every later connection then skips the rung forever. This happened on
    the live database — user_version said 4 with the expense tables missing."""
    import sqlstore
    store.write("car_maintenance", {"entries": []})
    conn = sqlite3.connect(data_dir / "exo.db")
    try:
        conn.execute("DROP TABLE expenses")
        conn.execute("DROP TABLE expense_categories")
        conn.execute(f"PRAGMA user_version = {sqlstore._SCHEMA_VERSION}")
        conn.commit()
    finally:
        conn.close()
    assert "expenses" not in _tables(data_dir)

    store.read("car_maintenance")          # any touch re-opens the database
    assert {"expenses", "expense_categories"} <= _tables(data_dir)


def test_migrating_an_already_current_database_changes_nothing(data_dir):
    import sqlstore
    store.write("car_maintenance", {"entries": [{"id": "a"}]})
    before = _tables(data_dir)
    sqlstore.open_db().close()
    assert _tables(data_dir) == before
    assert store.read("car_maintenance") == {"entries": [{"id": "a"}]}


def test_every_migrated_table_is_in_expected_tables(data_dir):
    """_EXPECTED_TABLES is the self-heal's eyes: _migrate's fast path trusts the
    version stamp only when every table in this tuple is really there, so a
    table missing from it can never be noticed as missing from the database.

    That is not hypothetical. Bumping _SCHEMA_VERSION and adding the rung are
    two separate edits, and a cron connection that lands between them stamps the
    new version having climbed only as far as the old ladder — after which the
    fast path skips the new rung forever. The stamp lying is exactly what
    _tables_present exists to catch, and it only catches it for tables listed
    here. (Happened on the live database when rung 13 went in.)
    """
    conn = sqlstore.open_db()
    try:
        built = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
            " AND name NOT LIKE 'sqlite_%'")}
    finally:
        conn.close()
    missing = built - set(sqlstore._EXPECTED_TABLES)
    assert not missing, (
        f"tables the ladder creates but _EXPECTED_TABLES doesn't list: "
        f"{sorted(missing)} — the self-heal is blind to these")
