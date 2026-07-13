"""Fronts routes — a shared life-domain vocabulary (health, appearance,
finances, ...) that research topics get tagged with.

    {"fronts": [{"id", "name", "created"}]}

Front ids are slugified names, same collision handling as research topic ids
(see routes/research.py). Removing a front strips its id from every research
topic's `fronts` list (routes/research.py) — the topics survive, they just
lose that tag.
"""
import re
from datetime import datetime

from flask import request, jsonify

import store


def _slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "front"


def _unique_id(base, taken):
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


def _now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _blob(data):
    return jsonify({"fronts": data.get("fronts", [])})


def register(app):

    @app.route("/api/fronts")
    def get_fronts():
        data = store.read("fronts.json", {"fronts": []})
        return _blob(data)

    @app.route("/api/fronts/add", methods=["POST"])
    def add_front():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        with store.mutate("fronts.json", {"fronts": []}) as data:
            fronts = data.setdefault("fronts", [])
            fid = _unique_id(_slugify(name), {f["id"] for f in fronts})
            fronts.append({"id": fid, "name": name, "created": _now_stamp()})
        return _blob(data)

    @app.route("/api/fronts/edit", methods=["POST"])
    def edit_front():
        body = request.json or {}
        fid = body.get("id")
        with store.mutate("fronts.json", {"fronts": []}) as data:
            front = next((f for f in data.get("fronts", []) if f["id"] == fid), None)
            if not front:
                return jsonify({"error": "not found"}), 404
            if "name" in body:
                name = (body.get("name") or "").strip()
                if not name:
                    return jsonify({"error": "name cannot be empty"}), 400
                front["name"] = name
        return _blob(data)

    @app.route("/api/fronts/remove", methods=["POST"])
    def remove_front():
        body = request.json or {}
        fid = body.get("id")
        with store.mutate("fronts.json", {"fronts": []}) as data:
            data["fronts"] = [f for f in data.get("fronts", []) if f["id"] != fid]
        # Cleanup lives in a separate mutate — fronts.json and research.json
        # are different collections (research.json is SQL-backed).
        with store.mutate("research.json", {"topics": [], "entries": []}) as rdata:
            for t in rdata.get("topics", []):
                if fid in (t.get("fronts") or []):
                    t["fronts"] = [x for x in t["fronts"] if x != fid]
        return _blob(data)
