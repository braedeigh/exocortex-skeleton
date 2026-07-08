"""The React SPA shell — serves `frontend/dist/` and replaces split.html as the
front door ("/") of the site. See `routes/shell.py` for the old shell, kept
reachable at "/classic" as a rollback path, and the design doc this implements
(`react-shell-design.md`).

URL scheme:
  - "/" and every SPA route ("/todos", "/legacy/<tab>", "/journal", "/research",
    "/settings", "/files") → `frontend/dist/index.html`, with `window.THEME_OVERRIDES`,
    `window.VIEW_MODE`, and `window.PUBLIC_INTRO_HTML` injected before `</head>`.
    Client-side routing (TanStack Router) takes it from there. Cache-Control:
    no-store — this HTML is the one thing here that's never safe to cache (the
    injected values are per-request).
  - "/assets/<path>" → the hashed, content-addressed build output — safe to
    cache forever.
  - single-segment root files vite-plugin-pwa writes into `dist/` (manifest,
    the SW registration shim, the service worker itself, its workbox runtime
    chunk, the PWA icons) → served from `dist/`, revalidated every time except
    the service worker itself, which is no-store (it must never come from a
    stale cache or updates can't reach clients).

Unported tabs still render inside the SPA as same-origin iframes at
`/tab/<name>` — that route is untouched, owned by routes/shell.py.
"""
import json
from pathlib import Path

from flask import request, make_response, send_from_directory, abort

from routes.settings import load_theme
from routes.shell import _load_public_intro_html

DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
ASSETS_DIR = DIST_DIR / "assets"
INDEX_PATH = DIST_DIR / "index.html"

# Extensions vite-plugin-pwa writes as loose files directly under dist/ (as
# opposed to the hashed dist/assets/ bundle). Anything else at a single path
# segment 404s same as before this route existed.
_ROOT_FILE_EXTS = {".js", ".webmanifest", ".png", ".svg", ".ico"}


def _spa_response():
    """Render frontend/dist/index.html with the shell's boot globals injected.

    Reads the view mode off `request.view_mode` (set by server.py's
    before_request gate in production) via getattr so a bare test app — which
    has no such gate — still renders (defaulting to "authed"), same pattern
    routes/shell.py's _split_response uses.
    """
    view_mode = getattr(request, "view_mode", "authed")
    # "</" escaped so no value can close the injected <script> tag early
    theme_json = json.dumps(load_theme()).replace("</", "<\\/")
    intro_json = (
        json.dumps(_load_public_intro_html()).replace("</", "<\\/")
        if view_mode == "public"
        else "null"
    )
    injected = (
        "<script>"
        f"window.THEME_OVERRIDES = {theme_json};"
        f'window.VIEW_MODE = "{view_mode}";'
        f"window.PUBLIC_INTRO_HTML = {intro_json};"
        "</script></head>"
    )
    html = INDEX_PATH.read_text().replace("</head>", injected, 1)
    resp = make_response(html)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def register(app):

    @app.route("/")
    @app.route("/todos")
    @app.route("/legacy/<tab>")
    @app.route("/journal")
    @app.route("/research")
    @app.route("/settings")
    @app.route("/files")
    def spa_shell(tab=None):
        return _spa_response()

    @app.route("/assets/<path:filename>")
    def spa_asset(filename):
        resp = make_response(send_from_directory(ASSETS_DIR, filename))
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    @app.route("/<filename>")
    def spa_root_file(filename):
        path = DIST_DIR / filename
        if not path.is_file() or path.suffix not in _ROOT_FILE_EXTS:
            abort(404)
        resp = make_response(send_from_directory(DIST_DIR, filename))
        resp.headers["Cache-Control"] = "no-store" if filename == "sw.js" else "no-cache"
        return resp
