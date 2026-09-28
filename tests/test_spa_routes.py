"""Route tests for routes/spa.py — the React SPA shell that now serves "/".

Builds a minimal Flask app registering only routes.spa (plus routes.shell,
since spa.py reuses its `_load_public_intro_html` helper, and routes.settings
for `/api/theme`'s `load_theme`). Exercises the real `frontend/dist/` build
output — run `npm run build` in frontend/ first if this directory doesn't
exist yet.

Covers: "/" returns injected HTML (window.THEME_OVERRIDES / window.VIEW_MODE),
every native page path serves the shell, /assets/<built asset> is 200, and
/legacy/<tab> redirects to the native tab (the legacy frontend is retired).
"""
import json
from pathlib import Path

import pytest
from flask import Flask

from routes import shell, spa

TEMPLATES_DIR = str(Path(__file__).resolve().parent.parent / "templates")

pytestmark = pytest.mark.skipif(
    not spa.INDEX_PATH.exists(),
    reason="frontend/dist/index.html not built — run `npm run build` in frontend/",
)


def _make_app(view_mode=None):
    app = Flask(__name__, template_folder=TEMPLATES_DIR)
    app.config.update(TESTING=True)

    @app.context_processor
    def _stub_v_static():
        return dict(v_static=lambda filename: f"/static/{filename}")

    if view_mode is not None:
        from flask import request

        @app.before_request
        def _stub_view_mode():
            request.view_mode = view_mode

    shell.register(app)
    spa.register(app)
    return app


def _client(view_mode=None):
    return _make_app(view_mode).test_client()


def _first_asset_filename():
    return next(p.name for p in spa.ASSETS_DIR.iterdir() if p.is_file())


# --- "/" and the other SPA routes -----------------------------------------------

def test_root_returns_injected_spa_html():
    r = _client().get("/")
    assert r.status_code == 200
    assert b"window.THEME_OVERRIDES = " in r.data
    assert b'window.VIEW_MODE = "authed"' in r.data
    assert r.headers["Cache-Control"] == "no-store"


def test_root_theme_overrides_is_valid_json_before_head_close():
    r = _client().get("/")
    html = r.data.decode()
    marker = "window.THEME_OVERRIDES = "
    start = html.index(marker) + len(marker)
    end = html.index(";", start)
    json.loads(html[start:end])  # raises if it's not valid JSON


def test_root_public_intro_html_is_null_when_authed():
    r = _client().get("/")
    assert b"window.PUBLIC_INTRO_HTML = null;" in r.data


def test_root_public_intro_html_is_a_string_when_public():
    r = _client(view_mode="public").get("/")
    assert b'window.VIEW_MODE = "public"' in r.data
    assert b"window.PUBLIC_INTRO_HTML = null;" not in r.data


def test_root_injects_app_meta():
    # name/owner/version chrome (public header, fake-terminal banner) —
    # injected for every view mode.
    import config

    r = _client().get("/")
    marker = b"window.APP_META = "
    assert marker in r.data
    start = r.data.index(marker) + len(marker)
    end = r.data.index(b";window", start) if b";window" in r.data[start:] else r.data.index(b";</script>", start)
    meta = json.loads(r.data[start:end])
    assert meta["name"] == config.APP_NAME
    assert meta["version"] == config.APP_VERSION
    assert "owner" in meta


@pytest.mark.parametrize("path", [
    "/todos", "/todos/editor", "/journal", "/research", "/settings", "/files",
    "/threads", "/threads/some-slug",
    # native dashboard tabs (ported from /tab/<name>)
    "/map", "/kitchen", "/inventory", "/money", "/car", "/meditation", "/media",
    "/movement", "/body", "/ideas", "/ecosystem", "/housing", "/people", "/travel",
    # native standalone pages (ported from their Flask templates)
    "/person/some-slug", "/personality", "/scratchpad", "/vscode", "/food-map", "/about",
    # the Food area: the map, every food, one food's page, the review list
    "/food", "/food/foods", "/food/foods/green%20beans", "/food/review",
    # session-visualization surfaces (born native)
    "/terrain", "/atlas", "/sessions", "/automations",
    # rooms inside terrain — child routes, so the catch-all has to serve the
    # shell for them too or a pasted link 404s instead of opening the room
    "/terrain/usage", "/terrain/sql",
    # the database's own page, also reachable as a terrain room
    "/sql",
    # one file, read-only — where a session card's file list opens into
    "/code",
])
def test_spa_routes_all_serve_the_injected_shell(path):
    r = _client().get(path)
    assert r.status_code == 200
    assert b"window.VIEW_MODE" in r.data
    assert b'<div id="root">' in r.data


# --- /assets/<built asset> --------------------------------------------------------

def test_asset_returns_200_and_is_immutably_cached():
    filename = _first_asset_filename()
    r = _client().get(f"/assets/{filename}")
    assert r.status_code == 200
    assert "immutable" in r.headers["Cache-Control"]


def test_unknown_asset_404s():
    r = _client().get("/assets/does-not-exist.js")
    assert r.status_code == 404


# --- /geo/<boundary file> — the Ecosystem map's county/state outlines --------------

def test_geo_counties_served_as_json_and_cached():
    # Before this route existed the fetch got a 404 page and every county
    # source on the map silently drew as a dot.
    r = _client().get("/geo/us-counties.geojson")
    assert r.status_code == 200
    assert "max-age" in r.headers["Cache-Control"]
    assert json.loads(r.get_data())["type"] == "FeatureCollection"


def test_geo_states_served():
    r = _client().get("/geo/us-states.geojson")
    assert r.status_code == 200
    assert json.loads(r.get_data())["type"] == "FeatureCollection"


def test_geo_only_serves_geojson():
    assert _client().get("/geo/anything.json").status_code == 404
    assert _client().get("/geo/missing.geojson").status_code == 404


# --- root-level PWA files ---------------------------------------------------------

def test_manifest_webmanifest_served_from_dist():
    r = _client().get("/manifest.webmanifest")
    assert r.status_code == 200


def test_sw_js_is_never_cached():
    r = _client().get("/sw.js")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "no-store"


def test_unknown_root_file_404s():
    r = _client().get("/not-a-real-file.js")
    assert r.status_code == 404


def test_index_html_serves_raw_uninjected_shell():
    # The SW precache manifest lists "index.html"; if this 404s, every service
    # worker update fails to install and clients keep the stale SW forever.
    r = _client().get("/index.html")
    assert r.status_code == 200
    assert b'<div id="root">' in r.data
    # Raw dist file, byte-identical to what vite hashed — no injected globals.
    assert b"window.VIEW_MODE" not in r.data
    assert r.data == spa.INDEX_PATH.read_bytes()


def test_sw_precache_root_files_are_public():
    from public_config import is_public_path

    for path in ("/index.html", "/icon-192.png", "/icon-512.png", "/sw.js",
                 "/registerSW.js", "/manifest.webmanifest"):
        assert is_public_path(path), path


# --- legacy bookmark redirects ------------------------------------------------------

def test_legacy_tab_redirects_to_native_tab():
    r = _client().get("/legacy/map")
    assert r.status_code == 302
    assert r.headers["Location"] == "/map"


def test_legacy_unknown_tab_redirects_to_todos():
    r = _client().get("/legacy/nonsense")
    assert r.status_code == 302
    assert r.headers["Location"] == "/todos"
