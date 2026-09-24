"""Document-text acquisition for the annotation layer — fetches a research
`source` entry's full text (or best-effort page text) so it can be resolved
by `docstore.py` as `entry:<id>` and annotated.

Four strategies, first hit wins, ALL network before any write (house rule —
never hold `store`'s lock across a network call, and don't half-succeed):

  a. a PMC id already sitting in the entry's url (`paperclients.extract_pmcid`)
     -> `paperclients.fetch_pmc_fulltext` (papers: full text, clean)
  b. `entry["meta"]["doi"]` (written by routes/research_sources.py's annotate)
     -> `paperclients.lookup_pmcid` -> `paperclients.fetch_pmc_fulltext`
  c. `entry["meta"]["pdf_url"]` (Unpaywall's open-access PDF, or the PMC render
     link — also written by annotate) -> `paperclients.fetch_pdf_text`
  d. `paperclients.fetch_url_text(entry["url"])` — the url itself, whatever it
     is: a PDF goes through pdftotext, a docs page or blog through the HTML
     extractor (most of the corpus that isn't a paper)

If every strategy misses, the route returns 502 with the last error code as
paperclients reported it — for PDFs that means `pdftotext_missing`,
`pdf_too_large`, `pdf_extract_failed` or `pdf_no_text`, each of which names
the actual problem.

    POST /api/research/entry/fetch-text {"id"} ->
      {"ok": True, "doc": "entry:<id>", "chars": int, "strategy": "pmc"|"pdf"|"page"}
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
    meta = entry.get("meta") or {}
    doi = meta.get("doi")
    pdf_url = (meta.get("pdf_url") or "").strip()
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

    # The annotator's PDF link, tried before the entry's own url. Skipped when
    # it IS the entry's url — the url strategy below sniffs PDFs itself, and
    # fetching the same file twice would be rude to the host.
    if pdf_url and pdf_url != url:
        text, error = paperclients.fetch_pdf_text(pdf_url)
        if text is not None:
            return text, "pdf", None
        last_error = error

    if url:
        r = paperclients.fetch_url_text(url)
        if r.get("ok"):
            return r["text"], "pdf" if r.get("kind") == "pdf" else "page", None
        last_error = r.get("error")

    return None, None, last_error or "not_found"


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
