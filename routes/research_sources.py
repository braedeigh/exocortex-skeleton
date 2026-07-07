"""Primary-source annotator — enriches a research `source` entry from public
scholarly APIs (Crossref / OpenCitations / Unpaywall / PMC via paperclients.py).

Labrador (the design this ports) built the sockets — the raw-text + annotations
API, `needs_review` born true, the `{kind, source: llm|human, reviewed}` content
convention — but the puller itself was always meant to be an external consumer.
This is that consumer, built native instead of bolted on.

    entry["meta"] = {"kind": "source_metadata", "source": "auto", "reviewed": False,
                     "doi", "title", "authors", "journal", "published", "abstract",
                     "cited_by": int|None, "pdf_url": str|None, "fetched": "YYYY-MM-DD HH:MM"}

`reviewed: False` is the needs-review convention preserved from labrador; the
existing entry-level "verified" verdict toggle (routes/research.py) stays the
human sign-off. `meta-review` here flips just the metadata's own reviewed flag —
a lighter per-fetch checkbox, not the verdict.

IMPORTANT house rule (never hold the store's file lock across a network call):
every Crossref/OpenCitations/Unpaywall/PMC call in `annotate` happens BEFORE the
`store.mutate` block. A failure at any REQUIRED step returns an error with
nothing written — the mutate block only opens once every value it will write
is already in hand.
"""
import os
from datetime import datetime

from flask import request, jsonify

import store
import paperclients

DEFAULT_CONTACT_EMAIL = "exocortex@example.com"


def _contact_email():
    # TODO(3): set a real contact email in the service env; "" here falls back
    # to a placeholder mailto (labrador's default-email pattern).
    return (os.environ.get("EXOCORTEX_CONTACT_EMAIL") or "").strip() or DEFAULT_CONTACT_EMAIL


def _now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _find_entry(data, eid):
    return next((e for e in data.get("entries", []) if e.get("id") == eid), None)


def _blob(data):
    return jsonify({"ok": True, "topics": data.get("topics", []), "entries": data.get("entries", [])})


def _resolve_doi(entry, email):
    """extract_doi(url) -> extract_doi(text) -> crossref_search_title(text[:200]) -> None."""
    doi = paperclients.extract_doi(entry.get("url") or "")
    if doi:
        return doi
    doi = paperclients.extract_doi(entry.get("text") or "")
    if doi:
        return doi
    search = paperclients.crossref_search_title((entry.get("text") or "")[:200], email)
    if search.get("ok"):
        return search.get("doi")
    return None


def register(app):

    @app.route("/api/research/entry/annotate", methods=["POST"])
    def annotate_research_entry():
        body = request.json or {}
        eid = body.get("id")

        data = store.read("research.json", {"topics": [], "entries": []})
        entry = _find_entry(data, eid)
        if not entry:
            return jsonify({"error": "not found"}), 404
        if entry.get("kind") != "source":
            return jsonify({"error": "not a source"}), 400

        email = _contact_email()

        doi = _resolve_doi(entry, email)
        if not doi:
            return jsonify({"error": "no DOI found"}), 422

        # REQUIRED — no fallback, nothing gets written if Crossref fails.
        work = paperclients.crossref_work(doi, email)
        if not work.get("ok"):
            return jsonify({"error": f"crossref_{work.get('error')}"}), 502

        # Optional enrichment — failures are silently omitted (the field just
        # stays None), they never fail the whole annotate.
        cited_by = None
        cites = paperclients.opencitations_citations(doi)
        if cites.get("ok"):
            cited_by = len(cites.get("citing") or [])

        pdf_url = None
        oa = paperclients.unpaywall_lookup(doi, email)
        if oa.get("ok") and oa.get("is_oa") and oa.get("pdf_url"):
            pdf_url = oa["pdf_url"]
        if not pdf_url:
            pmc = paperclients.pmc_pdf_url(doi)
            if pmc.get("ok"):
                pdf_url = pmc.get("pdf_url")

        # Everything network-dependent is in hand — only now do we take the lock.
        meta = {
            "kind": "source_metadata",
            "source": "auto",
            "reviewed": False,
            "doi": doi,
            "title": work.get("title", ""),
            "authors": work.get("authors", []),
            "journal": work.get("journal", ""),
            "published": work.get("published", ""),
            "abstract": work.get("abstract", ""),
            "cited_by": cited_by,
            "pdf_url": pdf_url,
            "fetched": _now_stamp(),
        }

        with store.mutate("research.json", {"topics": [], "entries": []}) as mdata:
            mentry = _find_entry(mdata, eid)
            if not mentry:
                return jsonify({"error": "not found"}), 404
            mentry["meta"] = meta
        return _blob(mdata)

    @app.route("/api/research/entry/meta-review", methods=["POST"])
    def review_research_entry_meta():
        body = request.json or {}
        eid = body.get("id")
        reviewed = bool(body.get("reviewed"))
        with store.mutate("research.json", {"topics": [], "entries": []}) as data:
            entry = _find_entry(data, eid)
            if not entry or not isinstance(entry.get("meta"), dict):
                return jsonify({"error": "not found"}), 404
            entry["meta"]["reviewed"] = reviewed
        return _blob(data)
