"""Route tests for routes/shell.py — the app-shell URL scheme:

  - /dashboard/<tab>            renders split.html (the shell) with that tab active
  - legacy tab paths (/map, /car-maintenance, ...)  302-redirect to /dashboard/<tab>
  - /journal, /files, /settings render the shell with that view active
  - /settings-view               renders settings.html standalone (mirrors /journal-view)
  - /                            renders the shell with "today" active, never redirected

Builds a minimal Flask app registering only routes.shell, following the
convention in tests/conftest.py / tests/test_todos_routes.py. split.html calls
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


# --- /dashboard/<tab> ----------------------------------------------------------

def test_dashboard_tab_renders_shell_with_tab_active():
    r = _client().get("/dashboard/map")
    assert r.status_code == 200
    assert b'src="/tab/map"' in r.data


def test_dashboard_nonsense_falls_back_to_today():
    r = _client().get("/dashboard/nonsense")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/today"


def test_dashboard_bare_redirects_to_today():
    r = _client().get("/dashboard")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/today"


# --- legacy path redirects ------------------------------------------------------

def test_legacy_map_redirects_to_dashboard_map():
    r = _client().get("/map")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/map"


def test_legacy_car_maintenance_redirects_to_dashboard_car():
    r = _client().get("/car-maintenance")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/car"


def test_legacy_people_redirects_to_dashboard_people():
    r = _client().get("/people")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/people"


# --- shell views: journal / files / settings ------------------------------------

def test_journal_renders_the_shell_not_journal_html():
    r = _client().get("/journal")
    assert r.status_code == 200
    assert b'id="journalFrame"' in r.data
    assert b"<title>Journal</title>" not in r.data


def test_files_renders_the_shell():
    r = _client().get("/files")
    assert r.status_code == 200
    assert b'id="filesFrame"' in r.data


def test_settings_renders_the_shell_not_settings_html():
    r = _client().get("/settings")
    assert r.status_code == 200
    assert b'id="settingsFrame"' in r.data
    assert b"settings-wrap" not in r.data


def test_settings_view_renders_settings_html():
    r = _client().get("/settings-view")
    assert r.status_code == 200
    assert b"settings-wrap" in r.data


# --- root ------------------------------------------------------------------------

def test_root_renders_shell_with_today_active():
    r = _client().get("/")
    assert r.status_code == 200
    assert b'src="/tab/today"' in r.data
    assert b'ACTIVE_VIEW = "dashboard"' in r.data


# --- item/buy passthrough --------------------------------------------------------

def test_item_buy_renders_shell_with_inventory_active():
    r = _client().get("/item/buy/widget")
    assert r.status_code == 200
    assert b'src="/tab/inventory?item=widget"' in r.data
