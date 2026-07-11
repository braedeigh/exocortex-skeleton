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


# --- /api/about (backs the public About page) -----------------------------------

def _about(monkeypatch, tmp_path, text=None):
    """Point shell.PUBLIC_ABOUT_PATH at a tmp file (or a missing one) and GET /api/about."""
    path = tmp_path / "public_about.md"
    if text is not None:
        path.write_text(text)
    monkeypatch.setattr(shell, "PUBLIC_ABOUT_PATH", path)
    r = _client().get("/api/about")
    assert r.status_code == 200
    return r.get_json()["html"]


def test_api_about_missing_file_returns_empty_html(monkeypatch, tmp_path):
    assert _about(monkeypatch, tmp_path) == ""


def test_api_about_renders_headings_paragraphs_and_bullets(monkeypatch, tmp_path):
    html = _about(monkeypatch, tmp_path, "# Title\n\n## Sub\n\nA `code` span.\n\n- one\n- two\n")
    assert "<h1>Title</h1>" in html
    assert "<h2>Sub</h2>" in html
    assert "<p>A <code>code</code> span.</p>" in html
    assert "<li>one</li>" in html and "<li>two</li>" in html


def test_api_about_joins_wrapped_paragraph_lines(monkeypatch, tmp_path):
    html = _about(monkeypatch, tmp_path, "line one\nline two\n")
    assert "<p>line one line two</p>" in html


def test_api_about_renders_http_links_only(monkeypatch, tmp_path):
    html = _about(monkeypatch, tmp_path, "[ok](https://example.com) [bad](javascript:alert(1))")
    assert '<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>' in html
    # the javascript: pseudo-link must NOT become an anchor — it stays literal text
    assert '<a href="javascript' not in html
    assert "[bad](javascript:alert(1))" in html


def test_api_about_escapes_raw_html(monkeypatch, tmp_path):
    html = _about(monkeypatch, tmp_path, "hello <script>alert(1)</script>")
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
