"""What a VISITOR gets from the database's tables (routes/terrain_tables.py).

The owner's call: "i want it published but the actual values inside of the
tables will be blurred." So a stranger gets the architecture — the tables,
their columns, their counts — and never a value out of a row. These tests hold
that line where it actually lives: on the server, in the response, so no client
bug can un-blur what was never sent.

The subtle one is `test_a_visitors_search_cannot_narrow_anything`: a matching
COUNT is a value read one bit at a time, so search and filters have to stop
working for a visitor, not merely stop being shown.
"""
import pytest
from flask import Flask, request

import sqlstore
from routes import terrain_tables


SECRET_VALUE = "what i really think about all this"


@pytest.fixture
def tables_client(data_dir):
    """A bare app with only the tables routes, and one row of real text in the
    database. `view_mode` is set per request the way server.gate sets it."""
    conn = sqlstore.open_db()
    try:
        conn.execute("INSERT INTO habits (id, name, section, active, created_at)"
                     " VALUES (?, ?, ?, ?, ?)",
                     (1, SECRET_VALUE, "morning", 1, "2026-09-22T09:00:00"))
        conn.commit()
    finally:
        conn.close()

    app = Flask(__name__)
    terrain_tables.register(app)
    mode = {"view": "public"}

    @app.before_request
    def gate():
        request.view_mode = mode["view"]

    client = app.test_client()
    client.view_mode = mode          # the test flips this to become the owner
    return client


def _cells(response):
    return [cell for row in response.get_json()["rows"] for cell in row["cells"]]


def test_a_visitor_gets_the_shape_and_never_the_value(tables_client):
    got = tables_client.get("/api/observatory/terrain/tables/rows?table=habits")
    assert got.status_code == 200
    assert got.get_json()["frosted"] is True
    cells = _cells(got)
    assert SECRET_VALUE not in cells
    # The shape survives: the name's cell is as many blocks as it had letters.
    assert "▒" * len(SECRET_VALUE) in cells


def test_the_owner_still_reads_her_own_rows(tables_client):
    tables_client.view_mode["view"] = "authed"
    got = tables_client.get("/api/observatory/terrain/tables/rows?table=habits")
    assert "frosted" not in got.get_json()
    assert SECRET_VALUE in _cells(got)


def test_a_visitors_search_cannot_narrow_anything(tables_client):
    """A count over a hidden value is that value, read one bit at a time."""
    hit = tables_client.get("/api/observatory/terrain/tables/rows?table=habits&q=really")
    miss = tables_client.get("/api/observatory/terrain/tables/rows?table=habits&q=zzzznope")
    assert hit.get_json()["matching"] == miss.get_json()["matching"]
    assert hit.get_json()["search"] == ""


def test_a_visitors_filter_cannot_narrow_anything(tables_client):
    filtered = tables_client.get(
        '/api/observatory/terrain/tables/rows?table=habits'
        '&filters=[{"column":"name","op":"contains","value":"zzzznope"}]')
    assert filtered.get_json()["matching"] == 1


def test_a_column_keeps_its_counts_and_loses_its_examples(tables_client):
    got = tables_client.get("/api/observatory/terrain/tables/column?table=habits&column=name")
    profile = got.get_json()
    assert profile["frosted"] is True
    assert profile["total"] == 1 and profile["filled"] == 1
    assert profile["values"] is None
    for field in ("smallest", "largest", "average"):
        assert field not in profile


def test_a_row_opened_whole_is_frosted_too(tables_client):
    page = tables_client.get("/api/observatory/terrain/tables/rows?table=habits").get_json()
    rowid = page["rows"][0]["rowid"]
    whole = tables_client.get(f"/api/observatory/terrain/tables/row?table=habits&rowid={rowid}")
    assert whole.get_json()["frosted"] is True
    assert SECRET_VALUE not in whole.get_json()["values"]
