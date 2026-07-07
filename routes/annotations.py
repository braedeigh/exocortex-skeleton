"""Annotations — generic, doc-scoped CRUD over the TextSelector design.

Ports labrador's annotation model (she authored it), made generic over any
"doc id" instead of tying to research entries: `entry:<id>` (extracted source
text) or `note:<filename>` (research markdown) today; `journal:<...>` later
for Cricket sessions annotating journals. `docstore.py` is the one seam that
knows what a doc id means — this module never interprets one itself.

    annotations.json = {"annotations": [
        {"id", "doc", "content": {...free-form map, conventionally carries
          "kind" and "source": "llm"|"human"...}, "needs_review": bool,
         "selector": {"exact", "char_start", "char_end"}, "created"}
    ]}

Ids are time-based (`ann-YYYY-MM-DD.HHMM`, `-2` suffix on same-minute
collision) — the `ann-` prefix keeps them out of the entry-id namespace.

Convention (labrador's, preserved): machine-produced content is born
`needs_review = True`; a human annotating IS the review, so human-authored
annotations start `needs_review = False`. A future PATCH is the review
sign-off toggle (mirrors research_sources.py's meta-review route).

Selector resolution (verified/relocated/lost) is NEVER persisted — it's a
view recomputed from the live doc text on every GET, same as any other
derived data in this app; only the original `selector` an annotation was
created with is stored.

All mutations go through `store.mutate`; no network in this module. Errors
are values: routes return `{"ok": False, ...}`-shaped 4xx/5xx bodies, nothing
raises across the module boundary.
"""
from datetime import datetime

from flask import request, jsonify

import store
import docstore
import textanchor


def _now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _new_id(annotations):
    base = "ann-" + datetime.now().strftime("%Y-%m-%d.%H%M")
    taken = {a.get("id") for a in annotations}
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


def _doc_error_response(resolved):
    """Map a failed docstore.resolve() result to a (body, status) pair."""
    err = resolved.get("error")
    if err == "not_found":
        return jsonify({"error": "not found"}), 404
    return jsonify({"error": err}), 400


def _doc_response(doc, annotations):
    """Build the doc-scoped {"ok", "doc", "annotations": [...]} view: each
    annotation's selector is resolved (verified/relocated/lost) against the
    live doc text, never persisted. When the doc text itself is unavailable,
    the raw annotations come back as-is with state "unresolved"."""
    matching = [a for a in annotations if a.get("doc") == doc]
    resolved = docstore.resolve(doc)
    out = []
    if resolved.get("ok"):
        text = resolved.get("text", "")
        for a in matching:
            r = textanchor.resolve(text, a.get("selector"))
            out.append({**a, "state": r["state"], "selector": r["selector"]})
    else:
        for a in matching:
            out.append({**a, "state": "unresolved"})
    return {"ok": True, "doc": doc, "annotations": out}


def register(app):

    @app.route("/api/annotations")
    def list_annotations():
        doc = request.args.get("doc", "")
        data = store.read("annotations.json", {"annotations": []})
        return jsonify(_doc_response(doc, data.get("annotations", [])))

    @app.route("/api/annotations/doc-text")
    def annotation_doc_text():
        """Passthrough to docstore.resolve — labrador's GET raw-text route."""
        doc = request.args.get("doc", "")
        resolved = docstore.resolve(doc)
        if not resolved.get("ok"):
            return _doc_error_response(resolved)
        return jsonify({"ok": True, "doc": doc,
                        "title": resolved.get("title", ""),
                        "text": resolved.get("text", "")})

    @app.route("/api/annotations/add", methods=["POST"])
    def add_annotation():
        body = request.json or {}
        doc = body.get("doc")
        resolved = docstore.resolve(doc)
        if not resolved.get("ok"):
            return _doc_error_response(resolved)
        sel = textanchor.make_selector(
            resolved.get("text", ""), body.get("char_start"), body.get("char_end"))
        if sel is None:
            return jsonify({"error": "bad range"}), 400
        content = body.get("content")
        if not isinstance(content, dict):
            content = {}
        source = content.get("source") or "human"
        if "needs_review" in body:
            needs_review = bool(body["needs_review"])
        else:
            needs_review = source != "human"
        with store.mutate("annotations.json", {"annotations": []}) as data:
            anns = data.setdefault("annotations", [])
            anns.append({
                "id": _new_id(anns),
                "doc": doc,
                "content": content,
                "needs_review": needs_review,
                "selector": sel,
                "created": _now_stamp(),
            })
        return jsonify(_doc_response(doc, data["annotations"]))

    @app.route("/api/annotations/edit", methods=["POST"])
    def edit_annotation():
        body = request.json or {}
        aid = body.get("id")
        with store.mutate("annotations.json", {"annotations": []}) as data:
            anns = data.setdefault("annotations", [])
            ann = next((a for a in anns if a.get("id") == aid), None)
            if not ann:
                return jsonify({"error": "not found"}), 404
            if "content" in body:
                content = body.get("content")
                ann["content"] = content if isinstance(content, dict) else {}
            if "needs_review" in body:
                ann["needs_review"] = bool(body["needs_review"])
            doc = ann["doc"]
        return jsonify(_doc_response(doc, data["annotations"]))

    @app.route("/api/annotations/remove", methods=["POST"])
    def remove_annotation():
        body = request.json or {}
        aid = body.get("id")
        with store.mutate("annotations.json", {"annotations": []}) as data:
            anns = data.setdefault("annotations", [])
            ann = next((a for a in anns if a.get("id") == aid), None)
            if not ann:
                return jsonify({"error": "not found"}), 404
            doc = ann["doc"]
            data["annotations"] = [a for a in anns if a.get("id") != aid]
        return jsonify(_doc_response(doc, data["annotations"]))
