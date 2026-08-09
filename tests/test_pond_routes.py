"""The pond's read API (routes/pond.py) — the journal's own shape out of exo.db.

Same shape as the other route tests: a minimal Flask app registering only the
blueprint under test, against an isolated `data_dir`. The difference is the
fixture — this one builds a throwaway `exo.db` with the two tables cardstore.py
mirrors the card pool into, so the tests own their data end to end and never
depend on a synced database being present.

The behaviour that matters most and is easiest to regress: threads rank by
SPAN (distinct days touched), not by volume. A tag that fires forty times in
one afternoon is a busy day; a tag that surfaces on ten days across a month is
a thread. The drawing is about the second one.
"""
import sqlite3

import pytest
from flask import Flask

import store
from routes import pond


SCHEMA = """
CREATE TABLE cards (
  id TEXT PRIMARY KEY, day TEXT NOT NULL, ts TEXT, who TEXT NOT NULL DEFAULT 'B',
  kind TEXT, reply_to TEXT, session TEXT, refs TEXT, body TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, deleted_at TEXT,
  missing_since TEXT);
CREATE TABLE card_tags (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  tag TEXT NOT NULL, PRIMARY KEY (card_id, tag));
"""


@pytest.fixture
def pond_db(data_dir):
    """A throwaway exo.db, and a helper to put cards in it."""
    conn = sqlite3.connect(data_dir / "exo.db")
    conn.executescript(SCHEMA)

    def add(cid, day, ts="09:00", who="B", body="", tags=(), deleted=None):
        conn.execute(
            "INSERT INTO cards (id, day, ts, who, kind, body, first_seen,"
            " last_seen, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (cid, day, ts, who, "note", body, day, day, deleted),
        )
        for t in tags:
            conn.execute("INSERT INTO card_tags (card_id, tag) VALUES (?,?)", (cid, t))
        conn.commit()

    yield add
    conn.close()


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    pond.register(app)
    return app.test_client()


# --- threads rank by span, not volume ----------------------------------------

def test_threads_rank_by_days_touched_not_card_count(pond_db, client):
    """`busy` has more cards; `slow` touches more days. Slow wins — that's the
    whole point of the ranking."""
    for i in range(6):
        pond_db(f"busy{i}", "2026-07-06", ts=f"1{i}:00", tags=["busy"])
    for d in ("2026-07-06", "2026-07-14", "2026-07-22"):
        pond_db(f"slow{d}", d, tags=["slow"])

    threads = client.get("/api/pond/threads").get_json()["threads"]
    assert [t["tag"] for t in threads] == ["slow", "busy"]
    assert threads[0]["days"] == 3 and threads[0]["cards"] == 3
    assert threads[1]["days"] == 1 and threads[1]["cards"] == 6


def test_threads_report_their_own_span(pond_db, client):
    pond_db("a", "2026-07-06", tags=["long-covid"])
    pond_db("b", "2026-08-08", tags=["long-covid"])
    thread = client.get("/api/pond/threads").get_json()["threads"][0]
    assert thread["first"] == "2026-07-06" and thread["last"] == "2026-08-08"


# --- deleted cards are not part of the pond ----------------------------------

def test_deleted_cards_are_excluded_everywhere(pond_db, client):
    """The pool keeps tombstones on purpose, but a drawing of where her data
    SITS should not draw what she removed."""
    pond_db("kept", "2026-07-06", tags=["t"])
    pond_db("gone", "2026-07-07", tags=["t"], deleted="2026-07-08")

    assert [c["id"] for c in client.get("/api/pond/cards").get_json()["cards"]] == ["kept"]
    assert client.get("/api/pond/threads").get_json()["threads"][0]["days"] == 1


# --- the window ---------------------------------------------------------------

def test_cards_are_filtered_to_the_window_inclusively(pond_db, client):
    for d in ("2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08"):
        pond_db(f"c{d}", d)
    got = client.get("/api/pond/cards?from=2026-07-06&to=2026-07-07").get_json()
    assert [c["day"] for c in got["cards"]] == ["2026-07-06", "2026-07-07"]


def test_cards_come_back_in_time_order(pond_db, client):
    pond_db("second", "2026-07-06", ts="14:00")
    pond_db("first", "2026-07-06", ts="08:00")
    pond_db("next-day", "2026-07-07", ts="01:00")
    got = client.get("/api/pond/cards").get_json()["cards"]
    assert [c["id"] for c in got] == ["first", "second", "next-day"]


@pytest.mark.parametrize("qs", ["from=nope", "to=2026-13-99", "from=2026-08-09&to=2026-07-01"])
def test_a_bad_window_is_rejected(pond_db, client, qs):
    assert client.get(f"/api/pond/cards?{qs}").status_code == 400
    assert client.get(f"/api/pond/threads?{qs}").status_code == 400


# --- one thread at a time -----------------------------------------------------

def test_tag_filter_narrows_to_one_thread(pond_db, client):
    pond_db("in", "2026-07-06", tags=["ezra", "dating"])
    pond_db("out", "2026-07-06", tags=["housing"])
    got = client.get("/api/pond/cards?tag=ezra").get_json()
    assert [c["id"] for c in got["cards"]] == ["in"]
    assert got["tag"] == "ezra"
    # The card carries its OTHER tags too — filtering by one thread shouldn't
    # hide that a card belongs to several.
    assert got["cards"][0]["tags"] == ["dating", "ezra"]


# --- the card itself ----------------------------------------------------------

def test_preview_is_truncated_but_the_full_body_is_one_tap_away(pond_db, client):
    body = "x" * (pond.PREVIEW_CHARS + 50)
    pond_db("long", "2026-07-06", body=body)
    listed = client.get("/api/pond/cards").get_json()["cards"][0]
    assert len(listed["preview"]) == pond.PREVIEW_CHARS + 1  # + the ellipsis
    assert listed["preview"].endswith("…")
    assert client.get("/api/pond/card/long").get_json()["card"]["body"] == body


def test_preview_collapses_whitespace(pond_db, client):
    pond_db("multi", "2026-07-06", body="first line\n\n  second   line ")
    listed = client.get("/api/pond/cards").get_json()["cards"][0]
    assert listed["preview"] == "first line second line"


def test_card_detail_carries_its_tags(pond_db, client):
    pond_db("c1", "2026-07-06", tags=["b", "a"])
    card = client.get("/api/pond/card/c1").get_json()["card"]
    assert card["tags"] == ["a", "b"] and card["day"] == "2026-07-06"


def test_missing_card_is_404_and_junk_id_is_400(pond_db, client):
    assert client.get("/api/pond/card/nope").status_code == 404
    assert client.get("/api/pond/card/has%20space").status_code == 400


# --- nothing here may ever write ---------------------------------------------

def test_the_connection_refuses_writes(pond_db, client):
    """The pool in the vault is the record; this is a mirror. SQLite itself
    enforces it, not a convention."""
    from contextlib import closing
    with closing(pond._read_only_conn()) as conn:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("DELETE FROM cards")
