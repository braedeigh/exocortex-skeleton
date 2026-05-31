"""Media routes — a backlog of books/movies/shows recommended to her."""
from flask import request, jsonify
import store
import uuid


VALID_TYPES = ("book", "movie", "show", "podcast", "article", "game", "other")


def _load():
    return store.read("media.json", {"items": []})


def _save(data):
    store.write("media.json", data)


def _coerce_type(value):
    s = str(value or "").strip().lower()
    return s if s in VALID_TYPES else "book"


def register(app):

    @app.route("/api/media/add", methods=["POST"])
    def add_media_item():
        body = request.json or {}
        title = (body.get("title") or "").strip()
        if not title:
            return jsonify({"error": "missing title"}), 400
        item = {
            "id": uuid.uuid4().hex[:12],
            "title": title,
            "type": _coerce_type(body.get("type")),
            "recommended_by": (body.get("recommended_by") or "").strip(),
            "notes": (body.get("notes") or "").strip(),
            "date": (body.get("date") or "").strip() or None,
            "done": bool(body.get("done")),
        }
        data = _load()
        data["items"].append(item)
        _save(data)
        return jsonify({"ok": True, "id": item["id"]})

    @app.route("/api/media/update", methods=["POST"])
    def update_media_item():
        body = request.json or {}
        item_id = body.get("id")
        if not item_id:
            return jsonify({"error": "missing id"}), 400
        data = _load()
        for it in data["items"]:
            if it["id"] == item_id:
                if "title" in body:
                    title = (body.get("title") or "").strip()
                    if not title:
                        return jsonify({"error": "title cannot be empty"}), 400
                    it["title"] = title
                if "type" in body:
                    it["type"] = _coerce_type(body.get("type"))
                if "recommended_by" in body:
                    it["recommended_by"] = (body.get("recommended_by") or "").strip()
                if "notes" in body:
                    it["notes"] = (body.get("notes") or "").strip()
                if "date" in body:
                    it["date"] = (body.get("date") or "").strip() or None
                if "done" in body:
                    it["done"] = bool(body.get("done"))
                break
        else:
            return jsonify({"error": "not found"}), 404
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/media/remove", methods=["POST"])
    def remove_media_item():
        body = request.json or {}
        item_id = body.get("id")
        data = _load()
        data["items"] = [it for it in data["items"] if it["id"] != item_id]
        _save(data)
        return jsonify({"ok": True})
