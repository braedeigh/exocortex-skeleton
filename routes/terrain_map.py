"""Terrain map API — the doors behind the Map room: every codebase map on this
machine, and one map's boxes and links.

A map is a codebase drawn as boxes with named arrows, read from small markdown
files kept in the repo they describe or in the data folder (codemap.py reads and checks them;
docs/codemap.md is the format). This module only serves them — it never writes
a box.

The endpoints:
  GET /api/observatory/terrain/maps               every map, with its counts (boxes, stale, broken)
  GET /api/observatory/terrain/maps/<repo>/<name> one map: its boxes, each checked against its files

WHO MAY READ ONE. The owner reads every map. A visitor — logged out, or anyone
on the public mirror — reads only the maps named in public_config.PUBLIC_MAPS,
and gets a 404 for any other, as if it weren't there. A map names files and
describes how the owner's code works, so each is opened on purpose. A visitor's
copy also drops the upkeep marks (stale, the problems list): those are notes to
whoever maintains the map, not part of what it says.

Touches: `codemap.py` (finding, reading and checking the maps),
`routes/terrain.py` (who counts as a visitor), `public_config.py` (PUBLIC_MAPS,
and the two paths in PRESENTABLE_PATHS).

Prompt that produced this file: "I like calling the entire thing terrain. New
thing is just map. I want to see basedfoods and the observatory". Opened to
visitors on: "put my map feature on the website for the observatory room".
"""
from flask import jsonify

import codemap
import config
import public_config
from routes import terrain


def _is_visitor():
    """Anyone who isn't the owner: a logged-out request, or any request at
    all on a public mirror."""
    return terrain._visitor() or config.public_only()


def _for_visitor(loaded):
    """A visitor's copy of a loaded map: the same boxes and links, without the
    upkeep marks. Returns a new dict; the loaded map is not changed."""
    boxes = [{**box, "stale": False, "problems": []} for box in loaded["boxes"]]
    return {**loaded, "boxes": boxes, "problems": []}


def register(app):
    @app.route("/api/observatory/terrain/maps")
    def terrain_maps_list():
        """Every map, in the order the switch shows them, with its counts.
        A map that fails to read is listed with its error, not dropped. A
        visitor is listed only the public maps, and never one that failed."""
        visitor = _is_visitor()
        maps = []
        for found in codemap.find_maps():
            if visitor and found["key"] not in public_config.PUBLIC_MAPS:
                continue
            try:
                loaded = codemap.load(found)
                maps.append(codemap.summary(_for_visitor(loaded) if visitor else loaded))
            except Exception as error:   # one unreadable map must not take the list down
                if visitor:
                    continue
                maps.append({"key": found["key"], "name": found["slug"], "repo": found["repo"],
                             "repo_name": found["repo_name"], "error": str(error)})
        return jsonify({"maps": maps, "link_kinds": list(codemap.LINK_KINDS)})

    @app.route("/api/observatory/terrain/maps/<repo_id>/<name>")
    def terrain_map_get(repo_id, name):
        """One map whole: every box with its description, sources (each saying
        whether it still exists), links, and whether it is stale or broken.
        The page lays it out and walks it level by level itself."""
        visitor = _is_visitor()
        if visitor and f"{repo_id}/{name}" not in public_config.PUBLIC_MAPS:
            return jsonify({"error": "no such map"}), 404
        found = codemap.find_map(f"{repo_id}/{name}")
        if found is None:
            return jsonify({"error": "no such map"}), 404
        loaded = codemap.load(found)
        if visitor:
            loaded = _for_visitor(loaded)
        loaded["link_kinds"] = list(codemap.LINK_KINDS)
        return jsonify(loaded)
