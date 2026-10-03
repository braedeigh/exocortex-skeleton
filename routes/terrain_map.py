"""Terrain map API — the doors behind the Map room: every codebase map on this
machine, and one map's boxes and links.

A map is a codebase drawn as boxes with named arrows, read from small markdown
files that live in the repo they describe (codemap.py reads and checks them;
docs/codemap.md is the format). This module only serves them — it never writes
a box.

The endpoints:
  GET /api/observatory/terrain/maps               every map, with its counts (boxes, stale, broken)
  GET /api/observatory/terrain/maps/<repo>/<name> one map: its boxes, each checked against its files

OWNER ONLY, like the Builds room: a map names files and describes how the
owner's code works. A visitor gets a 404 from each handler, and none of these
paths is in public_config.PUBLIC_PATHS, so the site's gate refuses one first.

Touches: `codemap.py` (finding, reading and checking the maps),
`routes/terrain.py` (who counts as a visitor).

Prompt that produced this file: "I like calling the entire thing terrain. New
thing is just map. I want to see basedfoods and the observatory"
"""
from flask import jsonify

import codemap
import config
from routes import terrain


def register(app):
    def _refuse_visitor():
        """Refuse a visitor: a 404 for anyone who isn't the owner, and on a
        public mirror. Maps are hers alone."""
        if terrain._visitor() or config.public_only():
            return jsonify({"error": "not found"}), 404
        return None

    @app.route("/api/observatory/terrain/maps")
    def terrain_maps_list():
        """Every map, in the order the switch shows them, with its counts.
        A map that fails to read is listed with its error, not dropped."""
        refusal = _refuse_visitor()
        if refusal is not None:
            return refusal
        maps = []
        for found in codemap.find_maps():
            try:
                maps.append(codemap.summary(codemap.load(found)))
            except Exception as error:   # one unreadable map must not take the list down
                maps.append({"key": found["key"], "name": found["slug"], "repo": found["repo"],
                             "repo_name": found["repo_name"], "error": str(error)})
        return jsonify({"maps": maps, "link_kinds": list(codemap.LINK_KINDS)})

    @app.route("/api/observatory/terrain/maps/<repo_id>/<name>")
    def terrain_map_get(repo_id, name):
        """One map whole: every box with its description, sources (each saying
        whether it still exists), links, and whether it is stale or broken.
        The page lays it out and walks it level by level itself."""
        refusal = _refuse_visitor()
        if refusal is not None:
            return refusal
        found = codemap.find_map(f"{repo_id}/{name}")
        if found is None:
            return jsonify({"error": "no such map"}), 404
        loaded = codemap.load(found)
        loaded["link_kinds"] = list(codemap.LINK_KINDS)
        return jsonify(loaded)
