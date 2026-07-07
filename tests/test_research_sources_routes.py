"""Behavioral tests for routes/research_sources.py (the primary-source annotator).

Mirrors test_research_routes.py: a minimal Flask app registering only this
module, an isolated data dir via the `data_dir` fixture, state read back
through `store`. All paperclients network calls are monkeypatched — no test
here ever touches the network, and the politeness sleep is zeroed.

Pins down: happy-path annotate writes `entry["meta"]` with `reviewed: False`;
non-source / missing-entry / no-DOI error paths; a REQUIRED Crossref failure
writes nothing (502 + unchanged entry); optional-API failures are omitted, not
fatal; the Unpaywall-miss -> PMC-fallback chain; meta-review flips the flag;
and a structural check that every network call happens before the store's
mutate lock is ever taken (never hold the file lock across a network call).
"""
import contextlib
import json

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)

import store
import paperclients
from routes import research_sources


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the research_sources routes."""
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research_sources.register(app)
    return app.test_client()


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(paperclients.time, "sleep", lambda s: None)


def _read():
    return store.read("research.json", {"topics": [], "entries": []})


def _seed_entry(**fields):
    entry = {
        "id": "e1", "kind": "source", "text": "A great paper", "topics": [],
        "url": "", "verdict": "", "status": "", "reply_to": None, "created": "2026-07-06 00:00",
    }
    entry.update(fields)
    store.write("research.json", {"topics": [], "entries": [entry]})
    return entry


def _ok_crossref_work(**overrides):
    base = {
        "ok": True, "title": "A Great Paper", "authors": [{"given": "Ada", "family": "Lovelace"}],
        "journal": "Journal of Things", "published": "2020-05-01",
        "abstract": "It matters.", "references": [],
    }
    base.update(overrides)
    return base


# --- annotate: happy path ------------------------------------------------------

def test_annotate_happy_path_writes_meta_reviewed_false(client, monkeypatch):
    _seed_entry(url="https://doi.org/10.1038/s41586-020-2649-2")
    monkeypatch.setattr(paperclients, "crossref_work", lambda doi, email: _ok_crossref_work())
    monkeypatch.setattr(paperclients, "opencitations_citations",
                         lambda doi: {"ok": True, "citing": ["10.1/a", "10.1/b"]})
    monkeypatch.setattr(paperclients, "unpaywall_lookup",
                         lambda doi, email: {"ok": True, "is_oa": True, "pdf_url": "https://x/pdf"})
    monkeypatch.setattr(paperclients, "pmc_pdf_url", lambda doi: {"ok": False, "error": "not_found"})

    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 200, r.get_json()
    entry = _read()["entries"][0]
    meta = entry["meta"]
    assert meta["kind"] == "source_metadata"
    assert meta["source"] == "auto"
    assert meta["reviewed"] is False
    assert meta["doi"] == "10.1038/s41586-020-2649-2"
    assert meta["title"] == "A Great Paper"
    assert meta["journal"] == "Journal of Things"
    assert meta["cited_by"] == 2
    assert meta["pdf_url"] == "https://x/pdf"
    assert "fetched" in meta


def test_annotate_falls_back_from_url_to_text_to_title_search(client, monkeypatch):
    """No DOI in url or text -> crossref_search_title(text[:200]) supplies it."""
    _seed_entry(url="not a doi", text="A Great Paper, somewhere")
    monkeypatch.setattr(paperclients, "crossref_search_title",
                         lambda title, email: {"ok": True, "doi": "10.9/found"})
    monkeypatch.setattr(paperclients, "crossref_work", lambda doi, email: _ok_crossref_work())
    monkeypatch.setattr(paperclients, "opencitations_citations", lambda doi: {"ok": False, "error": "network"})
    monkeypatch.setattr(paperclients, "unpaywall_lookup", lambda doi, email: {"ok": False, "error": "network"})
    monkeypatch.setattr(paperclients, "pmc_pdf_url", lambda doi: {"ok": False, "error": "not_found"})

    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 200, r.get_json()
    meta = _read()["entries"][0]["meta"]
    assert meta["doi"] == "10.9/found"


# --- annotate: error paths ------------------------------------------------------

def test_annotate_missing_entry_404(client):
    r = _post(client, "/api/research/entry/annotate", {"id": "nope"})
    assert r.status_code == 404


def test_annotate_non_source_kind_400(client):
    _seed_entry(kind="note")
    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 400


def test_annotate_no_doi_found_422(client, monkeypatch):
    _seed_entry(url="", text="nothing DOI-shaped here")
    monkeypatch.setattr(paperclients, "crossref_search_title", lambda title, email: {"ok": False, "error": "not_found"})
    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 422
    assert r.get_json()["error"] == "no DOI found"


def test_annotate_crossref_failure_502_and_entry_unchanged(client, monkeypatch):
    seeded = _seed_entry(url="https://doi.org/10.1000/xyz")
    monkeypatch.setattr(paperclients, "crossref_work", lambda doi, email: {"ok": False, "error": "http_500"})
    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 502
    assert r.get_json()["error"] == "crossref_http_500"
    entry = _read()["entries"][0]
    assert "meta" not in entry
    assert entry == seeded


def test_annotate_optional_failures_omitted_not_fatal(client, monkeypatch):
    _seed_entry(url="https://doi.org/10.1000/xyz")
    monkeypatch.setattr(paperclients, "crossref_work", lambda doi, email: _ok_crossref_work())
    monkeypatch.setattr(paperclients, "opencitations_citations", lambda doi: {"ok": False, "error": "network"})
    monkeypatch.setattr(paperclients, "unpaywall_lookup", lambda doi, email: {"ok": False, "error": "network"})
    monkeypatch.setattr(paperclients, "pmc_pdf_url", lambda doi: {"ok": False, "error": "network"})

    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 200, r.get_json()
    meta = _read()["entries"][0]["meta"]
    assert meta["cited_by"] is None
    assert meta["pdf_url"] is None


def test_annotate_unpaywall_miss_falls_back_to_pmc(client, monkeypatch):
    _seed_entry(url="https://doi.org/10.1000/xyz")
    monkeypatch.setattr(paperclients, "crossref_work", lambda doi, email: _ok_crossref_work())
    monkeypatch.setattr(paperclients, "opencitations_citations", lambda doi: {"ok": True, "citing": []})
    monkeypatch.setattr(paperclients, "unpaywall_lookup", lambda doi, email: {"ok": True, "is_oa": False, "pdf_url": None})
    monkeypatch.setattr(paperclients, "pmc_pdf_url", lambda doi: {"ok": True, "pmcid": "PMC1", "pdf_url": "https://europepmc.org/pmc1.pdf"})

    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 200, r.get_json()
    meta = _read()["entries"][0]["meta"]
    assert meta["pdf_url"] == "https://europepmc.org/pmc1.pdf"


# --- meta-review ----------------------------------------------------------------

def test_meta_review_flips_reviewed_flag(client):
    entry = _seed_entry(meta={"kind": "source_metadata", "source": "auto", "reviewed": False, "doi": "10.1/x"})
    r = _post(client, "/api/research/entry/meta-review", {"id": "e1", "reviewed": True})
    assert r.status_code == 200, r.get_json()
    assert _read()["entries"][0]["meta"]["reviewed"] is True


def test_meta_review_missing_entry_404(client):
    r = _post(client, "/api/research/entry/meta-review", {"id": "nope", "reviewed": True})
    assert r.status_code == 404


def test_meta_review_missing_meta_404(client):
    _seed_entry()  # no meta yet — hasn't been annotated
    r = _post(client, "/api/research/entry/meta-review", {"id": "e1", "reviewed": True})
    assert r.status_code == 404


# --- structural: network never happens inside the store's mutate lock ----------

def test_annotate_all_network_calls_happen_before_mutate_is_entered(client, monkeypatch):
    _seed_entry(url="https://doi.org/10.1000/xyz")
    order = []

    def _record(name, result):
        def _fn(*a, **kw):
            order.append(name)
            return result
        return _fn

    monkeypatch.setattr(paperclients, "crossref_work", _record("crossref_work", _ok_crossref_work()))
    monkeypatch.setattr(paperclients, "opencitations_citations", _record("opencitations", {"ok": True, "citing": []}))
    monkeypatch.setattr(paperclients, "unpaywall_lookup", _record("unpaywall", {"ok": True, "is_oa": False, "pdf_url": None}))
    monkeypatch.setattr(paperclients, "pmc_pdf_url", _record("pmc", {"ok": False, "error": "not_found"}))

    real_mutate = store.mutate

    @contextlib.contextmanager
    def _wrapped_mutate(name, default=None):
        order.append("mutate:enter")
        with real_mutate(name, default) as data:
            yield data

    monkeypatch.setattr(store, "mutate", _wrapped_mutate)

    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 200, r.get_json()

    assert "mutate:enter" in order
    mutate_at = order.index("mutate:enter")
    for name in ("crossref_work", "opencitations", "unpaywall", "pmc"):
        assert order.index(name) < mutate_at, f"{name} ran after the mutate lock was taken"


def test_annotate_never_calls_crossref_work_inside_mutate_on_early_error(client, monkeypatch):
    """The no-DOI 422 path never even opens the mutate block."""
    _seed_entry(url="", text="no doi here")
    monkeypatch.setattr(paperclients, "crossref_search_title", lambda title, email: {"ok": False, "error": "not_found"})

    entered = []
    real_mutate = store.mutate

    @contextlib.contextmanager
    def _wrapped_mutate(name, default=None):
        entered.append(True)
        with real_mutate(name, default) as data:
            yield data

    monkeypatch.setattr(store, "mutate", _wrapped_mutate)

    r = _post(client, "/api/research/entry/annotate", {"id": "e1"})
    assert r.status_code == 422
    assert entered == []
