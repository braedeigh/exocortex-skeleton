"""Housing-search routes — a place tracker with a status ladder.

A single store (housing.json) holds the list of places plus a free-text
notes box (criteria / move-timing plan). Modeled on routes/car.py.
"""
from flask import request, jsonify
import store
import uuid

# Status ladder, in order. The frontend renders these as a dropdown per place.
STATUSES = ("found", "contacted", "touring", "toured", "applied", "passed", "got_it")

_FIELDS = ("name", "link", "rent", "size", "area", "status", "avail", "notes")


def _load():
    return store.read("housing.json", {"entries": [], "notes": ""})


def _save(data):
    store.write("housing.json", data)


def register(app):

    @app.route("/api/housing/add", methods=["POST"])
    def add_housing_entry():
        body = request.json or {}
        status = (body.get("status") or "").strip()
        entry = {
            "id": uuid.uuid4().hex[:12],
            "name": (body.get("name") or "").strip() or "Untitled place",
            "link": (body.get("link") or "").strip(),
            "rent": (body.get("rent") or "").strip(),
            "size": (body.get("size") or "").strip(),
            "area": (body.get("area") or "").strip(),
            "status": status if status in STATUSES else "found",
            "avail": (body.get("avail") or "").strip(),
            "notes": (body.get("notes") or "").strip(),
        }
        data = _load()
        data.setdefault("entries", []).append(entry)
        _save(data)
        return jsonify({"ok": True, "id": entry["id"]})

    @app.route("/api/housing/update", methods=["POST"])
    def update_housing_entry():
        body = request.json or {}
        entry_id = body.get("id")
        if not entry_id:
            return jsonify({"error": "missing id"}), 400
        data = _load()
        for e in data.get("entries", []):
            if e["id"] == entry_id:
                for field in _FIELDS:
                    if field in body:
                        val = body[field]
                        val = val.strip() if isinstance(val, str) else val
                        if field == "status" and val not in STATUSES:
                            continue
                        e[field] = val
                break
        else:
            return jsonify({"error": "not found"}), 404
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/housing/remove", methods=["POST"])
    def remove_housing_entry():
        body = request.json or {}
        entry_id = body.get("id")
        data = _load()
        data["entries"] = [e for e in data.get("entries", []) if e["id"] != entry_id]
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/housing/notes/save", methods=["POST"])
    def save_housing_notes():
        body = request.json or {}
        data = _load()
        data["notes"] = body.get("text", "")
        _save(data)
        return jsonify({"ok": True})
