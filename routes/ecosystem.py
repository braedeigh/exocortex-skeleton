"""Ecosystem routes — a map of where the things she's connected to come from.

First layer is **food**: each source is a grocery / meal-prep item traced back to
where it's actually sourced. Retail sourcing is mostly opaque, so an origin is
often only a rough *region*, not a precise farm — hence `precision` + `radius_km`,
which let a dot honestly say "somewhere in this area" rather than faking a point.

Single JSON file, fully editable through the UI (mirrors movement.json / places).

    {"sources": [
        {"id", "layer", "name", "note", "lat", "lng", "precision", "radius_km"}
    ]}

`precision` is "point" (a crisp dot) or "area" (a dot inside a soft circle of
`radius_km` km). `layer` defaults to "food" so later layers (clothing, …) can
share the same store without a migration.
"""
from flask import request, jsonify
import store
import uuid


def _load():
    return store.read("ecosystem", {"sources": []})


def _save(data):
    store.write("ecosystem", data)


def _find(data, sid):
    return next((s for s in data["sources"] if s["id"] == sid), None)


def _new_id():
    return uuid.uuid4().hex[:8]


def _coord(value, default=None):
    """Parse a lat/lng to float, or return default if blank/unparseable."""
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _precision(value):
    return "area" if str(value).strip().lower() == "area" else "point"


def _radius(value):
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


def register(app):

    @app.route("/api/ecosystem/source/add", methods=["POST"])
    def add_ecosystem_source():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        lat = _coord(body.get("lat"))
        lng = _coord(body.get("lng"))
        if lat is None or lng is None:
            return jsonify({"error": "missing location"}), 400
        precision = _precision(body.get("precision"))
        source = {
            "id": _new_id(),
            "layer": (body.get("layer") or "food").strip() or "food",
            "name": name,
            "note": (body.get("note") or "").strip(),
            "lat": lat,
            "lng": lng,
            "precision": precision,
            "radius_km": _radius(body.get("radius_km")) if precision == "area" else 0.0,
        }
        data = _load()
        data["sources"].append(source)
        _save(data)
        return jsonify({"ok": True, "id": source["id"]})

    @app.route("/api/ecosystem/source/update", methods=["POST"])
    def update_ecosystem_source():
        body = request.json or {}
        sid = body.get("id")
        data = _load()
        s = _find(data, sid)
        if not s:
            return jsonify({"error": "not found"}), 404
        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name:
                return jsonify({"error": "name cannot be empty"}), 400
            s["name"] = name
        if "note" in body:
            s["note"] = (body.get("note") or "").strip()
        if "lat" in body:
            lat = _coord(body.get("lat"))
            if lat is None:
                return jsonify({"error": "bad lat"}), 400
            s["lat"] = lat
        if "lng" in body:
            lng = _coord(body.get("lng"))
            if lng is None:
                return jsonify({"error": "bad lng"}), 400
            s["lng"] = lng
        if "layer" in body:
            s["layer"] = (body.get("layer") or "food").strip() or "food"
        if "precision" in body:
            s["precision"] = _precision(body.get("precision"))
        if "radius_km" in body:
            s["radius_km"] = _radius(body.get("radius_km"))
        # An area with no radius and a point with a radius are both incoherent —
        # normalise so the map renders predictably.
        if s.get("precision") == "point":
            s["radius_km"] = 0.0
        _save(data)
        return jsonify({"ok": True})

    @app.route("/api/ecosystem/source/remove", methods=["POST"])
    def remove_ecosystem_source():
        body = request.json or {}
        sid = body.get("id")
        data = _load()
        data["sources"] = [s for s in data["sources"] if s["id"] != sid]
        _save(data)
        return jsonify({"ok": True})
