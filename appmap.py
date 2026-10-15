"""The apps the site is cut into, read from apps.json — for the server side.

Plain English: the site is no longer one everything-app. It is a handful of
apps (Journal, Observatory, Finances, Inventory), each installed on its own on
a phone and each holding its own pages. apps.json at the repo root is the one
list of them; the page reads it through frontend/src/shell/apps.ts, and this
file is the Python reader. It answers three things:

  - which apps there are, and one by id (`apps`, `app`);
  - which app holds a page (`owner_of`): the longest page prefix wins, so
    /terrain/pond is the Journal's while the rest of /terrain is the
    Observatory's;
  - what an app's web manifest says (`manifest`) — the little file a phone
    reads when the app is added to the Home Screen.

Touches: apps.json (the list), routes/spa.py (serves the manifests and puts
each app's name and icon into the page), routes/apps.py and appboundaries.py
(the boundary map), tests/test_spa_routes.py, tests/test_app_boundaries.py.
The whole design: docs/apps.md.

Prompt that produced it: "I want to separate my journal, my based foods/grocery
app, and my observatory into separate apps to use on my phone. I guess
separate PWAs for now."
"""
import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APPS_FILE = ROOT / "apps.json"


@lru_cache(maxsize=1)
def load():
    """apps.json, parsed once per process — it only changes with a deploy."""
    return json.loads(APPS_FILE.read_text())


def apps():
    """The installable apps, {id: app}, in the order apps.json lists them."""
    return load()["apps"]


def app(app_id):
    """One app by id, or None for an id that isn't one (never raises: the id
    arrives from a URL anyone can type)."""
    return apps().get(app_id) if isinstance(app_id, str) else None


def _under(prefix, path):
    """True when `path` is `prefix` itself or a page under it. The boundary
    check is what keeps /codex from counting as part of /code."""
    return path == prefix or path.startswith(prefix.rstrip("/") + "/")


def owner_of(path):
    """Which app holds this page: an app id, or None when no app does (a
    shared page, the launcher, a Based Foods page). Longest prefix wins."""
    best, best_len = None, -1
    for app_id, entry in apps().items():
        for prefix in entry["pages"]:
            if _under(prefix, path) and len(prefix) > best_len:
                best, best_len = app_id, len(prefix)
    return best


def icon_path(app_id, size):
    """Where one app's Home Screen icon is served: /apps/<id>-<size>.png,
    from frontend/public/apps/ (copied into dist/apps/ by the build)."""
    return f"/apps/{app_id}-{size}.png"


def start_url(app_id):
    """The page an installed app opens on, carrying ?app= so the page knows
    which app it is the moment it loads (shell/apps.ts)."""
    return f"{apps()[app_id]['start']}?app={app_id}"


def manifest(app_id):
    """One app's web manifest, as a dict, or None for an unknown id.

    Each app has its own `id` and `start_url`, so a phone treats them as
    separate apps; they all share scope "/" because they live on one site
    and their pages link to each other. Colours follow the site's own PWA
    settings (frontend/vite.config.ts used to write the one manifest)."""
    entry = app(app_id)
    if entry is None:
        return None
    return {
        "id": f"/?app={app_id}",
        "name": entry["name"],
        "short_name": entry["short_name"],
        "description": f"{entry['name']} — part of a personal exocortex",
        "start_url": start_url(app_id),
        "scope": "/",
        "display": "standalone",
        "background_color": "#aba3b2",
        "theme_color": entry.get("color") or "#7c5cbf",
        "icons": [
            {"src": icon_path(app_id, 192), "sizes": "192x192", "type": "image/png"},
            {"src": icon_path(app_id, 512), "sizes": "512x512", "type": "image/png"},
            {"src": icon_path(app_id, 512), "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
