"""Places — a small reusable store of saved locations (name + address).

To-dos point at a place via `place_id` rather than retyping the address, so
errands at the same place can be grouped/batched ("you're going to Avita anyway").
Modeled on the inventory CRUD pattern; all writes go through the locked store.
"""
from flask import request, jsonify
import store
import uuid


def _places(d):
    return d.setdefault("places", [])


def register(app):

    @app.route("/api/places/add", methods=["POST"])
    def add_place():
        data = request.json or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Empty name"}), 400
        new_id = uuid.uuid4().hex[:8]
        dup = False
        with store.mutate("places", {"places": []}) as d:
            places = _places(d)
            if any(p.get("name", "").lower() == name.lower() for p in places):
                dup = True
            else:
                places.append({
                    "id": new_id,
                    "name": name,
                    "address": (data.get("address") or "").strip(),
                    "category": (data.get("category") or "").strip(),
                    "notes": (data.get("notes") or "").strip(),
                })
        if dup:
            return jsonify({"error": "A place with that name already exists"}), 400
        return jsonify({"ok": True, "id": new_id})

    @app.route("/api/places/update", methods=["POST"])
    def update_place():
        data = request.json or {}
        pid = data.get("id", "")
        with store.mutate("places", {"places": []}) as d:
            for p in _places(d):
                if p.get("id") == pid:
                    for f in ("name", "address", "category", "notes"):
                        if f in data:
                            p[f] = (data.get(f) or "").strip()
                    return jsonify({"ok": True})
        return jsonify({"error": "Not found"}), 404

    @app.route("/api/places/remove", methods=["POST"])
    def remove_place():
        data = request.json or {}
        pid = data.get("id", "")
        with store.mutate("places", {"places": []}) as d:
            d["places"] = [p for p in _places(d) if p.get("id") != pid]
        return jsonify({"ok": True})
