"""/api/apps — the apps the site is cut into, what each is made of, and where
they still reach into each other.

Plain English: the Terrain's Apps room (frontend/src/features/terrain/apps/)
draws a column per app — its pages, routes, modules and tables — with the
crossings between apps in red, plus a Based Foods column that is the port
checklist (which kitchen pages Based Foods already has). This is the one door
it reads. Read-only. Owner only: it isn't in public_config.PUBLIC_PATHS.

Reads apps.json (appmap.py), projects.json, and the crossings
(appboundaries.py), which take a few seconds to find — so they're kept for
ten minutes, a cache that expires.

Prompt that produced it: "a map plus a ratcheting test that shows and
shrinks the tangle between them".
"""
import threading
import time

from flask import jsonify

import appboundaries
import appmap

_CACHE_SECONDS = 600
_cache = {"at": 0.0, "crossings": None}
_cache_lock = threading.Lock()


def _crossings():
    """The crossings, found at most once every ten minutes."""
    with _cache_lock:
        if _cache["crossings"] is None or time.time() - _cache["at"] > _CACHE_SECONDS:
            _cache["crossings"] = appboundaries.crossings()
            _cache["at"] = time.time()
        return _cache["crossings"]


def _parts(project_ids):
    """Everything a set of projects is made of, each kind merged in order."""
    projects = appboundaries.projects()
    merged = {kind: [] for kind in ("routes", "modules", "frontend", "scripts", "tables")}
    for project_id in project_ids:
        for kind in merged:
            merged[kind].extend(projects[project_id][kind])
    return merged


def payload():
    """The whole map: apps, the shared Core, Based Foods, and the crossings,
    each marked with whether the baseline already knows it."""
    data = appmap.load()
    known = appboundaries.baseline()
    crossings = [{**crossing, "known": appboundaries.key(crossing) in known} for crossing in _crossings()]
    apps = []
    for app_id, entry in appmap.apps().items():
        apps.append({
            "id": app_id, "name": entry["name"], "glyph": entry["glyph"],
            "pages": entry["pages"], "borrows": entry.get("borrows", []),
            "projects": entry["projects"], **_parts(entry["projects"]),
        })
    foods = data["based_foods"]
    return {
        "apps": apps,
        "shared": {"pages": data["shared"]["pages"], "projects": data["shared"]["projects"],
                   **_parts(data["shared"]["projects"])},
        "based_foods": {"id": appboundaries.BASED_FOODS, "name": foods["name"], "glyph": foods["glyph"],
                        "pages": foods["pages"], "projects": foods["projects"], **_parts(foods["projects"])},
        "crossings": crossings,
    }


def register(app):
    @app.route("/api/apps")
    def apps_map():
        return jsonify(payload())
