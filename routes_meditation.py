"""Meditation routes — stream of dated cells, multi-tagged, optional duration."""
from flask import request, jsonify
import store
import uuid


def _load_log():
    return store.read("meditation_log.json", {"entries": []})


def _save_log(data):
    store.write("meditation_log.json", data)


def _load_deities():
    return store.read("deity_profiles.json", {"profiles": []})


def _save_deities(data):
    store.write("deity_profiles.json", data)


def _coerce_links(value):
    """Accept a list of {title,url,description}; drop empties, keep order."""
    out = []
    if isinstance(value, list):
        for it in value:
            if not isinstance(it, dict):
                continue
            title = str(it.get("title", "")).strip()
            url = str(it.get("url", "")).strip()
            desc = str(it.get("description", "")).strip()
            if not (title or url):
                continue
            link = {"title": title, "url": url, "description": desc}
            lid = str(it.get("id", "")).strip()
            link["id"] = lid or uuid.uuid4().hex[:8]
            out.append(link)
    return out


def _coerce_types(value):
    """Accept either a list of strings, a single string, or None."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(t).strip() for t in value if str(t).strip()]
    s = str(value).strip()
    return [s] if s else []


def register(app):

    @app.route("/api/meditation/add", methods=["POST"])
    def add_meditation_entry():
        body = request.json or {}
        entry = {
            "id": uuid.uuid4().hex[:12],
            "types": _coerce_types(body.get("types") or body.get("type")),
            "date": (body.get("date") or "").strip() or None,
            "duration_min": body.get("duration_min") if body.get("duration_min") not in ("", None) else None,
            "notes": (body.get("notes") or "").strip(),
        }
        data = _load_log()
        data["entries"].append(entry)
        _save_log(data)
        return jsonify({"ok": True, "id": entry["id"]})

    @app.route("/api/meditation/update", methods=["POST"])
    def update_meditation_entry():
        body = request.json or {}
        entry_id = body.get("id")
        if not entry_id:
            return jsonify({"error": "missing id"}), 400
        data = _load_log()
        for e in data["entries"]:
            if e["id"] == entry_id:
                if "types" in body or "type" in body:
                    e["types"] = _coerce_types(body.get("types") or body.get("type"))
                if "date" in body:
                    d = (body.get("date") or "").strip()
                    e["date"] = d or None
                if "duration_min" in body:
                    d = body["duration_min"]
                    e["duration_min"] = d if d not in ("", None) else None
                if "notes" in body:
                    e["notes"] = (body.get("notes") or "").strip()
                break
        _save_log(data)
        return jsonify({"ok": True})

    @app.route("/api/meditation/remove", methods=["POST"])
    def remove_meditation_entry():
        body = request.json or {}
        entry_id = body.get("id")
        data = _load_log()
        data["entries"] = [e for e in data["entries"] if e["id"] != entry_id]
        _save_log(data)
        return jsonify({"ok": True})

    @app.route("/api/meditation/notes/save", methods=["POST"])
    def save_meditation_notes():
        """Kept for backward compatibility; UI no longer uses it."""
        body = request.json or {}
        text = body.get("text", "")
        store.write("meditation_notes.json", {"text": text})
        return jsonify({"ok": True})

    # --- Deity yoga profiles ---

    @app.route("/api/deity/add", methods=["POST"])
    def add_deity_profile():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        profile = {
            "id": uuid.uuid4().hex[:12],
            "name": name,
            "epithet": (body.get("epithet") or "").strip(),
            "mantra": (body.get("mantra") or "").strip(),
            "body": body.get("body") or "",
            "links": _coerce_links(body.get("links")),
        }
        data = _load_deities()
        data["profiles"].append(profile)
        _save_deities(data)
        return jsonify({"ok": True, "id": profile["id"]})

    @app.route("/api/deity/update", methods=["POST"])
    def update_deity_profile():
        body = request.json or {}
        profile_id = body.get("id")
        if not profile_id:
            return jsonify({"error": "missing id"}), 400
        data = _load_deities()
        for p in data["profiles"]:
            if p["id"] == profile_id:
                if "name" in body:
                    name = (body.get("name") or "").strip()
                    if not name:
                        return jsonify({"error": "name cannot be empty"}), 400
                    p["name"] = name
                if "epithet" in body:
                    p["epithet"] = (body.get("epithet") or "").strip()
                if "mantra" in body:
                    p["mantra"] = (body.get("mantra") or "").strip()
                if "body" in body:
                    p["body"] = body.get("body") or ""
                if "links" in body:
                    p["links"] = _coerce_links(body.get("links"))
                break
        else:
            return jsonify({"error": "not found"}), 404
        _save_deities(data)
        return jsonify({"ok": True})

    @app.route("/api/deity/remove", methods=["POST"])
    def remove_deity_profile():
        body = request.json or {}
        profile_id = body.get("id")
        data = _load_deities()
        data["profiles"] = [p for p in data["profiles"] if p["id"] != profile_id]
        _save_deities(data)
        return jsonify({"ok": True})
