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

import public_config
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


# --- the policy: which tables read in full, and which stay shapes ---------------
#
# Her 2026-09-22 call replaced "everything blurred" with a line: "Most of the
# database needs to be readable too, just not the stuff that is very personal",
# and of the personal half, "I want it visible in terms of the columns and rows
# but no actual information to be readable."
#
# The sharp one here is `test_a_visitor_cannot_search_a_vault_commits_subject`.
# `commits` is public, and a skeleton commit's subject reads in full — but a
# vault commit's does not, so a search that could reach that column would
# answer "does any vault commit mention X" through the matching count. A
# column is searchable only when it is public on EVERY row.

@pytest.fixture
def db(data_dir):
    """A database with one row in each of the tables these tests judge."""
    conn = sqlstore.open_db()
    try:
        conn.execute("INSERT INTO commits (sha, repo, authored_ts, authored_at, author, subject)"
                     " VALUES (?, ?, ?, ?, ?, ?)",
                     ("aaa111", "skeleton", 1, "2026-09-01T10:00:00", "A. Developer",
                      "The table layer, published with its values frosted"))
        conn.execute("INSERT INTO commits (sha, repo, authored_ts, authored_at, author, subject)"
                     " VALUES (?, ?, ?, ?, ?, ?)",
                     ("bbb222", "vault", 2, "2026-09-02T10:00:00", "A. Developer",
                      "Journal update, personal notes, and the weekly rollover"))
        for session_id, title, lane in (("2026-09-01.101010", "To-do checkbox dark screen bug", "coding"),
                                        ("2026-09-02.030356", "Weekend plans and a shopping list", "personal"),
                                        ("2026-09-03.040404", "Unplaced old session", None)):
            conn.execute("INSERT INTO sessions (id, title, bot, lane, started, last_at)"
                         " VALUES (?, ?, ?, ?, ?, ?)",
                         (session_id, title, "spark", lane, "2026-09-01T10:00:00",
                          "2026-09-01T11:00:00"))
            conn.execute("INSERT INTO session_turns (session_id, seq, ts, journaled)"
                         " VALUES (?, ?, ?, ?)", (session_id, 1, "2026-09-01T10:00:00", 0))
        conn.commit()
    finally:
        conn.close()
    return data_dir


@pytest.fixture
def visitor(db):
    app = Flask(__name__)
    terrain_tables.register(app)

    @app.before_request
    def gate():
        request.view_mode = "public"

    return app.test_client()


def _page(client, table, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return client.get(f"/api/observatory/terrain/tables/rows?table={table}&{query}").get_json()


def test_a_code_table_reads_in_full(visitor):
    """A skeleton commit is already public on GitHub — it reads in full."""
    body = _page(visitor, "commits")
    assert "The table layer, published with its values frosted" in [
        cell for row in body["rows"] for cell in row["cells"]]


def test_a_vault_commits_subject_is_frosted_but_the_rest_of_its_row_is_not(visitor):
    rows = {row["cells"][0]: row for row in _page(visitor, "commits")["rows"]}
    skeleton, vault = rows["aaa111"], rows["bbb222"]
    assert skeleton["frosted"] == [False] * len(skeleton["cells"])
    # subject is the 6th column; the sha, repo, timestamps and author survive.
    # The blocks are capped at _FROST_TEXT_MAX, and past it the cell says `cut`
    # — the same channel the owner's own long values use.
    assert set(vault["cells"][5]) == {"▒"}
    assert len(vault["cells"][5]) == terrain_tables._FROST_TEXT_MAX
    assert vault["cut"][5] is True
    assert vault["frosted"] == [False, False, False, False, False, True]
    assert vault["cells"][1] == "vault"


def test_a_visitor_cannot_search_a_vault_commits_subject(visitor):
    """A count over a value that is hidden on SOME rows is still that value."""
    # A word that appears ONLY in the vault commit's subject must count the
    # same as a word that appears nowhere at all — the search never reaches
    # that column, so neither answer says anything about it.
    hit = _page(visitor, "commits", q="personal")   # only in the vault subject
    miss = _page(visitor, "commits", q="zzzznope")
    assert hit["matching"] == miss["matching"] == 0
    assert "subject" in hit["locked_columns"]


def test_a_visitor_can_still_search_a_genuinely_public_column(visitor):
    """The feature isn't quietly dead — searching `repo` really narrows."""
    assert _page(visitor, "commits", q="skeleton")["matching"] == 1


def test_only_a_coding_session_keeps_its_name(visitor):
    # A list, not a dict: two frosted ids of the same length are the same
    # string, which is the point of frosting and would collapse a dict.
    rows = [(row["cells"][0], row["cells"][1]) for row in _page(visitor, "sessions")["rows"]]
    assert ("2026-09-01.101010", "To-do checkbox dark screen bug") in rows
    # Not coding → the room's name over a frosted id. NULL is not "coding", so
    # the unplaced session is covered by the default rather than by a guess.
    assert "Weekend plans and a shopping list" not in [title for _, title in rows]
    assert [title for _, title in rows].count("Personal") == 2


def test_a_personal_sessions_id_is_frosted(visitor):
    """Session ids are timestamps, so the id says as much as the title.
    routes/terrain.py anonymizes the same sessions on the map."""
    ids = [row["cells"][0] for row in _page(visitor, "sessions")["rows"]]
    assert "2026-09-01.101010" in ids            # the coding one keeps its id
    assert "2026-09-02.030356" not in ids
    assert "2026-09-03.040404" not in ids


def test_a_footprint_tables_session_id_follows_the_same_line(visitor):
    ids = [row["cells"][0] for row in _page(visitor, "session_turns")["rows"]]
    assert "2026-09-01.101010" in ids
    assert "2026-09-02.030356" not in ids


def test_an_unlisted_table_is_frosted_by_default(visitor, monkeypatch):
    """A table a future migration rung adds publishes nothing until someone
    lists it in public_config.TABLES on purpose."""
    monkeypatch.delattr(public_config, "TABLES", raising=False)
    monkeypatch.setattr(public_config, "TABLES", {}, raising=False)
    body = _page(visitor, "commits")
    assert body["frosted"] is True
    assert body["frosted_columns"] == ["sha", "repo", "authored_ts", "authored_at",
                                       "author", "subject"]
    assert "aaa111" not in [cell for row in body["rows"] for cell in row["cells"]]


def test_the_owner_reads_all_of_it(db):
    app = Flask(__name__)
    terrain_tables.register(app)

    @app.before_request
    def gate():
        request.view_mode = "authed"

    owner = app.test_client()
    cells = [cell for row in _page(owner, "sessions")["rows"] for cell in row["cells"]]
    assert "Weekend plans and a shopping list" in cells
