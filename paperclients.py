"""Scholarly-API edge clients for the primary-source annotator (routes/research_sources.py).

Rust-translation-friendly rules (see labrador-port-spec.md): errors are values —
every public function returns `{"ok": True, ...}` or `{"ok": False, "error": "<code>"}`,
never raises across this module's boundary. Error codes: `"not_found"` (404 / no
match), `"http_<code>"` (other HTTP status), `"network"` (anything else — DNS,
timeout, bad JSON). Stdlib only (urllib, json, re, time) — no new pip deps.

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
  - `pmc_pdf_url(doi)` -> `{"ok": True, "pmcid": str, "pdf_url": str}` | `{"ok": False, "error": ...}`
    (v0 produces the link only — no fetch/pdftotext. # TODO(2): fetch + pdftotext layer.)
  - `extract_doi(text) -> str | None` — pure, no I/O.

# TODO(3): EXOCORTEX_CONTACT_EMAIL defaults to "" upstream in routes/research_sources.py,
# which falls back to a placeholder mailto — set a real contact email in the service env.
"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

RATE_LIMIT_S = 0.2
TIMEOUT_S = 20

_DOI_PREFIX_RE = re.compile(r"(https?://)?(dx\.)?doi\.org/", re.IGNORECASE)
_DOI_RE = re.compile(r"10\.\d{4,9}/\S+")
_JATS_TAG_RE = re.compile(r"<[^>]+>")


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

def pmc_pdf_url(doi):
    """Fallback PDF link via PubMed Central, for when Unpaywall has no OA copy.
    v0 produces the link only. # TODO(2): fetch + pdftotext layer."""
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
    return {
        "ok": True,
        "pmcid": pmcid,
        "pdf_url": f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf",
    }


# --- the one network seam (tests monkeypatch these two, never urllib) --------

def _get(url, headers=None):
    """Raw GET -> decoded text body. Raises urllib.error.HTTPError/URLError on failure."""
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read().decode("utf-8")


def _get_json(url, headers=None):
    """GET + JSON-decode. Raises on network failure or invalid JSON."""
    return json.loads(_get(url, headers))
