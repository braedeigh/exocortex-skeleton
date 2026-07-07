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


# --- lookup_pmcid / pmc_pdf_url refactor --------------------------------------

def test_lookup_pmcid_extracted_and_reused_by_pmc_pdf_url(monkeypatch):
    _fake_get_json(monkeypatch, value={"records": [{"pmcid": "PMC1234567"}]})
    r = paperclients.lookup_pmcid("10.1/xyz")
    assert r == {"ok": True, "pmcid": "PMC1234567"}


def test_lookup_pmcid_not_found(monkeypatch):
    _fake_get_json(monkeypatch, value={"records": []})
    assert paperclients.lookup_pmcid("10.1/xyz") == {"ok": False, "error": "not_found"}


# --- extract_pmcid (pure) -----------------------------------------------------

def test_extract_pmcid_from_articles_url():
    url = "https://pmc.ncbi.nlm.nih.gov/articles/PMC12327446"
    assert paperclients.extract_pmcid(url) == "PMC12327446"


def test_extract_pmcid_bare():
    assert paperclients.extract_pmcid("see PMC7654321 for details") == "PMC7654321"


def test_extract_pmcid_none_when_absent():
    assert paperclients.extract_pmcid("no pmcid here") is None
    assert paperclients.extract_pmcid("") is None
    assert paperclients.extract_pmcid(None) is None


# --- html_to_text (pure) -------------------------------------------------------

def test_html_to_text_drops_script_and_style():
    html = """
    <html><head><title>My Page</title><style>body{color:red}</style></head>
    <body>
      <script>alert('hi')</script>
      <p>Hello world.</p>
      <noscript>enable js</noscript>
    </body></html>
    """
    r = paperclients.html_to_text(html)
    assert r["title"] == "My Page"
    assert "alert" not in r["text"]
    assert "color:red" not in r["text"]
    assert "enable js" not in r["text"]
    assert "Hello world." in r["text"]


def test_html_to_text_paragraphs_are_newline_separated():
    html = "<body><p>First paragraph.</p><p>Second paragraph.</p></body>"
    r = paperclients.html_to_text(html)
    assert "First paragraph." in r["text"]
    assert "Second paragraph." in r["text"]
    parts = [p for p in r["text"].split("\n") if p.strip()]
    assert parts == ["First paragraph.", "Second paragraph."]


def test_html_to_text_collapses_excess_blank_lines():
    html = "<p>A</p>\n\n\n\n<p>B</p>"
    r = paperclients.html_to_text(html)
    assert "\n\n\n" not in r["text"]


def test_html_to_text_no_title_is_empty_string():
    r = paperclients.html_to_text("<body><p>No title here.</p></body>")
    assert r["title"] == ""


# --- xml_to_text (pure) ---------------------------------------------------------

def test_xml_to_text_strips_tags_and_breaks_on_p_sec_title():
    xml = (
        "<article><body><sec><title>Intro</title>"
        "<p>First bit.</p><p>Second bit.</p></sec></body></article>"
    )
    text = paperclients.xml_to_text(xml)
    assert "<p>" not in text
    assert "Intro" in text
    lines = [l for l in text.split("\n") if l.strip()]
    assert lines == ["Intro", "First bit.", "Second bit."]


# --- fetch_page_text -----------------------------------------------------------

def _fake_get(monkeypatch, value=None, exc=None):
    calls = []

    def fake(url, headers=None, want_content_type=False):
        calls.append((url, headers, want_content_type))
        if exc is not None:
            raise exc
        return value
    monkeypatch.setattr(paperclients, "_get", fake)
    return calls


def test_fetch_page_text_extracts_title_and_text(monkeypatch):
    html = "<html><head><title>A Blog Post</title></head><body><p>Body text.</p></body></html>"
    calls = _fake_get(monkeypatch, value=(html, "text/html; charset=utf-8"))
    r = paperclients.fetch_page_text("https://example.com/post")
    assert r == {"ok": True, "title": "A Blog Post", "text": "Body text."}
    url, headers, want_ct = calls[0]
    assert url == "https://example.com/post"
    assert "Mozilla" in headers["User-Agent"]
    assert want_ct is True


def test_fetch_page_text_non_html_content_type_is_not_html(monkeypatch):
    _fake_get(monkeypatch, value=("%PDF-1.4 ...", "application/pdf"))
    r = paperclients.fetch_page_text("https://example.com/paper.pdf")
    assert r == {"ok": False, "error": "not_html"}


def test_fetch_page_text_network_error(monkeypatch):
    _fake_get(monkeypatch, exc=urllib.error.HTTPError("u", 500, "boom", {}, None))
    r = paperclients.fetch_page_text("https://example.com/x")
    assert r == {"ok": False, "error": "http_500"}


# --- fetch_pmc_fulltext ---------------------------------------------------------

def test_fetch_pmc_fulltext_extracts_text(monkeypatch):
    xml = "<article><body><p>Full text here.</p></body></article>"
    _fake_get(monkeypatch, value=xml)
    r = paperclients.fetch_pmc_fulltext("PMC1234567")
    assert r == {"ok": True, "text": "Full text here."}


def test_fetch_pmc_fulltext_404_is_no_fulltext(monkeypatch):
    _fake_get(monkeypatch, exc=urllib.error.HTTPError("u", 404, "not found", {}, None))
    r = paperclients.fetch_pmc_fulltext("PMC1234567")
    assert r == {"ok": False, "error": "no_fulltext"}


def test_fetch_pmc_fulltext_other_http_error(monkeypatch):
    _fake_get(monkeypatch, exc=urllib.error.HTTPError("u", 500, "boom", {}, None))
    r = paperclients.fetch_pmc_fulltext("PMC1234567")
    assert r == {"ok": False, "error": "http_500"}


def test_fetch_pmc_fulltext_network_error(monkeypatch):
    _fake_get(monkeypatch, exc=OSError("boom"))
    r = paperclients.fetch_pmc_fulltext("PMC1234567")
    assert r == {"ok": False, "error": "network"}


# --- politeness sleep ---------------------------------------------------------

def test_each_public_fn_sleeps_for_rate_limit(monkeypatch):
    """Not zeroed here (overrides the autouse fixture) — pins the constant + call."""
    calls = []
    monkeypatch.setattr(paperclients.time, "sleep", lambda s: calls.append(s))
    _fake_get_json(monkeypatch, value={"message": {}})
    paperclients.crossref_work("10.1/xyz", "me@example.com")
    assert calls == [paperclients.RATE_LIMIT_S]



# --- jats_to_text (drops <front> metadata noise, keeps title/abstract/body) ---

def test_jats_to_text_keeps_body_drops_front():
    xml = (
        "<article><front><journal-meta><journal-id>sciadv</journal-id>"
        "<contrib><name>TuJiaobing</name></contrib></journal-meta>"
        "<article-title>Wearable sweat biosensor</article-title></front>"
        "<body><sec><title>Intro</title><p>Cortisol rises under stress.</p></sec></body>"
        "</article>"
    )
    text = paperclients.jats_to_text(xml)
    assert "Wearable sweat biosensor" in text
    assert "Cortisol rises under stress." in text
    assert "sciadv" not in text          # front journal-id dropped
    assert "TuJiaobing" not in text      # front contributor dropped


def test_jats_to_text_includes_abstract():
    xml = ("<article><front><article-title>T</article-title></front>"
           "<abstract><p>We built a biosensor.</p></abstract>"
           "<body><p>Methods here.</p></body></article>")
    text = paperclients.jats_to_text(xml)
    assert "Abstract" in text and "We built a biosensor." in text
    assert "Methods here." in text


def test_jats_to_text_falls_back_when_no_body():
    xml = "<article><p>Just a stub with no body element.</p></article>"
    text = paperclients.jats_to_text(xml)
    assert "Just a stub with no body element." in text
