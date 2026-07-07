"""Scholarly-API edge clients for the primary-source annotator (routes/research_sources.py)
and the document-text fetcher (routes/research_text.py).

Rust-translation-friendly rules (see labrador-port-spec.md): errors are values —
every public function returns `{"ok": True, ...}` or `{"ok": False, "error": "<code>"}`,
never raises across this module's boundary. Error codes: `"not_found"` (404 / no
match), `"http_<code>"` (other HTTP status), `"network"` (anything else — DNS,
timeout, bad JSON). Stdlib only (urllib, json, re, time, html.parser) — no new
pip deps.

All network I/O funnels through the `_get`/`_get_json` pair at the bottom of this
file — tests monkeypatch those two names, never `urllib` directly. Every public
function sleeps `RATE_LIMIT_S` first (labrador's politeness convention: these are
free public APIs with informal rate limits, not ours to hammer).

Shapes:
  - `crossref_work(doi, email)` -> `{"ok": True, "title": str, "authors": [{"given","family"}],
    "journal": str, "published": "YYYY[-MM[-DD]]", "abstract": str, "references": [doi, ...]}`
    (abstract has JATS `<jats:*>` tags stripped; references keeps only refs carrying a DOI)
    | `{"ok": False, "error": ...}`
  - `crossref_search_title(title, email)` -> `{"ok": True, "doi": str}` | `{"ok": False, "error": ...}`
  - `opencitations_citations(doi)` -> `{"ok": True, "citing": [doi, ...]}` | `{"ok": False, "error": ...}`
  - `unpaywall_lookup(doi, email)` -> `{"ok": True, "is_oa": bool, "pdf_url": str|None}` | error
  - `lookup_pmcid(doi)` -> `{"ok": True, "pmcid": str}` | `{"ok": False, "error": ...}`
    (the NCBI idconv lookup, factored out so both `pmc_pdf_url` and
    routes/research_text.py's doi-fallback strategy can share it)
  - `pmc_pdf_url(doi)` -> `{"ok": True, "pmcid": str, "pdf_url": str}` | `{"ok": False, "error": ...}`
    (v0 produces the link only — no fetch/pdftotext. # TODO(2): fetch + pdftotext layer.)
  - `extract_doi(text) -> str | None` — pure, no I/O.
  - `html_to_text(html) -> {"title": str, "text": str}` — pure; stdlib
    `html.parser.HTMLParser`-based readability extraction (script/style/noscript/
    head dropped, block tags become paragraph breaks; good-enough, not perfect).
  - `xml_to_text(xml) -> str` — pure; same whitespace discipline over JATS
    full-text XML (`<p>`/`<sec>`/`<title>` become paragraph breaks).
  - `extract_pmcid(text) -> str | None` — pure, regex `PMC\\d+`.
  - `fetch_page_text(url) -> {"ok": True, "title", "text"} | error` — GET + html_to_text.
    `"not_html"` when the response isn't html/text (e.g. a PDF landed here —
    the route surfaces this as `"pdf_extraction_unavailable"`. # TODO(2): pypdf/pdftotext layer).
  - `fetch_pmc_fulltext(pmcid) -> {"ok": True, "text"} | error` — GET Europe PMC's
    fullTextXML + xml_to_text. `"no_fulltext"` on 404 (NCBI's own endpoint has bot
    protection, hence Europe PMC — same reasoning as `pmc_pdf_url`).

# TODO(3): EXOCORTEX_CONTACT_EMAIL defaults to "" upstream in routes/research_sources.py,
# which falls back to a placeholder mailto — set a real contact email in the service env.
"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

RATE_LIMIT_S = 0.2
TIMEOUT_S = 20

_DOI_PREFIX_RE = re.compile(r"(https?://)?(dx\.)?doi\.org/", re.IGNORECASE)
_DOI_RE = re.compile(r"10\.\d{4,9}/\S+")
_JATS_TAG_RE = re.compile(r"<[^>]+>")
_PMCID_RE = re.compile(r"PMC\d+")

# A browser-ish UA so ordinary doc/blog sites don't 403 an obvious script.
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


# --- pure -----------------------------------------------------------------

def extract_doi(text):
    """Find a bare DOI in free text, e.g. a pasted URL or reference string.

    Strips `https://doi.org/` / `dx.doi.org/` prefixes (with or without scheme)
    wherever they occur, then matches `10.<4-9 digits>/<non-whitespace>`, then
    trims trailing punctuation the DOI regex's greedy `\\S+` tends to sweep up
    (closing parens/brackets/quotes, sentence punctuation). Returns None if no
    DOI-shaped substring is found — never raises.
    """
    if not text:
        return None
    cleaned = _DOI_PREFIX_RE.sub("", text)
    m = _DOI_RE.search(cleaned)
    if not m:
        return None
    return m.group(0).rstrip(".,;:)]}>\"'")


def extract_pmcid(text):
    """Find a PMC id in free text, e.g. a pmc.ncbi.nlm.nih.gov/articles/PMC12327446
    url. Returns None if none found — never raises."""
    if not text:
        return None
    m = _PMCID_RE.search(text)
    return m.group(0) if m else None


def _clean_extracted_text(raw):
    """Whitespace discipline shared by html_to_text/xml_to_text: strip each line,
    collapse 3+ blank-line runs to a single blank line, trim the ends."""
    lines = [line.strip() for line in raw.splitlines()]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    return text.strip()


_SKIP_TEXT_TAGS = {"script", "style", "noscript"}
_BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6",
    "tr", "table", "section", "article", "header", "footer", "blockquote", "pre",
}


class _HTMLTextExtractor(HTMLParser):
    """Good-enough readability extraction: drop script/style/noscript/head
    content, capture <title> text separately, and treat block-level tags as
    paragraph breaks. Not a full readability algorithm — just enough to turn
    a doc/blog page into a flat, annotatable string."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title_chunks = []
        self.chunks = []
        self._skip_depth = 0
        self._head_depth = 0
        self._title_depth = 0

    def _open(self, tag):
        if tag in _SKIP_TEXT_TAGS:
            self._skip_depth += 1
        if tag == "head":
            self._head_depth += 1
        if tag == "title":
            self._title_depth += 1
        if tag in _BLOCK_TAGS:
            self.chunks.append("\n")

    def _close(self, tag):
        if tag in _SKIP_TEXT_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
        if tag == "head":
            self._head_depth = max(0, self._head_depth - 1)
        if tag == "title":
            self._title_depth = max(0, self._title_depth - 1)
        if tag in _BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_starttag(self, tag, attrs):
        self._open(tag)

    def handle_startendtag(self, tag, attrs):
        if tag in _BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_endtag(self, tag):
        self._close(tag)

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._title_depth:
            self.title_chunks.append(data)
            return
        if self._head_depth:
            return
        self.chunks.append(data)


def html_to_text(html):
    """Extract a title + flat readable text from an HTML document. PURE —
    stdlib html.parser only, no I/O. Malformed markup never raises (best
    effort): `HTMLParser.feed` tolerates broken tags on its own, but we also
    swallow anything it doesn't."""
    extractor = _HTMLTextExtractor()
    try:
        extractor.feed(html or "")
        extractor.close()
    except Exception:
        pass
    title = re.sub(r"\s+", " ", "".join(extractor.title_chunks)).strip()
    text = _clean_extracted_text("".join(extractor.chunks))
    return {"title": title, "text": text}


_XML_BLOCK_TAGS = {"p", "sec", "title"}


class _XMLTextExtractor(HTMLParser):
    """Strip tags from JATS full-text XML; <p>/<sec>/<title> become paragraph
    breaks, same as html_to_text's block tags. HTMLParser is lenient enough to
    walk well-formed XML for this purpose."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.chunks = []

    def handle_starttag(self, tag, attrs):
        if tag in _XML_BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in _XML_BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in _XML_BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_data(self, data):
        self.chunks.append(data)


def xml_to_text(xml):
    """Flat readable text from JATS full-text XML. PURE — no I/O."""
    extractor = _XMLTextExtractor()
    try:
        extractor.feed(xml or "")
        extractor.close()
    except Exception:
        pass
    return _clean_extracted_text("".join(extractor.chunks))


_JATS_TITLE = re.compile(r"<article-title[^>]*>(.*?)</article-title>", re.S)
_JATS_ABSTRACT = re.compile(r"<abstract[^>]*>(.*?)</abstract>", re.S)
_JATS_BODY = re.compile(r"<body[^>]*>(.*?)</body>", re.S)


def jats_to_text(xml):
    """Readable text from JATS full-text XML: article title, abstract, body.
    The <front> metadata block (journal ids, contributor roles, dates mashed
    together) is dropped — it reads as noise at the top of a paper. Falls back
    to a whole-document strip when there is no <body>. PURE — no I/O."""
    xml = xml or ""
    m_body = _JATS_BODY.search(xml)
    if not m_body:
        return xml_to_text(xml)
    parts = []
    m = _JATS_TITLE.search(xml)
    if m:
        parts.append(xml_to_text(m.group(1)))
    m = _JATS_ABSTRACT.search(xml)
    if m:
        abstract = xml_to_text(m.group(1))
        if abstract.strip():
            # Some JATS abstracts carry their own "Abstract" <title>; don't double it.
            if abstract.lstrip().lower().startswith("abstract"):
                parts.append(abstract)
            else:
                parts.append("Abstract\n\n" + abstract)
    parts.append(xml_to_text(m_body.group(1)))
    return "\n\n".join(p for p in parts if p.strip())


# --- shared error mapping ---------------------------------------------------

def _error_code(exc):
    """Map a caught exception from `_get`/`_get_json` to a short error code."""
    if isinstance(exc, urllib.error.HTTPError):
        return "not_found" if exc.code == 404 else f"http_{exc.code}"
    return "network"


def _format_date_parts(parts):
    """Crossref `date-parts` (a list like [2020, 5, 1], possibly truncated) -> 'YYYY[-MM[-DD]]'."""
    parts = [p for p in parts if isinstance(p, int)]
    if not parts:
        return ""
    out = str(parts[0])
    if len(parts) >= 2:
        out += f"-{parts[1]:02d}"
    if len(parts) >= 3:
        out += f"-{parts[2]:02d}"
    return out


def _crossref_published(msg):
    """Best available publication date across Crossref's several date fields."""
    for key in ("published", "published-print", "published-online", "issued"):
        block = msg.get(key)
        if isinstance(block, dict):
            parts = block.get("date-parts")
            if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0]:
                formatted = _format_date_parts(parts[0])
                if formatted:
                    return formatted
    return ""


# --- Crossref ---------------------------------------------------------------

def crossref_work(doi, email):
    """Look up one work by DOI. REQUIRED for the annotator — see routes/research_sources.py."""
    time.sleep(RATE_LIMIT_S)
    url = f"https://api.crossref.org/works/{doi}"
    headers = {"User-Agent": f"Exocortex/1.0 (mailto:{email})"}
    try:
        result = _get_json(url, headers)
    except Exception as e:
        return {"ok": False, "error": _error_code(e)}
    msg = result.get("message") if isinstance(result, dict) else None
    if not isinstance(msg, dict):
        return {"ok": False, "error": "network"}

    titles = msg.get("title")
    title = titles[0] if isinstance(titles, list) and titles else ""
    authors = []
    for a in msg.get("author") or []:
        if isinstance(a, dict):
            authors.append({"given": a.get("given") or "", "family": a.get("family") or ""})
    containers = msg.get("container-title")
    journal = containers[0] if isinstance(containers, list) and containers else ""
    abstract = _JATS_TAG_RE.sub("", msg.get("abstract") or "").strip()
    references = []
    for r in msg.get("reference") or []:
        if isinstance(r, dict) and r.get("DOI"):
            references.append(r["DOI"])

    return {
        "ok": True,
        "title": title,
        "authors": authors,
        "journal": journal,
        "published": _crossref_published(msg),
        "abstract": abstract,
        "references": references,
    }


def crossref_search_title(title, email):
    """Best-effort DOI lookup by title, when no DOI was found in the entry's text/url."""
    time.sleep(RATE_LIMIT_S)
    q = urllib.parse.quote(title, safe="")
    url = f"https://api.crossref.org/works?query.title={q}&rows=5"
    headers = {"User-Agent": f"Exocortex/1.0 (mailto:{email})"}
    try:
        result = _get_json(url, headers)
    except Exception as e:
        return {"ok": False, "error": _error_code(e)}
    items = (result.get("message") or {}).get("items") if isinstance(result, dict) else None
    if not isinstance(items, list) or not items:
        return {"ok": False, "error": "not_found"}
    # Prefer a real journal-article record over a "component" (e.g. a figure/table
    # sub-record Crossref sometimes ranks first).
    journal_articles = [it for it in items if isinstance(it, dict) and it.get("type") == "journal-article"]
    chosen = journal_articles[0] if journal_articles else items[0]
    doi = chosen.get("DOI") if isinstance(chosen, dict) else None
    if not doi:
        return {"ok": False, "error": "not_found"}
    return {"ok": True, "doi": doi}


# --- OpenCitations -----------------------------------------------------------

def opencitations_citations(doi):
    """Who cites this DOI, per OpenCitations COCI. Optional enrichment — a failure
    here just means the annotator omits `cited_by`, it never blocks the annotate."""
    time.sleep(RATE_LIMIT_S)
    url = f"https://opencitations.net/index/coci/api/v1/citations/{doi}"
    try:
        result = _get_json(url, {"Accept": "application/json"})
    except Exception as e:
        return {"ok": False, "error": _error_code(e)}
    if not isinstance(result, list):
        return {"ok": True, "citing": []}
    citing = [row.get("citing") for row in result if isinstance(row, dict) and row.get("citing")]
    return {"ok": True, "citing": citing}


# --- Unpaywall ----------------------------------------------------------------

def unpaywall_lookup(doi, email):
    """Open-access status + a PDF link, if Unpaywall has one. Optional enrichment."""
    time.sleep(RATE_LIMIT_S)
    q = urllib.parse.quote(email, safe="")
    url = f"https://api.unpaywall.org/v2/{doi}?email={q}"
    try:
        result = _get_json(url)
    except Exception as e:
        return {"ok": False, "error": _error_code(e)}
    if not isinstance(result, dict):
        return {"ok": False, "error": "network"}
    pdf_url = None
    best = result.get("best_oa_location")
    if isinstance(best, dict):
        pdf_url = best.get("url_for_pdf") or best.get("url")
    return {"ok": True, "is_oa": bool(result.get("is_oa")), "pdf_url": pdf_url}


# --- PMC (Europe PMC render, since NCBI's own PDF endpoint has JS bot protection) --

def lookup_pmcid(doi):
    """NCBI idconv: DOI -> PMC id, or `not_found`. Factored out of `pmc_pdf_url`
    so routes/research_text.py's doi-fallback fulltext strategy can reuse the
    same lookup without going through the PDF-link-specific wrapper."""
    time.sleep(RATE_LIMIT_S)
    q = urllib.parse.quote(doi, safe="")
    url = f"https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids={q}&format=json"
    try:
        result = _get_json(url)
    except Exception as e:
        return {"ok": False, "error": _error_code(e)}
    records = result.get("records") if isinstance(result, dict) else None
    pmcid = records[0].get("pmcid") if isinstance(records, list) and records and isinstance(records[0], dict) else None
    if not pmcid:
        return {"ok": False, "error": "not_found"}
    return {"ok": True, "pmcid": pmcid}


def pmc_pdf_url(doi):
    """Fallback PDF link via PubMed Central, for when Unpaywall has no OA copy.
    v0 produces the link only. # TODO(2): fetch + pdftotext layer."""
    looked_up = lookup_pmcid(doi)
    if not looked_up.get("ok"):
        return looked_up
    pmcid = looked_up["pmcid"]
    return {
        "ok": True,
        "pmcid": pmcid,
        "pdf_url": f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf",
    }


# --- page / fulltext fetchers (routes/research_text.py) ----------------------

def fetch_page_text(url):
    """GET an arbitrary web page and extract readable text via html_to_text.
    Browser-ish User-Agent so ordinary doc/blog sites don't 403 an obvious
    script; redirects are followed (urllib does this by default). A non-html/
    text content type (most commonly a PDF) -> `{"ok": False, "error": "not_html"}`
    — the route surfaces that as "pdf_extraction_unavailable".
    # TODO(2): a pypdf/pdftotext layer so PDF urls work too."""
    time.sleep(RATE_LIMIT_S)
    try:
        body, content_type = _get(url, {"User-Agent": _BROWSER_UA}, want_content_type=True)
    except Exception as e:
        return {"ok": False, "error": _error_code(e)}
    content_type = (content_type or "").lower()
    if content_type and "html" not in content_type and "text" not in content_type:
        return {"ok": False, "error": "not_html"}
    extracted = html_to_text(body)
    return {"ok": True, "title": extracted["title"], "text": extracted["text"]}


def fetch_pmc_fulltext(pmcid):
    """GET Europe PMC's fullTextXML for a PMC id, jats_to_text it. 404 -> `no_fulltext`
    (NCBI's own fulltext endpoint has bot protection — Europe PMC again, same
    reasoning as `pmc_pdf_url`)."""
    time.sleep(RATE_LIMIT_S)
    q = urllib.parse.quote(pmcid, safe="")
    url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/{q}/fullTextXML"
    try:
        body = _get(url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"ok": False, "error": "no_fulltext"}
        return {"ok": False, "error": _error_code(e)}
    except Exception as e:
        return {"ok": False, "error": _error_code(e)}
    return {"ok": True, "text": jats_to_text(body)}


# --- the one network seam (tests monkeypatch these two, never urllib) --------

def _get(url, headers=None, want_content_type=False):
    """Raw GET -> decoded text body (or `(body, content_type)` when
    `want_content_type`). Raises urllib.error.HTTPError/URLError on failure."""
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        if want_content_type:
            return body, resp.headers.get("Content-Type", "")
        return body


def _get_json(url, headers=None):
    """GET + JSON-decode. Raises on network failure or invalid JSON."""
    return json.loads(_get(url, headers))
