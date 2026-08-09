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

def test_the_list_carries_the_whole_body_not_a_preview(pond_db, client):
    """The drawing reads cards in place and re-windows them around whichever
    thread is lit — which changes with no refetch. So the body has to already
    be there. The whole pool is a fraction of a megabyte."""
    body = ("a real entry, all of it, " * 8).strip()
    pond_db("whole", "2026-07-06", body=body)
    assert client.get("/api/pond/cards").get_json()["cards"][0]["body"] == body


def test_a_body_far_longer_than_anything_drawable_is_capped(pond_db, client):
    body = "x" * (pond.BODY_CHARS + 50)
    pond_db("essay", "2026-07-06", body=body)
    listed = client.get("/api/pond/cards").get_json()["cards"][0]
    assert len(listed["body"]) == pond.BODY_CHARS + 1  # + the ellipsis
    assert listed["body"].endswith("…")
    # Capped in the list, whole on the card itself.
    assert client.get("/api/pond/card/essay").get_json()["card"]["body"] == body


def test_body_collapses_whitespace(pond_db, client):
    pond_db("multi", "2026-07-06", body="first line\n\n  second   line ")
    listed = client.get("/api/pond/cards").get_json()["cards"][0]
    assert listed["body"] == "first line second line"


# --- the words an excerpt centres on -----------------------------------------

def test_a_tag_is_broken_into_the_words_a_card_might_actually_say(
    client, pond_db, vault
):
    """A tag is metadata, not a marker in the text: `housing-rent-and-the-move`
    names a preoccupation and she never types that string — but she does type
    *housing*, and *rent*, and *move*. Measured against this vault, matching
    whole phrases finds the thread in 62% of long cards; matching the component
    words finds it in 85%."""
    _, thread = vault
    thread("housing-rent-and-the-move", "Housing", ["health"])
    pond_db("c1", "2026-08-01", tags=["housing-rent-and-the-move"])

    terms = client.get("/api/pond/threads").get_json()["threads"][0]["terms"]
    assert "housing" in terms
    assert "rent" in terms
    assert "move" in terms
    # Grammar words carry no signal and would centre the window anywhere.
    assert "and" not in terms
    assert "the" not in terms


def test_a_threads_aliases_become_search_terms_too(client, pond_db, vault):
    _, thread = vault
    thread("long-covid", "Long COVID", ["health"],
           aliases=["post-exertional malaise", "PEM"])
    pond_db("c1", "2026-08-01", tags=["long-covid"])

    terms = client.get("/api/pond/threads").get_json()["threads"][0]["terms"]
    assert "covid" in terms
    assert "exertional" in terms
    assert "malaise" in terms
    # Two-letter noise never becomes a term — "pem" survives, "lc" wouldn't.
    assert all(len(t) > 2 for t in terms)


def test_a_person_gets_their_own_name_as_a_term(client, pond_db, vault):
    person, _ = vault
    person("sarah-naut")
    pond_db("c1", "2026-08-01", tags=["sarah-naut"])

    got = client.get("/api/pond/threads").get_json()["threads"][0]
    assert got["name"] == "Sarah Naut"
    assert set(got["terms"]) == {"sarah", "naut"}


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


# --- the rail's shelves ------------------------------------------------------
#
# The pond used to list ninety tags in one undifferentiated run. It doesn't need
# to invent a taxonomy to fix that: the vault ALREADY files these — a tag with a
# file in `people/` is a person, a tag with a file in `Threads/` is a thread, and
# that thread file's frontmatter names the fronts it belongs to. These tests pin
# that the route reads the vault's filing rather than guessing, and that an
# install with no such vault degrades to a flat list instead of erroring.


@pytest.fixture
def vault(tmp_path, monkeypatch):
    """A miniature content dir with the two folders the pond classifies from."""
    root = tmp_path / "vault"
    (root / "people").mkdir(parents=True)
    (root / "Threads").mkdir(parents=True)
    monkeypatch.setattr(store, "CONTENT_DIR", root)

    def person(slug):
        (root / "people" / f"{slug}.md").write_text("---\ntags: []\n---\n# x\n")

    def thread(slug, name, fronts, aliases=()):
        (root / "Threads" / f"{slug}.md").write_text(
            f"---\nname: {name}\nfronts: [{', '.join(fronts)}]\n"
            f"aliases: [{', '.join(aliases)}]\nstatus: active\n---\nbody\n"
        )

    return person, thread


def test_tags_are_classified_from_the_vaults_own_filing(client, pond_db, vault):
    person, thread = vault
    person("ezra")
    thread("long-covid", "Long COVID", ["health"])
    store.write("fronts", {"fronts": [{"id": "health", "name": "Health"}]})
    pond_db("c1", "2026-08-01", tags=["ezra"])
    pond_db("c2", "2026-08-01", tags=["long-covid"])
    pond_db("c3", "2026-08-01", tags=["kombucha"])

    by_tag = {t["tag"]: t for t in client.get("/api/pond/threads").get_json()["threads"]}
    assert by_tag["ezra"]["kind"] == "person"
    assert by_tag["long-covid"]["kind"] == "thread"
    # Never filed by the vault, so never guessed at here either.
    assert by_tag["kombucha"]["kind"] == "topic"


def test_a_thread_carries_the_fronts_its_frontmatter_names(client, pond_db, vault):
    _, thread = vault
    thread("dshs-job-fear", "The DSHS Job Fear", ["job", "learning"])
    store.write("fronts", {"fronts": [{"id": "job", "name": "Job"}]})
    pond_db("c1", "2026-08-01", tags=["dshs-job-fear"])

    got = client.get("/api/pond/threads").get_json()["threads"][0]
    assert got["name"] == "The DSHS Job Fear"
    assert got["fronts"] == ["job", "learning"]


def test_a_fronts_span_is_the_union_of_its_threads_days_not_the_sum(
    client, pond_db, vault, seed
):
    """Two threads under one front that both fire on the same day is ONE day of
    that front, not two. Summing would inflate exactly the number the rail ranks
    by, and the busiest front would be the one with the most threads rather than
    the one she actually lived in longest."""
    _, thread = vault
    thread("a-thread", "A", ["health"])
    thread("b-thread", "B", ["health"])
    store.write("fronts", {"fronts": [{"id": "health", "name": "Health"}]})
    pond_db("c1", "2026-08-01", tags=["a-thread"])
    pond_db("c2", "2026-08-01", tags=["b-thread"])  # same day, both threads
    pond_db("c3", "2026-08-02", tags=["a-thread"])

    fronts = client.get("/api/pond/threads").get_json()["fronts"]
    assert len(fronts) == 1
    assert fronts[0]["name"] == "Health"
    assert fronts[0]["days"] == 2       # not 3
    assert fronts[0]["cards"] == 3
    assert fronts[0]["tags"] == ["a-thread", "b-thread"]


def test_a_front_whose_threads_are_all_silent_is_not_listed(client, pond_db, vault):
    """A rail row that lights nothing is worse than no row."""
    _, thread = vault
    thread("quiet", "Quiet", ["hobbies"])
    store.write("fronts", {"fronts": [{"id": "hobbies", "name": "Hobbies"}]})
    pond_db("c1", "2026-08-01", tags=["something-else"])

    assert client.get("/api/pond/threads").get_json()["fronts"] == []


def test_deleted_cards_do_not_prop_up_a_front(client, pond_db, vault):
    _, thread = vault
    thread("t", "T", ["health"])
    store.write("fronts", {"fronts": [{"id": "health", "name": "Health"}]})
    pond_db("live", "2026-08-01", tags=["t"])
    pond_db("gone", "2026-08-02", tags=["t"], deleted="2026-08-03")

    fronts = client.get("/api/pond/threads").get_json()["fronts"]
    assert fronts[0]["days"] == 1


def test_a_front_id_missing_from_the_vocabulary_still_comes_through(
    client, pond_db, vault, seed
):
    """Titled from its own id rather than vanishing — a thread pointing at a
    front nobody defined is a vault typo to see, not a row to silently drop."""
    _, thread = vault
    thread("t", "T", ["not-in-fronts-json"])
    store.write("fronts", {"fronts": []})
    pond_db("c1", "2026-08-01", tags=["t"])

    fronts = client.get("/api/pond/threads").get_json()["fronts"]
    assert [f["id"] for f in fronts] == ["not-in-fronts-json"]


def test_a_vault_without_people_or_threads_degrades_to_a_flat_list(
    client, pond_db, tmp_path, monkeypatch
):
    """Any install that isn't hers. Every tag is a topic, no fronts, no error."""
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "nothing-here")
    pond_db("c1", "2026-08-01", tags=["whatever"])

    body = client.get("/api/pond/threads").get_json()
    assert [t["kind"] for t in body["threads"]] == ["topic"]
    assert body["fronts"] == []
