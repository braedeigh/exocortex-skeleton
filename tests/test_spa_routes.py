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
import re
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
    "/map", "/kitchen", "/inventory", "/money", "/media",
    "/body", "/ideas", "/ecosystem", "/people",
    # native standalone pages (ported from their Flask templates)
    "/person/some-slug", "/personality", "/scratchpad", "/vscode", "/food-map", "/about", "/demo/swarm",
    # the Food area: the map, every food, one food's page, the review list
    "/food", "/food/foods", "/food/foods/green%20beans", "/food/review",
    # session-visualization surfaces (born native)
    "/terrain", "/atlas", "/sessions", "/automations",
    # rooms inside terrain — child routes, so the catch-all has to serve the
    # shell for them too or a pasted link 404s instead of opening the room
    "/terrain/files", "/terrain/map", "/terrain/usage", "/terrain/sql",
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

# --- the apps: one manifest each (apps.json, appmap.py) ------------------------

import appmap  # noqa: E402


def test_page_opened_as_an_app_links_that_apps_manifest_icon_and_name():
    # What "Add to Home Screen" reads: the Journal installs as the Journal.
    html = _client().get("/journal?app=journal").get_data(as_text=True)
    assert '<link rel="manifest" href="/apps/journal.webmanifest">' in html
    assert 'href="/apps/journal-192.png"' in html
    assert "<title>Journal</title>" in html
    assert '<meta name="apple-mobile-web-app-title" content="Journal">' in html


def test_page_without_an_app_links_no_manifest():
    # There is no everything-app to install any more.
    for path in ("/", "/journal", "/observatory"):
        assert 'rel="manifest"' not in _client().get(path).get_data(as_text=True), path


def test_unknown_app_id_is_ignored():
    r = _client().get('/journal?app=nonsense"><script>')
    assert r.status_code == 200
    html = r.get_data(as_text=True)
    assert 'rel="manifest"' not in html and "nonsense" not in html


@pytest.mark.parametrize("app_id", list(appmap.apps()))
def test_each_app_serves_its_own_installable_manifest(app_id):
    r = _client().get(f"/apps/{app_id}.webmanifest")
    assert r.status_code == 200
    manifest = json.loads(r.get_data())
    entry = appmap.apps()[app_id]
    # Its own id and start page make the phone treat it as a separate app;
    # the shared scope lets its pages link to the other apps' pages.
    assert manifest["id"] == f"/?app={app_id}"
    assert manifest["start_url"] == f"{entry['start']}?app={app_id}"
    assert manifest["scope"] == "/"
    assert manifest["name"] == entry["name"] and manifest["display"] == "standalone"
    for icon in manifest["icons"]:
        assert _client().get(icon["src"]).status_code == 200, icon["src"]


def test_unknown_app_manifest_404s():
    assert _client().get("/apps/nonsense.webmanifest").status_code == 404
    assert _client().get("/apps/journal.json").status_code == 404


def test_based_foods_link_comes_from_config(monkeypatch):
    monkeypatch.setenv("EXOCORTEX_BASED_FOODS_URL", "https://foods.example:8443")
    assert b'window.BASED_FOODS_URL = "https://foods.example:8443";' in _client().get("/journal").data
    monkeypatch.delenv("EXOCORTEX_BASED_FOODS_URL")
    assert b'window.BASED_FOODS_URL = "";' in _client().get("/journal").data


def test_every_spa_page_belongs_to_one_app_or_is_shared_launcher_or_based_foods():
    """A page added to spa.py without a home in apps.json fails here."""
    data = appmap.load()
    shared = set(data["shared"]["pages"]) | set(data["set_down"]["pages"]) | {data["launcher"]}
    foods = {re.sub(r"\$\w+", "x", page["path"]) for page in data["based_foods"]["pages"]}
    app = _make_app()
    unfiled = []
    for rule in app.url_map.iter_rules():
        if rule.endpoint != "spa_shell":
            continue
        # /threads/<slug> → /threads/$slug, the spelling apps.json uses.
        path = re.sub(r"<(?:path:)?(\w+)>", r"$\1", rule.rule)
        concrete = re.sub(r"\$\w+", "x", path)
        owners = [aid for aid, entry in appmap.apps().items()
                  if any(appmap._under(prefix, concrete) for prefix in entry["pages"])]
        filed = (appmap.owner_of(concrete) is not None or path in shared
                 or any(appmap._under(page, concrete) for page in (shared | foods) - {"/"}))
        if not filed:
            unfiled.append(rule.rule)
        # Two apps both claiming a page is fine only when one prefix is
        # longer (that one wins, like /terrain/pond); equal claims are a clash.
        lengths = [max(len(p) for p in appmap.apps()[aid]["pages"] if appmap._under(p, concrete))
                   for aid in owners]
        assert len(lengths) == len(set(lengths)), f"{rule.rule} held equally by {owners}"
    assert unfiled == []


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
                 "/registerSW.js", "/apps/journal.webmanifest", "/apps/journal-192.png"):
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


# --- /api/build: which build the server holds ----------------------------------

def test_build_route_names_the_scripts_the_served_page_loads():
    """The page compares this answer with the script and stylesheet names in
    its own document, so the two must be built from the same names."""
    import re

    client = _client()
    served = client.get("/").get_data(as_text=True)
    names = sorted(set(re.findall(r"/assets/(index-[\w-]+\.(?:js|css))", served)))
    assert names, "the built page loads no index-* script"

    r = client.get("/api/build")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "no-store"
    assert r.get_json() == {"build": "+".join(names)}


def test_build_route_answers_blank_while_a_build_is_being_written(monkeypatch, tmp_path):
    """Mid-build there is no index.html; the page must read that as "unknown",
    not as a new build."""
    monkeypatch.setattr(spa, "INDEX_PATH", tmp_path / "index.html")
    assert _client().get("/api/build").get_json() == {"build": ""}
