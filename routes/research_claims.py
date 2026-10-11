"""The claims table's HTTP door — every claim beside the sources that back it.

What this file does: it serves the claims view the research page's Claims tab
codes against (frontend/src/features/research/api.ts, the ClaimsListResponse /
ClaimDetailResponse / SourceClaimsResponse shapes in types.ts), and it takes the
owner's three writes — link a source to a claim (optionally pinning the exact
passage), unlink one, and set the number a claim asserts.

    GET  /api/research/claims?topic=&front=      -> {"claims": [...]}
    GET  /api/research/claims/<id>               -> {"claim", "sources", "value"}
    GET  /api/research/sources/<id>/claims       -> {"source": {id,text,url}, "claims"}
    POST /api/research/claims/link               {claim_id, source_id, stance?, note?,
                                                  passage? | annotation_id?}
    POST /api/research/claims/unlink             {claim_id, source_id}
    POST /api/research/claims/value              {claim_id, subject, measure, amount,
                                                  unit, basis, year, tier}

A "claim" here is any research entry with kind == "claim" — the owner's own as
much as one an agent wrote — so the list is the whole pool's claims, not only
the agents'. Every read and write goes through researchstore.py's typed
helpers (list_claims, claim_detail, claims_for_source, link_claim_source,
unlink_claim_source, add_annotation, set_claim_value); this module never opens
a table itself. docstore.py answers whether a source has extracted text to
read, and textanchor.py checks a passage's offsets against that text.

No feature gate: these are owner-facing reads and writes over her own pool,
not worker spawns, so they answer whenever the app does. The auth gate in
server.py still closes them to visitors.

Errors are values, in routes/annotations.py's style: 404 when the id is not a
claim or source, 400 with a plain message when the input is wrong.

The agents' write door for the same tables is scripts/research_claims.py.

Prompt that produced this file: "routes/research_claims.py with register(app):
GET /api/research/claims?topic=&front= from list_claims (owner-authored claims
included); GET /api/research/claims/<id> -> {claim, sources, value} with
doc: entry:<source id> and has_text on each source, 404 if not a claim;
GET /api/research/sources/<id>/claims -> {source: {id, text, url}, claims};
POST link {claim_id, source_id, stance?, note?, passage? | annotation_id?} —
a passage creates the annotation via add_annotation(source='human',
needs_review=False) on doc defaulting to entry:<source_id>, then links;
returns claim_detail; 400 on bad stance / unknown ids; POST unlink; POST value
-> set_claim_value, returns claim_detail. No feature gate."
"""
from flask import request, jsonify

import docstore
import researchstore
import store
import textanchor

RESEARCH_DEFAULT = {"topics": [], "entries": [], "sessions": []}


def _find_entry(entry_id):
    """One research entry by id, or None. Reads the document rather than a
    table so this module stays on the public store surface."""
    if not entry_id:
        return None
    data = store.read("research.json", dict(RESEARCH_DEFAULT))
    return next((e for e in data.get("entries", []) if e.get("id") == entry_id), None)


def _present_claim(claim):
    """A claim summary as the page expects it: an entry with no author is the
    owner's, which the contract spells as "owner" rather than null."""
    if claim.get("author") is None:
        claim["author"] = "owner"
    return claim


def _detail_response(claim_id):
    """A claim's detail with each source told whether its text can be opened.
    None when the id is not a claim — callers turn that into a 404."""
    detail = researchstore.claim_detail(claim_id)
    if detail is None:
        return None
    _present_claim(detail["claim"])
    for source in detail["sources"]:
        source["has_text"] = docstore.has_text(source["doc"])
    return detail


def _passage_annotation(passage, source_id):
    """Pin the passage behind a link as an owner annotation, returning
    (annotation_id, error). The doc defaults to the source's own text; the
    offsets are checked against that text so a link can never point at a
    range the doc does not have. The owner choosing the passage is the
    review, so the annotation is born reviewed (source 'owner')."""
    if not isinstance(passage, dict):
        return None, "bad passage"
    doc = (passage.get("doc") or "").strip() or f"entry:{source_id}"
    resolved = docstore.resolve(doc)
    if not resolved.get("ok"):
        return None, f"no text for {doc}"
    selector = textanchor.make_selector(
        resolved.get("text", ""), passage.get("char_start"), passage.get("char_end"))
    if selector is None:
        return None, "bad range"
    exact = (passage.get("exact") or "").strip() or selector["exact"]
    annotation_id = researchstore.add_annotation(
        doc, selector["char_start"], selector["char_end"], exact,
        note=passage.get("note") or "", source="human", needs_review=False)
    return annotation_id, None


def _number_or_none(value, cast):
    """A value field as its number, None when blank, or raise ValueError."""
    if value is None or value == "":
        return None
    return cast(value)


def register(app):

    @app.route("/api/research/claims")
    def list_research_claims():
        # A blank query value means "no filter", so ?topic= is the same as
        # no topic at all — the page sends empty params when nothing is chosen.
        topic = request.args.get("topic") or None
        front = request.args.get("front") or None
        claims = [_present_claim(c) for c in researchstore.list_claims(topic=topic, front=front)]
        return jsonify({"claims": claims})

    @app.route("/api/research/claims/<claim_id>")
    def research_claim_detail(claim_id):
        detail = _detail_response(claim_id)
        if detail is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(detail)

    @app.route("/api/research/sources/<source_id>/claims")
    def research_source_claims(source_id):
        entry = _find_entry(source_id)
        if entry is None:
            return jsonify({"error": "not found"}), 404
        claims = [_present_claim(c) for c in researchstore.claims_for_source(source_id)]
        return jsonify({
            "source": {"id": entry["id"], "text": entry.get("text") or "",
                       "url": entry.get("url") or ""},
            "claims": claims,
        })

    @app.route("/api/research/claims/link", methods=["POST"])
    def link_research_claim():
        body = request.json or {}
        claim_id = body.get("claim_id")
        source_id = body.get("source_id")
        stance = body.get("stance") or "supports"
        # Check everything before writing anything: a passage creates an
        # annotation, and one left behind by a link that then failed would
        # be an orphan nothing shows.
        if stance not in researchstore.STANCES:
            return jsonify({"error": f"bad stance; one of {', '.join(researchstore.STANCES)}"}), 400
        claim = _find_entry(claim_id)
        if claim is None or claim.get("kind") != "claim":
            return jsonify({"error": "unknown claim"}), 400
        if _find_entry(source_id) is None:
            return jsonify({"error": "unknown source"}), 400
        annotation_id = body.get("annotation_id")
        if body.get("passage") is not None:
            annotation_id, error = _passage_annotation(body["passage"], source_id)
            if error:
                return jsonify({"error": error}), 400
        try:
            researchstore.link_claim_source(
                claim_id, source_id, stance=stance,
                annotation_id=annotation_id, note=body.get("note") or "")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(_detail_response(claim_id))

    @app.route("/api/research/claims/unlink", methods=["POST"])
    def unlink_research_claim():
        body = request.json or {}
        claim_id = body.get("claim_id")
        detail = _detail_response(claim_id)
        if detail is None:
            return jsonify({"error": "not found"}), 404
        removed = researchstore.unlink_claim_source(claim_id, body.get("source_id"))
        if not removed:
            return jsonify({"error": "no such link"}), 404
        return jsonify(_detail_response(claim_id))

    @app.route("/api/research/claims/value", methods=["POST"])
    def set_research_claim_value():
        body = request.json or {}
        claim_id = body.get("claim_id")
        if _detail_response(claim_id) is None:
            return jsonify({"error": "not found"}), 404
        # Only the fields the body carries change; amount and year are
        # numbers (or cleared with null/blank), the rest are text.
        fields = {}
        try:
            for key in ("subject", "measure", "unit", "basis", "tier"):
                if key in body:
                    fields[key] = None if body[key] is None else str(body[key]).strip()
            if "amount" in body:
                fields["amount"] = _number_or_none(body["amount"], float)
            if "year" in body:
                fields["year"] = _number_or_none(body["year"], int)
        except (TypeError, ValueError):
            return jsonify({"error": "amount must be a number and year a whole number"}), 400
        if not fields:
            return jsonify({"error": "nothing to set"}), 400
        researchstore.set_claim_value(claim_id, **fields)
        return jsonify(_detail_response(claim_id))
