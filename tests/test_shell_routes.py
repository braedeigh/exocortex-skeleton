"""Route tests for routes/shell.py — after the 2026-07-09 legacy-frontend
retirement this module only carries redirects for old bookmarks (the split.html
shell, /classic, /tab/<name> and the *-view template routes are gone; the React
SPA owns every page — see tests/test_spa_routes.py):

  - /dashboard             302 → /dashboard/today
  - /dashboard/<tab>       302 → the native SPA tab (/todos for "today")
  - /dashboard/research    302 → /research
  - /car-maintenance       302 → /dashboard/car (path differs from tab key)
  - /item/buy/<name>       302 → /inventory?buy=<name>

Builds a minimal Flask app registering only routes.shell.
"""
from flask import Flask

from routes import shell


def _make_app():
    app = Flask(__name__)
    app.config.update(TESTING=True)
    shell.register(app)
    return app


def _client():
    return _make_app().test_client()


def test_dashboard_bare_redirects_to_today():
    r = _client().get("/dashboard")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/today"


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


def test_dashboard_research_redirects_to_research_place():
    r = _client().get("/dashboard/research")
    assert r.status_code == 302
    assert r.headers["Location"] == "/research"


def test_legacy_car_maintenance_redirects_to_dashboard_car():
    r = _client().get("/car-maintenance")
    assert r.status_code == 302
    assert r.headers["Location"] == "/dashboard/car"


def test_bare_tab_paths_are_not_shell_owned():
    # /map, /people, ... are native SPA routes (routes/spa.py) — the shell
    # blueprint must not register them. In this shell-only app they 404.
    for path in ("/map", "/people"):
        r = _client().get(path)
        assert r.status_code == 404, path


def test_item_buy_redirects_to_native_inventory_deep_link():
    r = _client().get("/item/buy/toothpaste")
    assert r.status_code == 302
    assert r.headers["Location"] == "/inventory?buy=toothpaste"


def test_item_buy_url_encodes_the_name():
    r = _client().get("/item/buy/olive oil")
    assert r.status_code == 302
    assert r.headers["Location"] == "/inventory?buy=olive%20oil"


def test_retired_shell_routes_are_gone():
    # The legacy frontend's routes must 404 now that templates/ is archived.
    for path in ("/classic", "/classic/kitchen", "/tab/today", "/journal-view",
                 "/research-view", "/settings-view", "/keeper"):
        r = _client().get(path)
        assert r.status_code == 404, path
