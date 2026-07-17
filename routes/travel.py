"""Travel routes — trips with packing lists that reference real inventory.

A trip's packing list entries can point at an archival item (the
things-you-own catalog, routes/archivals.py) or an active-inventory
consumable (routes/inventory.py), or be plain free text ("toothbrush").
Each entry carries two independent marks: ``packed`` (checked while filling
the bag) and ``returned`` (the unpack reckoning — home / left / lost).
Referencing archivals by stable id means an item quietly accumulates travel
history across trips without archivals.json ever changing.

Templates are reusable base lists ("always pack") that seed or top up a trip.

Data: trips.json {"trips": [...]}, travel_templates.json {"templates": [...]}.
Everything is UI-first; the Keeper can work the same store files, but nothing
here requires it.
"""
import uuid
from datetime import datetime

from flask import request, jsonify

import store

TRIP_STATUSES = ("planning", "packing", "away", "home")
RETURNED_STATES = ("", "home", "left", "lost")
ITEM_SOURCES = ("archival", "active", "text")


def _load_trips():
    return store.read("trips.json", {"trips": []})


def _save_trips(data):
    store.write("trips.json", data)


def _load_templates():
    return store.read("travel_templates.json", {"templates": []})


def _save_templates(data):
    store.write("travel_templates.json", data)


def _new_id():
    return uuid.uuid4().hex[:12]


def _find(seq, key_id):
    return next((x for x in seq if x.get("id") == key_id), None)


def _clean_str(v):
    return v.strip() if isinstance(v, str) else ""


def _item_key(entry):
    """Duplicate identity within one trip: same referenced thing, or same
    free-text name (case-insensitive)."""
    source = entry.get("source") or "text"
    if source != "text" and entry.get("ref_id"):
        return (source, entry["ref_id"])
    return ("text", (entry.get("name") or "").strip().lower())


def _new_item(body):
    return {
        "id": _new_id(),
        "name": _clean_str(body.get("name")),
        "source": body.get("source") if body.get("source") in ITEM_SOURCES else "text",
        "ref_id": _clean_str(body.get("ref_id")),
        "category": _clean_str(body.get("category")),
        "notes": _clean_str(body.get("notes")),
        "packed": False,
        "returned": "",
    }


def register(app):

    # --- page data ---

    @app.route("/api/travel/data")
    def travel_data():
        """Everything the /travel page needs in one poll: trips, templates,
        and the pickable sources (archivals + non-finished consumables)."""
        archivals = store.read("archivals.json", {"items": []})["items"]
        active = store.read("active_inventory.json", {"items": []})["items"]
        return jsonify({
            "trips": _load_trips()["trips"],
            "templates": _load_templates()["templates"],
            "sources": {
                "archivals": [{
                    "id": i.get("id", ""),
                    "name": i.get("name", ""),
                    "category": i.get("category", ""),
                    "photo": (i.get("photos") or [{}])[0].get("filename", ""),
                } for i in archivals if i.get("id")],
                # Consumables are picked by name — that's their identity in
                # active_inventory.json (no ids there). Finished ones aren't
                # packable, so they don't show up.
                "active": [{
                    "id": i.get("name", ""),
                    "name": i.get("name", ""),
                    "category": i.get("category", ""),
                    "photo": "",
                } for i in active if i.get("status") != "finished"],
            },
        })

    # --- trips ---

    @app.route("/api/travel/trip/add", methods=["POST"])
    def add_trip():
        body = request.json or {}
        name = _clean_str(body.get("name"))
        if not name:
            return jsonify({"error": "Trip needs a name"}), 400
        trip = {
            "id": _new_id(),
            "name": name,
            "destination": _clean_str(body.get("destination")),
            "start": _clean_str(body.get("start")),
            "end": _clean_str(body.get("end")),
            "status": "planning",
            "notes": _clean_str(body.get("notes")),
            "items": [],
            "created_at": datetime.now().strftime("%Y-%m-%d"),
        }
        # Optionally seed from templates right at creation.
        template_ids = body.get("template_ids") or []
        if template_ids:
            templates = _load_templates()["templates"]
            seen = set()
            for tid in template_ids:
                tpl = _find(templates, tid)
                for entry in (tpl or {}).get("items", []):
                    item = _new_item(entry)
                    if not item["name"] or _item_key(item) in seen:
                        continue
                    seen.add(_item_key(item))
                    trip["items"].append(item)
        data = _load_trips()
        data["trips"].append(trip)
        _save_trips(data)
        return jsonify({"ok": True, "id": trip["id"]})

    @app.route("/api/travel/trip/update", methods=["POST"])
    def update_trip():
        body = request.json or {}
        data = _load_trips()
        trip = _find(data["trips"], body.get("id"))
        if not trip:
            return jsonify({"error": "No such trip"}), 404
        for field in ("name", "destination", "start", "end", "notes"):
            if field in body:
                trip[field] = _clean_str(body[field])
        if "status" in body:
            if body["status"] not in TRIP_STATUSES:
                return jsonify({"error": "Bad status"}), 400
            trip["status"] = body["status"]
        if not trip["name"]:
            return jsonify({"error": "Trip needs a name"}), 400
        _save_trips(data)
        return jsonify({"ok": True})

    @app.route("/api/travel/trip/remove", methods=["POST"])
    def remove_trip():
        body = request.json or {}
        data = _load_trips()
        data["trips"] = [t for t in data["trips"] if t.get("id") != body.get("id")]
        _save_trips(data)
        return jsonify({"ok": True})

    # --- packing list items ---

    @app.route("/api/travel/item/add", methods=["POST"])
    def add_trip_item():
        body = request.json or {}
        data = _load_trips()
        trip = _find(data["trips"], body.get("trip_id"))
        if not trip:
            return jsonify({"error": "No such trip"}), 404
        item = _new_item(body)
        if not item["name"]:
            return jsonify({"error": "Empty name"}), 400
        if any(_item_key(i) == _item_key(item) for i in trip["items"]):
            return jsonify({"error": "Already on the list"}), 400
        trip["items"].append(item)
        _save_trips(data)
        return jsonify({"ok": True, "id": item["id"]})

    @app.route("/api/travel/item/update", methods=["POST"])
    def update_trip_item():
        body = request.json or {}
        data = _load_trips()
        trip = _find(data["trips"], body.get("trip_id"))
        if not trip:
            return jsonify({"error": "No such trip"}), 404
        item = _find(trip["items"], body.get("item_id"))
        if not item:
            return jsonify({"error": "No such item"}), 404
        if "packed" in body:
            item["packed"] = bool(body["packed"])
        if "returned" in body:
            if body["returned"] not in RETURNED_STATES:
                return jsonify({"error": "Bad returned state"}), 400
            item["returned"] = body["returned"]
        for field in ("name", "category", "notes"):
            if field in body:
                item[field] = _clean_str(body[field])
        if not item["name"]:
            return jsonify({"error": "Empty name"}), 400
        _save_trips(data)
        return jsonify({"ok": True})

    @app.route("/api/travel/item/remove", methods=["POST"])
    def remove_trip_item():
        body = request.json or {}
        data = _load_trips()
        trip = _find(data["trips"], body.get("trip_id"))
        if not trip:
            return jsonify({"error": "No such trip"}), 404
        trip["items"] = [i for i in trip["items"] if i.get("id") != body.get("item_id")]
        _save_trips(data)
        return jsonify({"ok": True})

    # --- templates ---

    @app.route("/api/travel/template/save", methods=["POST"])
    def save_template():
        """Create (no id) or replace (with id) a template. Items keep only
        what a future trip needs — name/source/ref_id/category."""
        body = request.json or {}
        name = _clean_str(body.get("name"))
        if not name:
            return jsonify({"error": "Template needs a name"}), 400
        items = [{
            "name": _clean_str(e.get("name")),
            "source": e.get("source") if e.get("source") in ITEM_SOURCES else "text",
            "ref_id": _clean_str(e.get("ref_id")),
            "category": _clean_str(e.get("category")),
        } for e in (body.get("items") or []) if _clean_str(e.get("name"))]
        data = _load_templates()
        tpl = _find(data["templates"], body.get("id")) if body.get("id") else None
        if tpl:
            tpl["name"] = name
            tpl["items"] = items
            tpl_id = tpl["id"]
        else:
            tpl_id = _new_id()
            data["templates"].append({"id": tpl_id, "name": name, "items": items})
        _save_templates(data)
        return jsonify({"ok": True, "id": tpl_id})

    @app.route("/api/travel/template/remove", methods=["POST"])
    def remove_template():
        body = request.json or {}
        data = _load_templates()
        data["templates"] = [t for t in data["templates"] if t.get("id") != body.get("id")]
        _save_templates(data)
        return jsonify({"ok": True})

    @app.route("/api/travel/template/apply", methods=["POST"])
    def apply_template():
        """Top up a trip from a template, skipping entries it already has."""
        body = request.json or {}
        data = _load_trips()
        trip = _find(data["trips"], body.get("trip_id"))
        if not trip:
            return jsonify({"error": "No such trip"}), 404
        tpl = _find(_load_templates()["templates"], body.get("template_id"))
        if not tpl:
            return jsonify({"error": "No such template"}), 404
        existing = {_item_key(i) for i in trip["items"]}
        added = 0
        for entry in tpl.get("items", []):
            item = _new_item(entry)
            if not item["name"] or _item_key(item) in existing:
                continue
            existing.add(_item_key(item))
            trip["items"].append(item)
            added += 1
        _save_trips(data)
        return jsonify({"ok": True, "added": added})

    @app.route("/api/travel/template/from-trip", methods=["POST"])
    def template_from_trip():
        """Snapshot a trip's list as a reusable template (names only — no
        packed/returned state travels along)."""
        body = request.json or {}
        name = _clean_str(body.get("name"))
        if not name:
            return jsonify({"error": "Template needs a name"}), 400
        trip = _find(_load_trips()["trips"], body.get("trip_id"))
        if not trip:
            return jsonify({"error": "No such trip"}), 404
        data = _load_templates()
        tpl_id = _new_id()
        data["templates"].append({
            "id": tpl_id,
            "name": name,
            "items": [{
                "name": i.get("name", ""),
                "source": i.get("source", "text"),
                "ref_id": i.get("ref_id", ""),
                "category": i.get("category", ""),
            } for i in trip.get("items", []) if i.get("name")],
        })
        _save_templates(data)
        return jsonify({"ok": True, "id": tpl_id})
