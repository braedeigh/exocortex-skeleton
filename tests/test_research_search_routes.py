"""Behavioral tests for GET /api/research/search (routes/research_search.py).

Mirrors test_research_routes.py: a minimal Flask app registering only this
module, isolated data dir via the `data_dir` fixture. The corpus spans two
sources — research.json entries and *.md files in EXOCORTEX_RESEARCH_DIR —
so most tests seed both. Vector mode is exercised with a monkeypatched
`embeddings` module (no real network): a tiny 2-dim keyword-presence
embedding is enough to prove reconcile + cosine ranking end to end.
"""
import json

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)

import store


def _get(client, path):
    return client.get(path)


@pytest.fixture
def client(data_dir):
    from flask import Flask
    from routes import research_search
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research_search.register(app)
    return app.test_client()


def _seed_research(entries=None, topics=None):
    store.write("research.json", {
        "topics": topics or [],
        "entries": entries or [],
    })


def _entry(id, text, kind="note", topics=None, **extra):
    e = {"id": id, "kind": kind, "text": text, "topics": topics or [],
         "url": "", "verdict": "", "status": "", "reply_to": None, "created": "2026-07-06 00:00"}
    e.update(extra)
    return e


@pytest.fixture
def research_dir(data_dir, monkeypatch, tmp_path):
    d = tmp_path / "notes"
    d.mkdir()
    monkeypatch.setenv("EXOCORTEX_RESEARCH_DIR", str(d))
    return d


def _write_note(research_dir, name, content):
    (research_dir / name).write_text(content, encoding="utf-8")


# --- keyword mode: entries -------------------------------------------------------

def test_keyword_search_matches_entry_text(client, data_dir):
    _seed_research(entries=[
        _entry("e1", "Melatonin timing shifts circadian rhythm.", kind="claim"),
        _entry("e2", "Grocery list: eggs, milk.", kind="note"),
    ])
    body = _get(client, "/api/research/search?q=melatonin").get_json()
    assert body["ok"] is True
    assert body["mode"] == "keyword"
    ids = [h["id"] for h in body["hits"]]
    assert ids == ["entry:e1"]
    assert body["hits"][0]["kind"] == "entry"
    assert body["hits"][0]["entry_kind"] == "claim"


def test_keyword_search_resolves_topic_names(client, data_dir):
    _seed_research(
        topics=[{"id": "sleep", "name": "Sleep", "status": "active", "created": ""}],
        entries=[_entry("e1", "melatonin and sleep onset", topics=["sleep"])],
    )
    body = _get(client, "/api/research/search?q=melatonin").get_json()
    assert body["hits"][0]["topics"] == ["Sleep"]


def test_keyword_search_skips_blank_text_entries(client, data_dir):
    _seed_research(entries=[_entry("e1", "   ", kind="note")])
    body = _get(client, "/api/research/search?q=anything").get_json()
    assert body["hits"] == []


def test_phrase_search_through_endpoint(client, data_dir):
    _seed_research(entries=[
        _entry("e1", "circadian rhythm disruption from screens"),
        _entry("e2", "circadian misalignment, rhythm not adjacent here... rhythm"),
    ])
    body = _get(client, '/api/research/search?q="circadian rhythm"').get_json()
    assert [h["id"] for h in body["hits"]] == ["entry:e1"]


def test_negation_through_endpoint(client, data_dir):
    _seed_research(entries=[
        _entry("e1", "sleep and caffeine interplay"),
        _entry("e2", "sleep hygiene basics"),
    ])
    body = _get(client, "/api/research/search?q=sleep -caffeine").get_json()
    assert [h["id"] for h in body["hits"]] == ["entry:e2"]


def test_empty_query_returns_no_hits(client, data_dir):
    _seed_research(entries=[_entry("e1", "anything at all")])
    body = _get(client, "/api/research/search?q=").get_json()
    assert body["hits"] == []


# --- keyword mode: notes ---------------------------------------------------------

def test_notes_are_searchable_with_heading_title(client, data_dir, research_dir):
    _write_note(research_dir, "sleep.md", "# Sleep notes\n\nMelatonin and light exposure.")
    body = _get(client, "/api/research/search?q=melatonin").get_json()
    assert len(body["hits"]) == 1
    hit = body["hits"][0]
    assert hit["id"] == "note:sleep.md"
    assert hit["kind"] == "note"
    assert hit["title"] == "Sleep notes"
    assert "entry_kind" not in hit
    assert "topics" not in hit


def test_note_without_heading_falls_back_to_filename(client, data_dir, research_dir):
    _write_note(research_dir, "misc.md", "just some text, no heading, mentions widgets")
    body = _get(client, "/api/research/search?q=widgets").get_json()
    assert body["hits"][0]["title"] == "misc.md"


def test_non_markdown_files_ignored(client, data_dir, research_dir):
    (research_dir / "ignore.txt").write_text("widgets widgets widgets", encoding="utf-8")
    body = _get(client, "/api/research/search?q=widgets").get_json()
    assert body["hits"] == []


def test_subdirectory_ignored_non_recursive(client, data_dir, research_dir):
    sub = research_dir / "sub"
    sub.mkdir()
    (sub / "deep.md").write_text("# Deep\nwidgets here", encoding="utf-8")
    body = _get(client, "/api/research/search?q=widgets").get_json()
    assert body["hits"] == []


def test_unreadable_note_skipped_not_500(client, data_dir, research_dir, monkeypatch):
    _write_note(research_dir, "bad.md", "widgets everywhere")
    import pathlib
    real_read_text = pathlib.Path.read_text

    def _boom(self, *a, **k):
        if self.name == "bad.md":
            raise OSError("simulated unreadable file")
        return real_read_text(self, *a, **k)

    monkeypatch.setattr(pathlib.Path, "read_text", _boom)
    resp = _get(client, "/api/research/search?q=widgets")
    assert resp.status_code == 200
    assert resp.get_json()["hits"] == []


def test_no_research_dir_is_not_an_error(client, data_dir, monkeypatch, tmp_path):
    monkeypatch.setenv("EXOCORTEX_RESEARCH_DIR", str(tmp_path / "does-not-exist"))
    resp = _get(client, "/api/research/search?q=anything")
    assert resp.status_code == 200
    assert resp.get_json()["hits"] == []


# --- limit clamping ----------------------------------------------------------------

def test_limit_clamps_to_minimum_one(client, data_dir):
    _seed_research(entries=[_entry("e1", "widget one"), _entry("e2", "widget two")])
    body = _get(client, "/api/research/search?q=widget&limit=0").get_json()
    assert len(body["hits"]) == 1


def test_limit_non_integer_falls_back_to_default(client, data_dir):
    _seed_research(entries=[_entry("e1", "widget one")])
    resp = _get(client, "/api/research/search?q=widget&limit=banana")
    assert resp.status_code == 200
    assert len(resp.get_json()["hits"]) == 1


def test_limit_clamps_to_maximum_hundred(client, data_dir):
    _seed_research(entries=[_entry(f"e{i}", "widget") for i in range(5)])
    resp = _get(client, "/api/research/search?q=widget&limit=99999")
    assert resp.status_code == 200
    assert len(resp.get_json()["hits"]) == 5  # well under the 100 cap, just proving no crash


# --- vector mode -------------------------------------------------------------------

def test_vector_mode_503_when_unconfigured(client, data_dir, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    resp = _get(client, "/api/research/search?q=cats&mode=vector")
    assert resp.status_code == 503
    assert resp.get_json()["error"] == "Vector search unavailable"


def _fake_embed_batch(texts):
    """A tiny deterministic 2-dim embedding: [has "cats", has "dogs"]."""
    return {"ok": True, "vectors": [
        [1.0 if "cats" in t.lower() else 0.0, 1.0 if "dogs" in t.lower() else 0.0]
        for t in texts
    ]}


@pytest.fixture
def fake_embeddings(monkeypatch):
    import embeddings
    monkeypatch.setattr(embeddings, "configured", lambda: True)
    monkeypatch.setattr(embeddings, "embed_batch", _fake_embed_batch)
    return embeddings


def test_vector_mode_reconciles_writes_one_vector_per_doc_and_ranks(client, data_dir, fake_embeddings):
    _seed_research(entries=[
        _entry("e1", "all about cats and their naps"),
        _entry("e2", "all about dogs and their walks"),
    ])
    body = _get(client, "/api/research/search?q=cats&mode=vector").get_json()
    assert body["ok"] is True
    assert body["mode"] == "vector"
    assert [h["id"] for h in body["hits"]] == ["entry:e1", "entry:e2"]
    vectors = store.read("research_vectors.json", {"vectors": []})["vectors"]
    assert len(vectors) == 2
    ids = sorted(v["id"] for v in vectors)
    assert ids == ["entry:e1", "entry:e2"]


def test_vector_mode_replaces_stale_vector_on_text_edit(client, data_dir, fake_embeddings):
    _seed_research(entries=[_entry("e1", "all about dogs")])
    _get(client, "/api/research/search?q=dogs&mode=vector")
    before = store.read("research_vectors.json")["vectors"]
    assert len(before) == 1
    assert before[0]["content"] == "all about dogs"

    _seed_research(entries=[_entry("e1", "all about cats now")])
    _get(client, "/api/research/search?q=cats&mode=vector")
    after = store.read("research_vectors.json")["vectors"]
    assert len(after) == 1  # exactly one vector for e1, not two
    assert after[0]["id"] == "entry:e1"
    assert after[0]["content"] == "all about cats now"


def test_vector_mode_drops_orphan_after_entry_removal(client, data_dir, fake_embeddings):
    _seed_research(entries=[
        _entry("e1", "all about cats"),
        _entry("e2", "all about dogs"),
    ])
    _get(client, "/api/research/search?q=cats&mode=vector")
    assert len(store.read("research_vectors.json")["vectors"]) == 2

    _seed_research(entries=[_entry("e1", "all about cats")])  # e2 removed
    _get(client, "/api/research/search?q=cats&mode=vector")
    vectors = store.read("research_vectors.json")["vectors"]
    assert [v["id"] for v in vectors] == ["entry:e1"]


def test_vector_mode_embed_failure_is_503_keyword_still_fine(client, data_dir, monkeypatch):
    import embeddings
    monkeypatch.setattr(embeddings, "configured", lambda: True)
    monkeypatch.setattr(embeddings, "embed_batch", lambda texts: {"ok": False, "error": "http_429"})
    _seed_research(entries=[_entry("e1", "all about cats")])

    resp = _get(client, "/api/research/search?q=cats&mode=vector")
    assert resp.status_code == 503
    assert resp.get_json()["error"] == "Vector search unavailable"

    ok = _get(client, "/api/research/search?q=cats")
    assert ok.status_code == 200
    assert ok.get_json()["mode"] == "keyword"
    assert len(ok.get_json()["hits"]) == 1
