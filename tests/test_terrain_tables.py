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
  - the rows door pages through a table, searches every column as text, treats
    % and _ as ordinary characters, cuts long cells short (around the match,
    when there is one) and says so, and the single-row door returns them whole
  - rows are closed to visitors, and an unknown table is a 404, not SQL
  - rows can be filtered by column and sorted either way, empties always last;
    "is not" keeps the rows with no value; a made-up column or filter word is
    refused before it gets near SQL; the SQL that ran is sent back, runnable
  - one column can be profiled: how full, how many different values, every
    value with its count when they're few, none when the column is prose
  - every COLUMN sqlstore.py creates has a plain-English note, and each
    table's declared time column really exists
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
        assert set(notes[name]) == {"holds", "source", "kind", "time_column", "columns"}
        assert notes[name]["kind"] in {"mirror", "record", "store", "mixed"}


def test_every_column_in_the_schema_has_a_note(data_dir):
    """Build a brand-new database the way the app does (sqlstore's migration
    ladder), then compare its real columns with the notes. Reading the columns
    back from SQLite, rather than parsing CREATE TABLE text, means columns
    added later by ALTER TABLE are held to the same rule."""
    import sqlstore
    sqlstore.open_db().close()
    notes = json.loads((Path(store.BUILD_DIR) / "table_notes.json").read_text())
    conn = sqlite3.connect(data_dir / "exo.db")
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
    assert tables, "the ladder made no tables"
    for table in tables:
        real = {c[1] for c in conn.execute(f'PRAGMA table_info("{table}")')}
        noted = set(notes[table]["columns"])
        assert real - noted == set(), f"{table}: columns with no description"
        assert noted - real == set(), f"{table}: descriptions for columns that don't exist"
        assert notes[table]["time_column"] in real | {None}
        for column in notes[table]["columns"].values():
            assert set(column) <= {"holds", "values"} and column["holds"]
    conn.close()


# --- the rows themselves ---------------------------------------------------------

LONG_TITLE = "x" * 400 + " the needle sits deep inside " + "y" * 400


@pytest.fixture
def library(vault):
    """A table with a number, a percent sign, an underscore and one very long cell."""
    conn = sqlite3.connect(vault / "exo.db")
    conn.execute("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, pages INTEGER)")
    conn.executemany("INSERT INTO books (title, pages) VALUES (?, ?)", [
        ("Dune", 412), ("50% off", 20), ("snake_case", 99), ("snakeXcase", 7), (LONG_TITLE, 1),
    ])
    conn.commit()
    conn.close()


def _rows(client, **params):
    resp = client.get("/api/observatory/terrain/tables/rows", query_string=params)
    return resp.status_code, resp.get_json()


def test_rows_come_back_a_page_at_a_time_in_stored_order(client, library):
    status, page = _rows(client, table="books", limit=2, offset=1)
    assert status == 200
    assert page["columns"] == ["id", "title", "pages"]
    assert [r["cells"][1] for r in page["rows"]] == ["50% off", "snake_case"]
    assert (page["total"], page["matching"]) == (5, 5)


def test_search_looks_in_every_column_including_numbers(client, library):
    _, by_text = _rows(client, table="books", q="dune")
    _, by_number = _rows(client, table="books", q="412")
    assert [r["cells"][1] for r in by_text["rows"]] == ["Dune"]
    assert [r["cells"][1] for r in by_number["rows"]] == ["Dune"]
    assert (by_text["total"], by_text["matching"]) == (5, 1)


def test_search_treats_percent_and_underscore_as_plain_characters(client, library):
    _, percent = _rows(client, table="books", q="50%")
    _, underscore = _rows(client, table="books", q="snake_case")
    assert [r["cells"][1] for r in percent["rows"]] == ["50% off"]
    assert [r["cells"][1] for r in underscore["rows"]] == ["snake_case"]


def test_long_cell_is_cut_short_and_says_so(client, library):
    _, page = _rows(client, table="books", q="xxxx")
    row = page["rows"][0]
    assert row["cut"] == [False, True, False]
    assert len(row["cells"][1]) < len(LONG_TITLE)


def test_cut_cell_shows_the_part_that_matched(client, library):
    _, page = _rows(client, table="books", q="needle")
    assert "needle" in page["rows"][0]["cells"][1]


def test_one_row_comes_back_whole(client, library):
    _, page = _rows(client, table="books", q="needle")
    rowid = page["rows"][0]["rowid"]
    resp = client.get("/api/observatory/terrain/tables/row",
                      query_string={"table": "books", "rowid": rowid})
    assert resp.get_json()["values"][1] == LONG_TITLE


def test_unknown_table_is_not_found_rather_than_run_as_sql(client, library):
    status, _ = _rows(client, table='books"; DROP TABLE books; --')
    assert status == 404
    assert _rows(client, table="books")[1]["total"] == 5


def test_rows_are_closed_to_visitors(data_dir, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    visitor = server.app.test_client()
    assert visitor.get("/api/observatory/terrain/tables/rows?table=todos").status_code == 401
    assert visitor.get("/api/observatory/terrain/tables/row?table=todos&rowid=1").status_code == 401


# --- filtering, sorting, and the SQL that did it ---------------------------------

@pytest.fixture
def shelf(vault):
    """Books with a category, a yes/no, a date with gaps, and a page count."""
    conn = sqlite3.connect(vault / "exo.db")
    conn.execute("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, genre TEXT,"
                 " read INTEGER, finished TEXT, pages INTEGER)")
    conn.executemany(
        "INSERT INTO books (title, genre, read, finished, pages) VALUES (?, ?, ?, ?, ?)", [
            ("Dune", "scifi", 1, "2026-03-01T09:00", 412),
            ("Emma", "classic", 1, "2026-05-20T21:30", 320),
            ("Ubik", "scifi", 0, None, 202),
            ("Solaris", "scifi", 1, "2026-05-20T08:00", 204),
            ("Untitled", None, 0, None, 10),
        ])
    conn.commit()
    conn.close()


def _filtered(client, filters=None, **params):
    if filters is not None:
        params["filters"] = json.dumps(filters)
    return _rows(client, table="books", **params)


def _titles(page):
    return [r["cells"][1] for r in page["rows"]]


def test_filter_keeps_only_the_chosen_categories(client, shelf):
    _, page = _filtered(client, [{"column": "genre", "op": "is", "values": ["scifi"]}])
    assert _titles(page) == ["Dune", "Ubik", "Solaris"]
    assert (page["total"], page["matching"]) == (5, 3)


def test_filters_stack(client, shelf):
    _, page = _filtered(client, [{"column": "genre", "op": "is", "values": ["scifi"]},
                                 {"column": "read", "op": "is", "values": [1]}])
    assert _titles(page) == ["Dune", "Solaris"]


def test_is_not_keeps_rows_that_have_no_value_at_all(client, shelf):
    _, page = _filtered(client, [{"column": "genre", "op": "is_not", "values": ["scifi"]}])
    assert _titles(page) == ["Emma", "Untitled"]


def test_empty_and_not_empty(client, shelf):
    _, unfinished = _filtered(client, [{"column": "finished", "op": "empty"}])
    _, finished = _filtered(client, [{"column": "finished", "op": "not_empty"}])
    assert _titles(unfinished) == ["Ubik", "Untitled"]
    assert _titles(finished) == ["Dune", "Emma", "Solaris"]


def test_date_range_includes_the_whole_last_day(client, shelf):
    _, page = _filtered(client, [{"column": "finished", "op": "min", "value": "2026-04-01"},
                                 {"column": "finished", "op": "max", "value": "2026-05-20"}])
    assert sorted(_titles(page)) == ["Emma", "Solaris"]


def test_number_range_compares_as_numbers(client, shelf):
    _, page = _filtered(client, [{"column": "pages", "op": "min", "value": "203"}])
    assert sorted(_titles(page)) == ["Dune", "Emma", "Solaris"]


def test_sort_newest_first_puts_empty_dates_last(client, shelf):
    _, page = _filtered(client, sort="finished", dir="desc")
    assert _titles(page) == ["Emma", "Solaris", "Dune", "Ubik", "Untitled"]


def test_sort_oldest_first_still_puts_empty_dates_last(client, shelf):
    _, page = _filtered(client, sort="finished", dir="asc")
    assert _titles(page) == ["Dune", "Solaris", "Emma", "Ubik", "Untitled"]


def test_made_up_column_or_filter_word_is_refused(client, shelf):
    assert _filtered(client, [{"column": "nope", "op": "is", "values": [1]}])[0] == 400
    assert _filtered(client, [{"column": "genre", "op": "drop", "values": [1]}])[0] == 400
    assert _filtered(client, sort='id"; DROP TABLE books; --')[0] == 400
    assert _filtered(client)[1]["total"] == 5


def test_the_sql_sent_back_gives_the_same_rows_when_run(client, shelf, vault):
    _, page = _filtered(client, [{"column": "genre", "op": "is", "values": ["scifi"]}],
                        q="s", sort="pages", dir="desc")
    conn = sqlite3.connect(vault / "exo.db")
    rerun = [r[1] for r in conn.execute(page["sql"])]
    conn.close()
    assert rerun == _titles(page)


# --- one column, profiled --------------------------------------------------------

def _column(client, column):
    resp = client.get("/api/observatory/terrain/tables/column",
                      query_string={"table": "books", "column": column})
    return resp.status_code, resp.get_json()


def test_category_column_lists_every_value_with_its_count(client, shelf):
    _, profile = _column(client, "genre")
    assert profile["looks_like"] == "category"
    assert profile["values"] == [{"value": "scifi", "rows": 3}, {"value": "classic", "rows": 1}]
    assert (profile["filled"], profile["empty"], profile["distinct"]) == (4, 1, 2)
    assert profile["values_complete"] is True


def test_column_kinds_are_read_from_the_data(client, shelf):
    assert _column(client, "read")[1]["looks_like"] == "yesno"
    assert _column(client, "pages")[1]["looks_like"] == "number"
    assert _column(client, "finished")[1]["looks_like"] == "date"


def test_prose_column_lists_no_values(client, library):
    _, profile = _column(client, "title")
    assert profile["prose"] is True and profile["values"] is None


def test_unknown_column_is_not_found(client, shelf):
    assert _column(client, 'genre"; DROP TABLE books; --')[0] == 404


def test_column_profile_is_closed_to_visitors(data_dir, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    visitor = server.app.test_client()
    assert visitor.get("/api/observatory/terrain/tables/column?table=todos&column=text").status_code == 401
