"""Verifiable exposure's HTTP door — a food's contaminants, one contaminant, the ledger.

What this file does: it serves the exposure card on each food page and the
contaminant pages (frontend/src/features/exposure/), and takes the owner's
review of a contaminant fact. Reads go through exposurestore.py; a re-score
over chosen years runs exposure.py. ValueErrors become 400s.

    GET  /api/exposure/food?name=           -> the food's scores, latest-year working, study numbers
    POST /api/exposure/food/score           {name, years: [2017, 2018], claim} -> one score, computed now
    GET  /api/exposure/scores/<id>          -> one score with its working
    GET  /api/exposure/contaminants         -> every contaminant with facts or findings
    GET  /api/exposure/contaminants/<id>    -> what it is, its facts, where it was found
    POST /api/exposure/facts/<id>/review    {review: unreviewed|confirmed|disputed}
    GET  /api/exposure/ledger               -> every pull of public data
    GET  /api/exposure/sources/<id>/pdf-info -> {pdf: bool, pages, passages: {annotation id: page}}
    GET  /api/exposure/sources/<id>/pdf      -> the source's PDF from the commons, as published

The method's constants ride along with each food so the page can say exactly
what was assumed. No feature gate: like the research tables these are her own
reads, and server.py's auth gate closes them to visitors. Design:
docs/exposure.md.

Prompt that produced this file: "i want any possible contaminant to be listed
with potential values next to any of them, and be able to click into those
contaminants to learn more about them and see how harmful they might be."
"""
from pathlib import Path

from flask import jsonify, request, send_file

import commons
import exposure
import exposurestore
import hazardstore
import sqlstore


def _method():
    """What the page needs to say how a score was made."""
    return {
        "name": exposure.METHOD, "body_kg": exposure.BODY_KG,
        "serving_share": exposure.SERVING_SHARE, "bands": exposure.VERDICT_BANDS,
        "organic_tolerance_share": exposure.ORGANIC_TOLERANCE_SHARE,
        "verdicts": hazardstore.VERDICTS, "facts": exposurestore.FACTS,
    }


def _refused(exc):
    return jsonify({"error": str(exc)}), 400


def _not_found():
    return jsonify({"error": "not found"}), 404


def register(app):

    @app.route("/api/exposure/food")
    def exposure_food():
        found = exposurestore.food_exposure(request.args.get("name") or "")
        if found is None:
            return jsonify({"food": None, "method": _method()})
        return jsonify({"food": found, "method": _method()})

    @app.route("/api/exposure/food/score", methods=["POST"])
    def exposure_food_score():
        body = request.json or {}
        try:
            codes_by_food = exposurestore.pdp_codes(body.get("name") or "")
            if not codes_by_food:
                raise ValueError("this food has no USDA PDP code yet")
            (food_id, codes), = codes_by_food.items()
            years = sorted({int(year) for year in body.get("years") or []})
            if not years:
                raise ValueError("choose at least one year")
            result = exposure.score(food_id, codes, years, body.get("claim") or "conventional")
        except (ValueError, TypeError) as exc:
            return _refused(exc)
        if result is None:
            return _refused(ValueError("no samples for those years"))
        return jsonify({"score": result})

    @app.route("/api/exposure/scores/<int:score_id>")
    def exposure_score(score_id):
        detail = exposurestore.score_detail(score_id)
        return jsonify({"score": detail}) if detail else _not_found()

    @app.route("/api/exposure/contaminants")
    def exposure_contaminants():
        return jsonify({"contaminants": exposurestore.contaminant_index()})

    @app.route("/api/exposure/contaminants/<int:hazard_id>")
    def exposure_contaminant(hazard_id):
        found = exposurestore.contaminant(hazard_id)
        if found is None:
            return _not_found()
        return jsonify({"contaminant": found, "method": _method()})

    @app.route("/api/exposure/facts/<int:fact_id>/review", methods=["POST"])
    def exposure_fact_review(fact_id):
        try:
            exposurestore.review_fact(fact_id, (request.json or {}).get("review"))
        except ValueError as exc:
            return _refused(exc)
        return jsonify({"ok": True})

    @app.route("/api/exposure/ledger")
    def exposure_ledger():
        return jsonify({"pulls": exposurestore.ledger(request.args.get("dataset") or None)})

    # --- a source's own PDF, for showing a passage where it really is ---------

    def _pdf_path(source_id):
        """The source's PDF on disk, or None. Refuses any stored path that
        would lead outside the commons folder."""
        found = exposurestore.source_file(source_id)
        if not found:
            return None
        root = Path(commons.commons_dir()).resolve()
        path = (root / found["commons_path"]).resolve()
        if root not in path.parents or not path.is_file():
            return None
        return path

    @app.route("/api/exposure/sources/<source_id>/pdf-info")
    def exposure_source_pdf_info(source_id):
        found = exposurestore.source_file(source_id)
        if not found or _pdf_path(source_id) is None:
            return jsonify({"pdf": False})
        conn = sqlstore.open_db()
        try:
            passages = dict(conn.execute(
                "SELECT p.annotation_id, p.page FROM passage_pages p"
                " JOIN research_annotations a ON a.id = p.annotation_id WHERE a.doc = ?",
                (f"entry:{source_id}",)).fetchall())
        finally:
            conn.close()
        return jsonify({"pdf": True, "pages": found["pages"], "sha256": found["sha256"],
                        "passages": passages})

    @app.route("/api/exposure/sources/<source_id>/pdf")
    def exposure_source_pdf(source_id):
        path = _pdf_path(source_id)
        if path is None:
            return _not_found()
        return send_file(path, mimetype="application/pdf", max_age=86400)
