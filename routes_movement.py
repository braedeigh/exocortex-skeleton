"""Movement routes — routines (named sequences) of moves, each with a demo video.

Shape mirrors media.json: a single JSON file, fully editable through the UI so
no terminal/LLM is needed to add a stretch or paste a video link.

    {"routines": [
        {"id", "name", "note", "moves": [
            {"id", "name", "url", "note"}
        ]}
    ]}
"""
from flask import request, jsonify
import store
import uuid


def _load():
    return store.read("movement.json", {"routines": []})


def _save(data):
    store.write("movement.json", data)


def _find_routine(data, routine_id):
    return next((r for r in data["routines"] if r["id"] == routine_id), None)


def _new_id():
    return uuid.uuid4().hex[:12]


def register(app):

    # --- Routines ---

    @app.route("/api/movement/routine/add", methods=["POST"])
    def add_movement_routine():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        routine = {
            "id": _new_id(),
            "name": name,
            "note": (body.get("note") or "").strip(),
            "moves": [],
        }
        data = _load()
        data["routines"].append(routine)
        _save(data)
        return jsonify({"ok": True, "id": routine["id"]})

    @app.route("/api/movement/routine/update", methods=["POST"])
    def update_movement_routine():
        body = request.json or {}
        rid = body.get("id")
        data = _load()
        r = _find_routine(data, rid)
        if not r:
            return jsonify({"error": "not found"}), 404
        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name:
                return jsonify({"error": "name cannot be empty"}), 400
            r["name"] = name
        if "note" in body:
            r["note"] = (body.get("note") or "").strip()
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/movement/routine/remove", methods=["POST"])
    def remove_movement_routine():
        body = request.json or {}
        rid = body.get("id")
        data = _load()
        data["routines"] = [r for r in data["routines"] if r["id"] != rid]
        _save(data)
        return jsonify({"ok": True})

    # --- Moves (within a routine) ---

    @app.route("/api/movement/move/add", methods=["POST"])
    def add_movement_move():
        body = request.json or {}
        rid = body.get("routine_id")
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        data = _load()
        r = _find_routine(data, rid)
        if not r:
            return jsonify({"error": "routine not found"}), 404
        move = {
            "id": _new_id(),
            "name": name,
            "url": (body.get("url") or "").strip(),
            "note": (body.get("note") or "").strip(),
        }
        r.setdefault("moves", []).append(move)
        _save(data)
        return jsonify({"ok": True, "id": move["id"]})

    @app.route("/api/movement/move/update", methods=["POST"])
    def update_movement_move():
        body = request.json or {}
        rid = body.get("routine_id")
        mid = body.get("id")
        data = _load()
        r = _find_routine(data, rid)
        if not r:
            return jsonify({"error": "routine not found"}), 404
        move = next((m for m in r.get("moves", []) if m["id"] == mid), None)
        if not move:
            return jsonify({"error": "move not found"}), 404
        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name:
                return jsonify({"error": "name cannot be empty"}), 400
            move["name"] = name
        if "url" in body:
            move["url"] = (body.get("url") or "").strip()
        if "note" in body:
            move["note"] = (body.get("note") or "").strip()
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/movement/move/remove", methods=["POST"])
    def remove_movement_move():
        body = request.json or {}
        rid = body.get("routine_id")
        mid = body.get("id")
        data = _load()
        r = _find_routine(data, rid)
        if not r:
            return jsonify({"error": "routine not found"}), 404
        r["moves"] = [m for m in r.get("moves", []) if m["id"] != mid]
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/movement/move/reorder", methods=["POST"])
    def reorder_movement_moves():
        body = request.json or {}
        rid = body.get("routine_id")
        order = body.get("order") or []
        data = _load()
        r = _find_routine(data, rid)
        if not r:
            return jsonify({"error": "routine not found"}), 404
        by_id = {m["id"]: m for m in r.get("moves", [])}
        reordered = [by_id.pop(mid) for mid in order if mid in by_id]
        reordered.extend(by_id.values())  # any not named keep their place at the end
        r["moves"] = reordered
        _save(data)
        return jsonify({"ok": True})
