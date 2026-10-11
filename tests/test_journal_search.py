"""Journal keyword search — cardsearch.py and GET /api/journal/search.

The behaviors that must not silently break: word endings fold ("bartending"
finds "bartender"), quoted phrases keep their word order, -words exclude,
the who/date filters narrow, deleted cards stay out, a card written to disk a
moment ago is findable without waiting for the hourly mirror, and nothing she
can type (stray quotes, colons, FTS keywords) turns into a server error.

Pool files are written by hand in stream.py's exact shape, into an isolated
vault + exo.db (the same setup as test_cardstore.py).
"""
import json

import pytest
from flask import Flask

import cardsearch
import cardstore
import store
from routes import journal_search


def _write_card(pool, cid, body, who="B", tags=()):
    tag_line = f"tags: [{', '.join(tags)}]"
    (pool / f"{cid}.md").write_text(
        "---\n"
        f"id: {cid}\n"
        f"who: {who}\n"
        f"ts: {cid[:10]} {cid[11:13]}:{cid[13:15]}:00\n"
        "reply_to: null\n"
        f"{tag_line}\n"
        "kind: line\n"
        "refs: []\n"
        "session: null\n"
        "---\n"
        f"{body}\n",
        encoding="utf-8",
    )


@pytest.fixture
def pool(data_dir, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", data_dir / "content")
    p = data_dir / "content" / "_system" / "data" / "cards"
    p.mkdir(parents=True)
    return p


@pytest.fixture
def client(pool):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    journal_search.register(app)
    return app.test_client()


def _ids(client, **params):
    resp = client.get("/api/journal/search", query_string=params)
    assert resp.status_code == 200, resp.get_json()
    return [h["id"] for h in resp.get_json()["hits"]]


# --- query translation (pure) -------------------------------------------------

def test_query_quotes_every_piece_so_syntax_is_read_as_text():
    assert cardsearch.to_fts_query('tate AND (job:') == '"tate" AND "and" AND "(job:"'


def test_query_keeps_phrases_exclusions_and_prefixes():
    assert cardsearch.to_fts_query('"job site" apart* -indeed') == (
        '"job site" AND "apart"* NOT "indeed"')


def test_query_of_only_exclusions_is_nothing_to_search():
    assert cardsearch.to_fts_query("-tate") is None
    assert cardsearch.to_fts_query("   ") is None


# --- the route ---------------------------------------------------------------

def test_word_endings_fold_so_bartending_finds_bartender(pool, client):
    _write_card(pool, "2026-09-18.1746b", "Tate says look for bartender gigs on Poached")
    assert _ids(client, q="bartending") == ["2026-09-18.1746b"]


def test_every_plain_word_must_appear(pool, client):
    _write_card(pool, "2026-09-18.1746b", "Tate sent me a job site")
    _write_card(pool, "2026-09-19.0900b", "a job interview today")
    assert _ids(client, q="tate job") == ["2026-09-18.1746b"]


def test_quoted_phrase_needs_its_word_order(pool, client):
    _write_card(pool, "2026-09-18.1746b", "the job site for bartending")
    _write_card(pool, "2026-09-19.0900b", "the site had one job")
    assert _ids(client, q='"job site"') == ["2026-09-18.1746b"]


def test_minus_word_excludes(pool, client):
    _write_card(pool, "2026-09-18.1746b", "job site from Tate")
    _write_card(pool, "2026-09-19.0900b", "job site from Indeed")
    assert _ids(client, q="job -indeed") == ["2026-09-18.1746b"]


def test_who_filter_keeps_only_that_speaker(pool, client):
    _write_card(pool, "2026-09-18.1746b", "bartending job", who="B")
    _write_card(pool, "2026-09-18.1747k", "bartending job", who="K")
    assert _ids(client, q="bartending", who="K") == ["2026-09-18.1747k"]


def test_date_bounds_are_inclusive(pool, client):
    for day in ("2026-09-01", "2026-09-10", "2026-09-20"):
        _write_card(pool, f"{day}.1200b", "bartending")
    assert _ids(client, q="bartending", sort="oldest", **{"from": "2026-09-10", "to": "2026-09-20"}) == [
        "2026-09-10.1200b", "2026-09-20.1200b"]


def test_newest_sort_puts_latest_first(pool, client):
    _write_card(pool, "2026-09-01.1200b", "bartending")
    _write_card(pool, "2026-09-20.1200b", "bartending")
    assert _ids(client, q="bartending", sort="newest") == ["2026-09-20.1200b", "2026-09-01.1200b"]


def test_a_card_just_written_to_disk_is_found(pool, client):
    # Nothing has synced the mirror — the route's catch-up must pick it up.
    _write_card(pool, "2026-09-24.1000b", "fresh line about Poached")
    assert _ids(client, q="poached") == ["2026-09-24.1000b"]


def test_deleted_card_is_not_found(pool, client):
    _write_card(pool, "2026-09-18.1746b", "bartending job")
    cardstore.sync()
    (pool / "2026-09-18.1746b.md").unlink()
    (pool.parent / "deleted_cards.jsonl").write_text(
        json.dumps({"id": "2026-09-18.1746b", "body": "bartending job",
                    "deleted_at": "2026-09-24 10:00:00"}) + "\n")
    cardstore.sync()
    assert _ids(client, q="bartending") == []


def test_edited_card_is_found_by_its_new_words_only(pool, client):
    _write_card(pool, "2026-09-18.1746b", "old words here")
    cardstore.sync()
    _write_card(pool, "2026-09-18.1746b", "new words about Poached")
    cardstore.sync()
    assert _ids(client, q="poached") == ["2026-09-18.1746b"]
    assert _ids(client, q="old") == []


def test_snippet_marks_the_hit_words(pool, client):
    _write_card(pool, "2026-09-18.1746b", "Got feedback from Tate on Instagram", tags=["jobs"])
    hit = client.get("/api/journal/search?q=tate").get_json()["hits"][0]
    assert [p["text"] for p in hit["snippet"] if p["hit"]] == ["Tate"]
    assert "".join(p["text"] for p in hit["snippet"]) == "Got feedback from Tate on Instagram"
    assert hit["tags"] == ["jobs"]


def test_empty_or_only_excluded_query_is_a_400(pool, client):
    assert client.get("/api/journal/search?q=").status_code == 400
    assert client.get("/api/journal/search?q=-tate").status_code == 400


@pytest.mark.parametrize("q", ['"', 'job"', "a:b", "NEAR(", "*", "OR", "^x", "'"])
def test_odd_input_never_errors(pool, client, q):
    _write_card(pool, "2026-09-18.1746b", "job site")
    assert client.get("/api/journal/search", query_string={"q": q}).status_code in (200, 400)


def test_total_counts_past_the_page(pool, client):
    for minute in range(5):
        _write_card(pool, f"2026-09-18.120{minute}b", "bartending")
    body = client.get("/api/journal/search?q=bartending&limit=2").get_json()
    assert (body["total"], len(body["hits"])) == (5, 2)


def test_marked_body_is_the_whole_card_with_hits_wrapped(pool, client):
    _write_card(pool, "2026-09-18.1746b", "Tired today.\n\nGot feedback from Tate on Instagram")
    hit = client.get("/api/journal/search?q=tate").get_json()["hits"][0]
    assert hit["marked_body"] == "Tired today.\n\nGot feedback from \x02Tate\x03 on Instagram"
