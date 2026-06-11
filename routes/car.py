"""Car maintenance routes — extensible log with due-soon surfacing."""
from flask import request, jsonify
import store
import uuid


def _load():
    return store.read("car_maintenance.json", {"entries": []})


def _save(data):
    store.write("car_maintenance.json", data)


def register(app):

    @app.route("/api/car/add", methods=["POST"])
    def add_car_entry():
        body = request.json or {}
        entry = {
            "id": uuid.uuid4().hex[:12],
            "type": (body.get("type") or "").strip() or "other",
            "date": (body.get("date") or "").strip() or None,
            "mileage": body.get("mileage") if body.get("mileage") not in ("", None) else None,
            "notes": (body.get("notes") or "").strip(),
            "next_due": (body.get("next_due") or "").strip() or None,
        }
        data = _load()
        data["entries"].append(entry)
        _save(data)
        return jsonify({"ok": True, "id": entry["id"]})

    @app.route("/api/car/update", methods=["POST"])
    def update_car_entry():
        body = request.json or {}
        entry_id = body.get("id")
        if not entry_id:
            return jsonify({"error": "missing id"}), 400
        data = _load()
        for e in data["entries"]:
            if e["id"] == entry_id:
                for field in ("type", "date", "notes", "next_due"):
                    if field in body:
                        val = body[field]
                        e[field] = val.strip() if isinstance(val, str) else val
                        if field in ("date", "next_due") and e[field] == "":
                            e[field] = None
                if "mileage" in body:
                    m = body["mileage"]
                    e["mileage"] = m if m not in ("", None) else None
                break
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/car/remove", methods=["POST"])
    def remove_car_entry():
        body = request.json or {}
        entry_id = body.get("id")
        data = _load()
        data["entries"] = [e for e in data["entries"] if e["id"] != entry_id]
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/car/notes/save", methods=["POST"])
    def save_car_notes():
        body = request.json or {}
        text = body.get("text", "")
        store.write("car_notes.json", {"text": text})
        return jsonify({"ok": True})
