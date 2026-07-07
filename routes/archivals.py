"""Archivals routes — the things-you-own catalog (clothes, jewelry, sentimental...).

Ported from the standalone inventory-app (github.com/braedeigh/inventory-app):
items with photos, categories, materials, origin stories, and privacy flags.
Item metadata lives in archivals.json (store layer); photo files live in
store.ARCHIVALS_DIR. Identity is by stable ``id`` (uuid), never by name.

Distinct from the consumables loop in routes/inventory.py (buy list / restock):
archivals is the long-lived catalog — what she owns and where it came from.
"""
import re
import uuid
from datetime import datetime
from pathlib import Path

from flask import request, jsonify, send_from_directory

import store

PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif"}
MAX_PHOTOS = 5

DEFAULT_CATEGORIES = ["clothing", "jewelry", "sentimental", "bedding", "other"]


def _load():
    return store.read("archivals.json", {"items": []})


def _save(data):
    store.write("archivals.json", data)


def _find(data, item_id):
    return next((i for i in data["items"] if i.get("id") == item_id), None)


def _slugify(s):
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:30] or "item"


def _save_photo_file(f, item):
    """Store an uploaded photo in ARCHIVALS_DIR; return its photo record."""
    ext = Path(f.filename).suffix.lower() or ".jpg"
    if ext not in PHOTO_EXTS:
        raise ValueError(f"Unsupported extension: {ext}")
    photo_id = uuid.uuid4().hex[:8]
    fname = f"{_slugify(item['name'])}-{item['id'][:6]}-{photo_id}{ext}"
    store.ARCHIVALS_DIR.mkdir(parents=True, exist_ok=True)
    f.save(str(store.ARCHIVALS_DIR / fname))
    return {"id": photo_id, "filename": fname}


def _delete_photo_file(fname):
    target = store.ARCHIVALS_DIR / fname
    if target.exists():
        target.unlink()


def public_view(items):
    """The public/frosted site never sees private items or private fields."""
    out = []
    for i in items:
        if i.get("private") == "yes":
            continue
        i = dict(i)
        if i.get("private_photos") == "yes":
            i["photos"] = []
        for k in ("private_description", "private_origin"):
            i.pop(k, None)
        out.append(i)
    return out


# Fields settable straight from the request on add/update, all plain strings
# except materials (list of {material, percentage}).
_TEXT_FIELDS = ("description", "category", "subcategory", "origin",
                "secondhand", "gifted", "private",
                "private_photos", "private_description", "private_origin")


def register(app):

    @app.route("/api/archivals")
    def get_archivals():
        return jsonify(_load())

    @app.route("/api/archivals/add", methods=["POST"])
    def add_archival():
        # multipart form so photos can ride along with the fields
        name = (request.form.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Empty name"}), 400
        item = {
            "id": str(uuid.uuid4()),
            "name": name,
            "materials": [],
            "photos": [],
            "created_at": datetime.now().strftime("%Y-%m-%d"),
        }
        for k in _TEXT_FIELDS:
            item[k] = (request.form.get(k) or "").strip()
        materials = request.form.get("materials", "")
        item["materials"] = _parse_materials(materials)

        try:
            for f in request.files.getlist("photos")[:MAX_PHOTOS]:
                if f and f.filename:
                    item["photos"].append(_save_photo_file(f, item))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        data = _load()
        data["items"].append(item)
        _save(data)
        return jsonify({"ok": True, "item": item})

    @app.route("/api/archivals/update", methods=["POST"])
    def update_archival():
        payload = request.json or {}
        item_id = payload.get("id")
        with store.mutate("archivals.json", {"items": []}) as data:
            item = _find(data, item_id)
            if not item:
                return jsonify({"error": "Not found"}), 404
            if "name" in payload:
                new_name = (payload["name"] or "").strip()
                if new_name:
                    item["name"] = new_name
            for k in _TEXT_FIELDS:
                if k in payload:
                    item[k] = (payload[k] or "").strip()
            if "materials" in payload:
                m = payload["materials"]
                item["materials"] = m if isinstance(m, list) else _parse_materials(m)
            item["last_edited"] = datetime.now().strftime("%Y-%m-%d")
        return jsonify({"ok": True})

    @app.route("/api/archivals/remove", methods=["POST"])
    def remove_archival():
        payload = request.json or {}
        item_id = payload.get("id")
        with store.mutate("archivals.json", {"items": []}) as data:
            item = _find(data, item_id)
            if not item:
                return jsonify({"error": "Not found"}), 404
            for p in item.get("photos", []):
                _delete_photo_file(p["filename"])
            data["items"] = [i for i in data["items"] if i.get("id") != item_id]
        return jsonify({"ok": True})

    @app.route("/api/archivals/<item_id>/photos", methods=["POST"])
    def add_archival_photos(item_id):
        data = _load()
        item = _find(data, item_id)
        if not item:
            return jsonify({"error": "Not found"}), 404
        item.setdefault("photos", [])
        room = MAX_PHOTOS - len(item["photos"])
        try:
            for f in request.files.getlist("photos")[:max(room, 0)]:
                if f and f.filename:
                    item["photos"].append(_save_photo_file(f, item))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        item["last_edited"] = datetime.now().strftime("%Y-%m-%d")
        _save(data)
        return jsonify({"ok": True, "photos": item["photos"]})

    @app.route("/api/archivals/<item_id>/photos/remove", methods=["POST"])
    def remove_archival_photo(item_id):
        photo_id = (request.json or {}).get("photo_id")
        with store.mutate("archivals.json", {"items": []}) as data:
            item = _find(data, item_id)
            if not item:
                return jsonify({"error": "Not found"}), 404
            photo = next((p for p in item.get("photos", []) if p["id"] == photo_id), None)
            if not photo:
                return jsonify({"error": "Photo not found"}), 404
            _delete_photo_file(photo["filename"])
            item["photos"] = [p for p in item["photos"] if p["id"] != photo_id]
        return jsonify({"ok": True})

    @app.route("/api/archivals/<item_id>/photos/main", methods=["POST"])
    def set_main_archival_photo(item_id):
        """Move a photo to the front — position 0 is the card thumbnail."""
        photo_id = (request.json or {}).get("photo_id")
        with store.mutate("archivals.json", {"items": []}) as data:
            item = _find(data, item_id)
            if not item:
                return jsonify({"error": "Not found"}), 404
            photos = item.get("photos", [])
            photo = next((p for p in photos if p["id"] == photo_id), None)
            if not photo:
                return jsonify({"error": "Photo not found"}), 404
            item["photos"] = [photo] + [p for p in photos if p["id"] != photo_id]
        return jsonify({"ok": True})

    @app.route("/archivals/photo/<path:filename>")
    def serve_archival_photo(filename):
        # Auth-gated by the before_request gate in server.py (not a PUBLIC_PATH).
        return send_from_directory(str(store.ARCHIVALS_DIR), filename)


def _parse_materials(raw):
    """Accept 'Cotton 80, Polyester 20' or 'Cotton' free text → material list."""
    out = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(.*?)\s+(\d{1,3})\s*%?$", part)
        if m:
            out.append({"material": m.group(1).strip(), "percentage": int(m.group(2))})
        else:
            out.append({"material": part, "percentage": None})
    return out
