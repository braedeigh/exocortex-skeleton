"""Route tests for routes/shell.py — the old app-shell URL scheme, now kept as
a rollback path behind "/classic" (see tests/test_spa_routes.py for "/" and
the other paths routes/spa.py now owns):

  - /classic, /classic/<tab>     render split.html (the shell) with that tab active
  - /classic/journal, /classic/research, /classic/files, /classic/settings
                                  render the shell with that view active
  - legacy tab paths (/map, /car-maintenance, ...)  302-redirect to /dashboard/<tab>
  - /dashboard/<tab>             302-redirects into the SPA ("/todos" for "today",
                                  "/legacy/<tab>" otherwise)
  - /settings-view                renders settings.html standalone (mirrors /journal-view)

Builds a minimal Flask app registering only routes.shell. split.html calls
v_static(...) (server.py's cache-busting context processor) — stub it here so
the template renders standalone.
"""
from pathlib import Path

from flask import Flask

from routes import shell

TEMPLATES_DIR = str(Path(__file__).resolve().parent.parent / "templates")


def _make_app():
    app = Flask(__name__, template_folder=TEMPLATES_DIR)
    app.config.update(TESTING=True)

    @app.context_processor
    def _stub_v_static():
        return dict(v_static=lambda filename: f"/static/{filename}")

    shell.register(app)
    return app


def _client():
    return _make_app().test_client()


# --- /classic, /classic/<tab> ---------------------------------------------------

def test_classic_home_renders_shell_with_today_active():
    r = _client().get("/classic")
    assert r.status_code == 200
    assert b'src="/tab/today"' in r.data
    assert b'ACTIVE_VIEW = "dashboard"' in r.data


def test_classic_tab_renders_shell_with_tab_active():
    r = _client().get("/classic/map")
    assert r.status_code == 200
    assert b'src="/tab/map"' in r.data


def test_classic_nonsense_tab_falls_back_to_classic_today():
    r = _client().get("/classic/nonsense")
    assert r.status_code == 302
    assert r.headers["Location"] == "/classic/today"


# --- /dashboard/<tab> now redirects into the SPA --------------------------------

def test_dashboard_today_redirects_to_todos():
    r = _client().get("/dashboard/today")
    assert r.status_code == 302
    assert r.headers["Location"] == "/todos"


def test_dashboard_tab_redirects_to_native_tab():
    r = _client().get("/dashboard/map")
    assert r.status_code == 302
    assert r.headers["Location"] == "/map"


def test_dashboard_nonsense_falls_back_to_dashboard_today():
    r = _client().get("/dashboard/nonsense")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/today"


def test_dashboard_bare_redirects_to_today():
    r = _client().get("/dashboard")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/today"


def test_dashboard_research_redirects_to_research_place():
    r = _client().get("/dashboard/research")
    assert r.status_code == 302
    assert r.headers["Location"] == "/research"


# --- legacy path redirects ------------------------------------------------------

def test_bare_tab_paths_are_no_longer_shell_owned():
    # /map, /people, ... are native SPA routes now (routes/spa.py) — the shell
    # blueprint must not register them, or its redirects would shadow the SPA.
    # In this shell-only test app that means they 404.
    for path in ("/map", "/people"):
        r = _client().get(path)
        assert r.status_code == 404, path


def test_legacy_car_maintenance_redirects_to_dashboard_car():
    r = _client().get("/car-maintenance")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/car"


# --- classic shell views: journal / files / research / settings ----------------

def test_classic_journal_renders_the_shell_not_journal_html():
    r = _client().get("/classic/journal")
    assert r.status_code == 200
    assert b'id="journalFrame"' in r.data
    assert b"<title>Journal</title>" not in r.data


def test_classic_files_renders_the_shell():
    r = _client().get("/classic/files")
    assert r.status_code == 200
    assert b'id="filesFrame"' in r.data


def test_classic_research_renders_the_shell_not_research_html():
    r = _client().get("/classic/research")
    assert r.status_code == 200
    assert b'id="researchFrame"' in r.data
    assert b'ACTIVE_VIEW = "research"' in r.data
    assert b"<title>Research</title>" not in r.data


def test_research_view_renders_research_html():
    r = _client().get("/research-view")
    assert r.status_code == 200
    assert b'id="research-area"' in r.data


def test_tab_research_redirects_to_tab_today():
    # Research is no longer a valid dashboard tab; the iframe-content route
    # bounces stale /tab/research to today rather than nesting the shell.
    r = _client().get("/tab/research")
    assert r.status_code == 302
    assert r.headers["Location"] == "/tab/today"


def test_classic_settings_renders_the_shell_not_settings_html():
    r = _client().get("/classic/settings")
    assert r.status_code == 200
    assert b'id="settingsFrame"' in r.data
    assert b"settings-wrap" not in r.data


def test_settings_view_renders_settings_html():
    r = _client().get("/settings-view")
    assert r.status_code == 200
    assert b"settings-wrap" in r.data


# --- item/buy passthrough --------------------------------------------------------

def test_item_buy_renders_shell_with_inventory_active():
    r = _client().get("/item/buy/widget")
    assert r.status_code == 200
    assert b'src="/tab/inventory?item=widget"' in r.data
