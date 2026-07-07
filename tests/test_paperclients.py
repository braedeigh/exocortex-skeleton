"""Tests for paperclients.py (Crossref/OpenCitations/Unpaywall/PMC edge clients).

Network is never hit: every client goes through the module-level `_get_json` /
`_get` pair, which we monkeypatch per test. The politeness sleep is zeroed too
so the suite stays fast (real value is RATE_LIMIT_S = 0.2s per call).
"""
import urllib.error

import pytest

import paperclients


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(paperclients.time, "sleep", lambda s: None)


def _fake_get_json(monkeypatch, value=None, exc=None):
    """Patch _get_json to return `value` or raise `exc`, and record the call."""
    calls = []

    def fake(url, headers=None):
        calls.append((url, headers))
        if exc is not None:
            raise exc
        return value
    monkeypatch.setattr(paperclients, "_get_json", fake)
    return calls


# --- extract_doi (pure) ------------------------------------------------------

def test_extract_doi_bare():
    assert paperclients.extract_doi("see 10.1038/s41586-020-2649-2 for details") == "10.1038/s41586-020-2649-2"


def test_extract_doi_from_doi_org_url():
    assert paperclients.extract_doi("https://doi.org/10.1038/s41586-020-2649-2") == "10.1038/s41586-020-2649-2"


def test_extract_doi_from_dx_doi_org_url_no_scheme():
    assert paperclients.extract_doi("dx.doi.org/10.1234/abc.5678") == "10.1234/abc.5678"


def test_extract_doi_trims_trailing_punctuation():
    assert paperclients.extract_doi("See https://doi.org/10.1038/s41586-020-2649-2).") == "10.1038/s41586-020-2649-2"
    assert paperclients.extract_doi('"10.1038/s41586-020-2649-2"') == "10.1038/s41586-020-2649-2"


def test_extract_doi_none_when_absent():
    assert paperclients.extract_doi("no doi anywhere in this sentence") is None
    assert paperclients.extract_doi("") is None
    assert paperclients.extract_doi(None) is None


# --- crossref_work -----------------------------------------------------------

def test_crossref_work_normalizes_fields_and_strips_jats(monkeypatch):
    _fake_get_json(monkeypatch, value={
        "message": {
            "title": ["A Great Paper"],
            "author": [{"given": "Ada", "family": "Lovelace"}, {"family": "NoGiven"}],
            "container-title": ["Journal of Things"],
            "published": {"date-parts": [[2020, 5, 1]]},
            "abstract": "<jats:p>Background: <jats:italic>x</jats:italic> matters.</jats:p>",
            "reference": [{"DOI": "10.1/aaa"}, {"key": "no-doi-ref"}, {"DOI": "10.1/bbb"}],
        }
    })
    r = paperclients.crossref_work("10.1/xyz", "me@example.com")
    assert r["ok"] is True
    assert r["title"] == "A Great Paper"
    assert r["authors"] == [{"given": "Ada", "family": "Lovelace"}, {"given": "", "family": "NoGiven"}]
    assert r["journal"] == "Journal of Things"
    assert r["published"] == "2020-05-01"
    assert r["abstract"] == "Background: x matters."
    assert r["references"] == ["10.1/aaa", "10.1/bbb"]


def test_crossref_work_published_truncates_to_available_parts(monkeypatch):
    _fake_get_json(monkeypatch, value={"message": {"published": {"date-parts": [[2019]]}}})
    r = paperclients.crossref_work("10.1/xyz", "me@example.com")
    assert r["published"] == "2019"


def test_crossref_work_404_is_not_found(monkeypatch):
    _fake_get_json(monkeypatch, exc=urllib.error.HTTPError("u", 404, "not found", {}, None))
    r = paperclients.crossref_work("10.1/missing", "me@example.com")
    assert r == {"ok": False, "error": "not_found"}


def test_crossref_work_other_http_error_is_http_code(monkeypatch):
    _fake_get_json(monkeypatch, exc=urllib.error.HTTPError("u", 500, "boom", {}, None))
    r = paperclients.crossref_work("10.1/xyz", "me@example.com")
    assert r == {"ok": False, "error": "http_500"}


def test_crossref_work_network_error(monkeypatch):
    _fake_get_json(monkeypatch, exc=urllib.error.URLError("dns fail"))
    r = paperclients.crossref_work("10.1/xyz", "me@example.com")
    assert r == {"ok": False, "error": "network"}


def test_crossref_work_sends_user_agent_with_email(monkeypatch):
    calls = _fake_get_json(monkeypatch, value={"message": {}})
    paperclients.crossref_work("10.1/xyz", "bradie@example.com")
    url, headers = calls[0]
    assert "10.1/xyz" in url
    assert headers["User-Agent"] == "Exocortex/1.0 (mailto:bradie@example.com)"


# --- crossref_search_title ----------------------------------------------------

def test_crossref_search_title_prefers_journal_article(monkeypatch):
    _fake_get_json(monkeypatch, value={"message": {"items": [
        {"type": "component", "DOI": "10.1/component"},
        {"type": "journal-article", "DOI": "10.1/real"},
    ]}})
    r = paperclients.crossref_search_title("A Great Paper", "me@example.com")
    assert r == {"ok": True, "doi": "10.1/real"}


def test_crossref_search_title_falls_back_to_first_when_no_journal_article(monkeypatch):
    _fake_get_json(monkeypatch, value={"message": {"items": [{"type": "component", "DOI": "10.1/only"}]}})
    r = paperclients.crossref_search_title("Something", "me@example.com")
    assert r == {"ok": True, "doi": "10.1/only"}


def test_crossref_search_title_no_items_not_found(monkeypatch):
    _fake_get_json(monkeypatch, value={"message": {"items": []}})
    r = paperclients.crossref_search_title("Nothing matches", "me@example.com")
    assert r == {"ok": False, "error": "not_found"}


def test_crossref_search_title_network_error(monkeypatch):
    _fake_get_json(monkeypatch, exc=OSError("timed out"))
    r = paperclients.crossref_search_title("x", "me@example.com")
    assert r == {"ok": False, "error": "network"}


# --- opencitations_citations --------------------------------------------------

def test_opencitations_list_response(monkeypatch):
    _fake_get_json(monkeypatch, value=[{"citing": "10.1/a"}, {"citing": "10.1/b"}, {"oci": "no-citing-key"}])
    r = paperclients.opencitations_citations("10.1/xyz")
    assert r == {"ok": True, "citing": ["10.1/a", "10.1/b"]}


def test_opencitations_non_list_response_is_empty_citing(monkeypatch):
    _fake_get_json(monkeypatch, value={"message": "not a list"})
    r = paperclients.opencitations_citations("10.1/xyz")
    assert r == {"ok": True, "citing": []}


def test_opencitations_error(monkeypatch):
    _fake_get_json(monkeypatch, exc=urllib.error.HTTPError("u", 500, "boom", {}, None))
    r = paperclients.opencitations_citations("10.1/xyz")
    assert r == {"ok": False, "error": "http_500"}


# --- unpaywall_lookup ----------------------------------------------------------

def test_unpaywall_best_oa_url_for_pdf(monkeypatch):
    _fake_get_json(monkeypatch, value={
        "is_oa": True,
        "best_oa_location": {"url_for_pdf": "https://x/pdf", "url": "https://x/landing"},
    })
    r = paperclients.unpaywall_lookup("10.1/xyz", "me@example.com")
    assert r == {"ok": True, "is_oa": True, "pdf_url": "https://x/pdf"}


def test_unpaywall_falls_back_to_url_when_no_pdf_url(monkeypatch):
    _fake_get_json(monkeypatch, value={"is_oa": True, "best_oa_location": {"url": "https://x/landing"}})
    r = paperclients.unpaywall_lookup("10.1/xyz", "me@example.com")
    assert r == {"ok": True, "is_oa": True, "pdf_url": "https://x/landing"}


def test_unpaywall_not_oa_no_location(monkeypatch):
    _fake_get_json(monkeypatch, value={"is_oa": False, "best_oa_location": None})
    r = paperclients.unpaywall_lookup("10.1/xyz", "me@example.com")
    assert r == {"ok": True, "is_oa": False, "pdf_url": None}


def test_unpaywall_error(monkeypatch):
    _fake_get_json(monkeypatch, exc=urllib.error.HTTPError("u", 404, "not found", {}, None))
    r = paperclients.unpaywall_lookup("10.1/xyz", "me@example.com")
    assert r == {"ok": False, "error": "not_found"}


# --- pmc_pdf_url ---------------------------------------------------------------

def test_pmc_pdf_url_builds_europepmc_link(monkeypatch):
    _fake_get_json(monkeypatch, value={"records": [{"pmcid": "PMC1234567"}]})
    r = paperclients.pmc_pdf_url("10.1/xyz")
    assert r == {
        "ok": True,
        "pmcid": "PMC1234567",
        "pdf_url": "https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC1234567&blobtype=pdf",
    }


def test_pmc_pdf_url_no_pmcid_not_found(monkeypatch):
    _fake_get_json(monkeypatch, value={"records": [{"doi": "10.1/xyz"}]})
    r = paperclients.pmc_pdf_url("10.1/xyz")
    assert r == {"ok": False, "error": "not_found"}


def test_pmc_pdf_url_no_records_not_found(monkeypatch):
    _fake_get_json(monkeypatch, value={"records": []})
    r = paperclients.pmc_pdf_url("10.1/xyz")
    assert r == {"ok": False, "error": "not_found"}


def test_pmc_pdf_url_error(monkeypatch):
    _fake_get_json(monkeypatch, exc=OSError("boom"))
    r = paperclients.pmc_pdf_url("10.1/xyz")
    assert r == {"ok": False, "error": "network"}


# --- politeness sleep ---------------------------------------------------------

def test_each_public_fn_sleeps_for_rate_limit(monkeypatch):
    """Not zeroed here (overrides the autouse fixture) — pins the constant + call."""
    calls = []
    monkeypatch.setattr(paperclients.time, "sleep", lambda s: calls.append(s))
    _fake_get_json(monkeypatch, value={"message": {}})
    paperclients.crossref_work("10.1/xyz", "me@example.com")
    assert calls == [paperclients.RATE_LIMIT_S]
