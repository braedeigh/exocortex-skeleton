"""Behavioral tests for routes/research_text.py — the fetch-text strategy
route + the texts-listing endpoint. paperclients' network fns
(`fetch_pmc_fulltext`, `lookup_pmcid`, `fetch_pdf_text`, `fetch_url_text`) are
always monkeypatched; nothing here ever touches the network or a real file
outside the per-test tmp DATA_DIR (see conftest.data_dir). The PDF layer's own
behaviour (real pdftotext over a hand-built PDF) is in tests/test_pdf_text.py.
"""
import json

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)

import store


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the research-text routes."""
    from flask import Flask
    from routes import research_text
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research_text.register(app)
    return app.test_client()


def _seed_entry(**overrides):
    entry = {
        "id": "2026-07-06.2151",
        "kind": "source",
        "text": "a paper",
        "topics": [],
        "url": "",
        "verdict": "",
        "status": "",
        "reply_to": None,
        "created": "2026-07-06 21:51",
    }
    entry.update(overrides)
    store.write("research.json", {"topics": [], "entries": [entry]})
    return entry


# --- strategy order ------------------------------------------------------------

def test_pmc_url_beats_page_fetch(client, monkeypatch):
    from routes import research_text
    _seed_entry(url="https://pmc.ncbi.nlm.nih.gov/articles/PMC12327446")

    calls = []
    monkeypatch.setattr(
        research_text.paperclients, "fetch_pmc_fulltext",
        lambda pmcid: (calls.append(("pmc", pmcid)), {"ok": True, "text": "pmc full text"})[1],
    )
    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: (calls.append(("page", url)), {"ok": True, "title": "", "text": "page text"})[1],
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    assert r.status_code == 200
    body = r.get_json()
    assert body == {"ok": True, "doc": "entry:2026-07-06.2151", "chars": len("pmc full text"), "strategy": "pmc"}
    assert calls == [("pmc", "PMC12327446")]  # page fetch never even attempted


def test_doi_fallback_used_when_no_pmcid_in_url(client, monkeypatch):
    from routes import research_text
    _seed_entry(url="https://blog.example.com/post", meta={"doi": "10.1/xyz"})

    calls = []
    monkeypatch.setattr(
        research_text.paperclients, "lookup_pmcid",
        lambda doi: (calls.append(("lookup", doi)), {"ok": True, "pmcid": "PMC999"})[1],
    )
    monkeypatch.setattr(
        research_text.paperclients, "fetch_pmc_fulltext",
        lambda pmcid: (calls.append(("pmc", pmcid)), {"ok": True, "text": "doi-resolved text"})[1],
    )
    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: (calls.append(("page", url)), {"ok": True, "title": "", "text": "should not be used"})[1],
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    body = r.get_json()
    assert body["strategy"] == "pmc"
    assert body["chars"] == len("doi-resolved text")
    assert calls == [("lookup", "10.1/xyz"), ("pmc", "PMC999")]


def test_page_fallback_when_no_pmcid_and_no_doi(client, monkeypatch):
    from routes import research_text
    _seed_entry(url="https://blog.example.com/post")

    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: {"ok": True, "title": "A Post", "text": "blog text"},
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    body = r.get_json()
    assert body["ok"] is True
    assert body["strategy"] == "page"
    assert body["chars"] == len("blog text")


# --- saves through docstore ------------------------------------------------------

def test_fetched_text_saved_and_resolvable_via_docstore(client, monkeypatch, data_dir):
    from routes import research_text
    import docstore
    _seed_entry(url="https://blog.example.com/post")
    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: {"ok": True, "title": "", "text": "saved text"},
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    assert r.status_code == 200

    saved_files = list((data_dir / "doc_texts").iterdir())
    assert len(saved_files) == 1
    assert docstore.resolve("entry:2026-07-06.2151") == {"ok": True, "text": "saved text", "title": ""}


# --- validation ------------------------------------------------------------------

def test_missing_entry_404(client):
    r = _post(client, "/api/research/entry/fetch-text", {"id": "nope"})
    assert r.status_code == 404


def test_non_source_entry_400(client):
    _seed_entry(kind="note", url="https://example.com")
    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    assert r.status_code == 400


def test_no_url_or_doi_422(client):
    _seed_entry(url="")
    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    assert r.status_code == 422
    assert r.get_json()["error"] == "no url"


# --- all-fetchers-fail ------------------------------------------------------------

def test_all_strategies_fail_502_and_nothing_saved(client, monkeypatch, data_dir):
    from routes import research_text
    _seed_entry(url="https://blog.example.com/post")
    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: {"ok": False, "error": "network"},
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    assert r.status_code == 502
    assert r.get_json()["error"] == "network"
    assert not (data_dir / "doc_texts").exists()


@pytest.mark.parametrize("code", ["pdftotext_missing", "pdf_too_large", "pdf_extract_failed", "not_html"])
def test_fetcher_error_codes_pass_through_unmapped(client, monkeypatch, code):
    """The PDF path's real failure reasons reach the client as-is — nothing
    is folded into a vaguer catch-all."""
    from routes import research_text
    _seed_entry(url="https://example.com/paper.pdf")
    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: {"ok": False, "error": code},
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    assert r.status_code == 502
    assert r.get_json()["error"] == code


# --- the annotator's pdf_url ------------------------------------------------------

def test_meta_pdf_url_tried_before_entry_url(client, monkeypatch):
    from routes import research_text
    _seed_entry(
        url="https://journal.example.com/landing",
        meta={"doi": "10.1/xyz", "pdf_url": "https://oa.example.org/paper.pdf"},
    )

    calls = []
    monkeypatch.setattr(
        research_text.paperclients, "lookup_pmcid",
        lambda doi: (calls.append(("lookup", doi)), {"ok": False, "error": "not_found"})[1],
    )
    monkeypatch.setattr(
        research_text.paperclients, "fetch_pdf_text",
        lambda url, **kw: (calls.append(("pdf", url)), ("Hello research", None))[1],
    )
    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: (calls.append(("url", url)), {"ok": True, "title": "", "text": "landing page", "kind": "page"})[1],
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    body = r.get_json()
    assert body["strategy"] == "pdf"
    assert body["chars"] == len("Hello research")
    assert calls == [("lookup", "10.1/xyz"), ("pdf", "https://oa.example.org/paper.pdf")]


def test_meta_pdf_url_failure_falls_through_to_entry_url(client, monkeypatch):
    from routes import research_text
    _seed_entry(
        url="https://journal.example.com/landing",
        meta={"pdf_url": "https://oa.example.org/paper.pdf"},
    )
    monkeypatch.setattr(
        research_text.paperclients, "fetch_pdf_text",
        lambda url, **kw: (None, "not_pdf"),
    )
    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: {"ok": True, "title": "", "text": "landing page", "kind": "page"},
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    body = r.get_json()
    assert body["strategy"] == "page"
    assert body["chars"] == len("landing page")


def test_meta_pdf_url_same_as_entry_url_is_fetched_once(client, monkeypatch):
    from routes import research_text
    _seed_entry(
        url="https://oa.example.org/paper.pdf",
        meta={"pdf_url": "https://oa.example.org/paper.pdf"},
    )
    calls = []
    monkeypatch.setattr(
        research_text.paperclients, "fetch_pdf_text",
        lambda url, **kw: (calls.append(("pdf", url)), (None, "network"))[1],
    )
    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: (calls.append(("url", url)), {"ok": True, "title": "", "text": "from the pdf", "kind": "pdf"})[1],
    )

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-07-06.2151"})
    assert r.get_json()["strategy"] == "pdf"
    assert calls == [("url", "https://oa.example.org/paper.pdf")]


# --- texts listing -----------------------------------------------------------------

def test_texts_listing_reflects_fetched_entries(client, monkeypatch):
    from routes import research_text
    entry_a = {
        "id": "a", "kind": "source", "text": "x", "topics": [], "url": "https://x/1",
        "verdict": "", "status": "", "reply_to": None, "created": "2026-07-06 21:51",
    }
    entry_b = {
        "id": "b", "kind": "source", "text": "y", "topics": [], "url": "https://x/2",
        "verdict": "", "status": "", "reply_to": None, "created": "2026-07-06 21:51",
    }
    note_entry = {
        "id": "c", "kind": "note", "text": "z", "topics": [], "url": "",
        "verdict": "", "status": "", "reply_to": None, "created": "2026-07-06 21:51",
    }
    store.write("research.json", {"topics": [], "entries": [entry_a, entry_b, note_entry]})

    r0 = client.get("/api/research/texts")
    assert r0.get_json() == {"ok": True, "docs": []}

    monkeypatch.setattr(
        research_text.paperclients, "fetch_url_text",
        lambda url: {"ok": True, "title": "", "text": "fetched"},
    )
    _post(client, "/api/research/entry/fetch-text", {"id": "a"})

    r1 = client.get("/api/research/texts")
    assert r1.get_json() == {"ok": True, "docs": ["entry:a"]}
