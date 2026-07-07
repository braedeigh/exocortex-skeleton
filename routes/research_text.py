"""Document-text acquisition for the annotation layer — fetches a research
`source` entry's full text (or best-effort page text) so it can be resolved
by `docstore.py` as `entry:<id>` and annotated.

Three strategies, first hit wins, ALL network before any write (house rule —
never hold `store`'s lock across a network call, and don't half-succeed):

  a. a PMC id already sitting in the entry's url (`paperclients.extract_pmcid`)
     -> `paperclients.fetch_pmc_fulltext` (papers: full text, clean)
  b. `entry["meta"]["doi"]` (written by routes/research_sources.py's annotate)
     -> `paperclients.lookup_pmcid` -> `paperclients.fetch_pmc_fulltext`
  c. `paperclients.fetch_page_text(entry["url"])` (docs pages, blogs — most
     of the corpus that isn't a paper)

If every strategy misses, the route returns 502 with the last error code,
remapping `"not_html"` (fetch_page_text's signal that the url wasn't a page —
almost always a PDF) to the more legible `"pdf_extraction_unavailable"`.
`# TODO(2): once paperclients gets a pypdf/pdftotext layer, this path
disappears — PDF urls will just work.`

    POST /api/research/entry/fetch-text {"id"} ->
      {"ok": True, "doc": "entry:<id>", "chars": int, "strategy": "pmc"|"page"}
    GET /api/research/texts -> {"ok": True, "docs": ["entry:<id>", ...]}
      (which source entries already have fetched text, so the UI can label
      fetch buttons without N requests)
"""
from flask import request, jsonify

import store
import docstore
import paperclients


def _find_entry(data, eid):
    return next((e for e in data.get("entries", []) if e.get("id") == eid), None)


def _fetch_entry_text(entry):
    """Try each strategy in turn. Returns (text, strategy, None) on success,
    or (None, None, error_code) when every strategy misses. No I/O beyond the
    network clients in paperclients — never writes anything."""
    url = (entry.get("url") or "").strip()
    doi = (entry.get("meta") or {}).get("doi")
    last_error = None

    pmcid = paperclients.extract_pmcid(url) if url else None
    if pmcid:
        r = paperclients.fetch_pmc_fulltext(pmcid)
        if r.get("ok"):
            return r["text"], "pmc", None
        last_error = r.get("error")

    if doi:
        looked_up = paperclients.lookup_pmcid(doi)
        if looked_up.get("ok"):
            r = paperclients.fetch_pmc_fulltext(looked_up["pmcid"])
            if r.get("ok"):
                return r["text"], "pmc", None
            last_error = r.get("error")
        else:
            last_error = looked_up.get("error")

    if url:
        r = paperclients.fetch_page_text(url)
        if r.get("ok"):
            return r["text"], "page", None
        last_error = r.get("error")

    if last_error == "not_html":
        last_error = "pdf_extraction_unavailable"
    return None, None, last_error or "pdf_extraction_unavailable"


def register(app):

    @app.route("/api/research/entry/fetch-text", methods=["POST"])
    def fetch_research_entry_text():
        body = request.json or {}
        eid = body.get("id")

        data = store.read("research.json", {"topics": [], "entries": []})
        entry = _find_entry(data, eid)
        if not entry:
            return jsonify({"error": "not found"}), 404
        if entry.get("kind") != "source":
            return jsonify({"error": "not a source"}), 400

        url = (entry.get("url") or "").strip()
        doi = (entry.get("meta") or {}).get("doi")
        if not url and not doi:
            return jsonify({"error": "no url"}), 422

        text, strategy, error = _fetch_entry_text(entry)
        if text is None:
            return jsonify({"error": error}), 502

        # Only now, with the text already in hand, do we touch disk.
        docstore.save_entry_text(eid, text)
        return jsonify({
            "ok": True,
            "doc": f"entry:{eid}",
            "chars": len(text),
            "strategy": strategy,
        })

    @app.route("/api/research/texts")
    def research_texts():
        data = store.read("research.json", {"topics": [], "entries": []})
        docs = [
            f"entry:{e['id']}" for e in data.get("entries", [])
            if e.get("kind") == "source" and docstore.has_text(f"entry:{e['id']}")
        ]
        return jsonify({"ok": True, "docs": docs})
