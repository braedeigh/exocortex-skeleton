"""The React SPA shell — serves `frontend/dist/` and replaces split.html as the
front door ("/") of the site. See `routes/shell.py` for the old shell, kept
reachable at "/classic" as a rollback path, and the design doc this implements
(`react-shell-design.md`).

URL scheme:
  - "/" and every SPA route ("/todos", "/legacy/<tab>", "/journal", "/research",
    "/settings", "/files", "/chat") → `frontend/dist/index.html`, with `window.THEME_OVERRIDES`,
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

Every page is native now (2026-07-09) — the strangler-fig `/tab/<name>`
iframes and the `/classic` rollback shell are gone with the legacy frontend
(archived in the owner's vault at reference/old-frontend/). `/legacy/<tab>`
survives only as a redirect for old bookmarks.
"""
import json
from pathlib import Path

from flask import request, make_response, send_from_directory, abort

import config
from routes.settings import load_theme
from routes.shell import _load_public_intro_html

DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"

# Tabs with a native SPA route at /<tab> (today lives at /todos).
_NATIVE_TABS = frozenset(
    ("map", "kitchen", "inventory", "money", "car", "meditation", "media",
     "movement", "body", "ideas", "ecosystem", "housing", "people", "travel")
)
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
    profile = config.get_profile()
    meta_json = json.dumps(
        {"name": profile["app_name"], "owner": profile["owner_name"], "version": config.APP_VERSION}
    ).replace("</", "<\\/")
    injected = (
        "<script>"
        f"window.THEME_OVERRIDES = {theme_json};"
        f'window.VIEW_MODE = "{view_mode}";'
        f"window.PUBLIC_INTRO_HTML = {intro_json};"
        f"window.APP_META = {meta_json};"
        "</script></head>"
    )
    html = INDEX_PATH.read_text().replace("</head>", injected, 1)
    resp = make_response(html)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def register(app):

    @app.route("/")
    @app.route("/todos")
    @app.route("/todos/editor")
    @app.route("/journal")
    @app.route("/research")
    @app.route("/wiki")
    @app.route("/wiki/<slug>")
    @app.route("/threads")
    @app.route("/threads/<slug>")
    @app.route("/settings")
    @app.route("/files")
    @app.route("/chat")
    @app.route("/notes")
    @app.route("/recordings")
    # The observatory (renamed from "bots" 07-24 — the persona concept
    # keeps the name "bot" everywhere; only this surface's URL changed).
    # /bots/* stays reachable too, for old bookmarks and cached PWA clients.
    @app.route("/observatory")
    @app.route("/observatory/<path:rest>")
    @app.route("/bots")
    @app.route("/bots/<path:rest>")
    # Native dashboard tabs (ported from /tab/<name>):
    @app.route("/map")
    @app.route("/kitchen")
    @app.route("/inventory")
    @app.route("/money")
    @app.route("/car")
    @app.route("/meditation")
    @app.route("/media")
    @app.route("/movement")
    @app.route("/body")
    @app.route("/ideas")
    @app.route("/ecosystem")
    @app.route("/housing")
    @app.route("/people")
    @app.route("/travel")
    # Native standalone pages (ported from their Flask templates):
    @app.route("/person/<slug>")
    @app.route("/personality")
    @app.route("/scratchpad")
    @app.route("/vscode")
    @app.route("/food-map")
    @app.route("/about")
    # Session-visualization surfaces (born native, no Flask ancestor):
    @app.route("/terrain")
    # ...and the rooms inside it (/terrain/usage, /terrain/sql). These are
    # CHILD routes in the SPA, so without this the shell only ever reached them
    # through client-side navigation — a refresh or a pasted link 404'd.
    @app.route("/terrain/<path:rest>")
    # The database's own page: the collection map, the read-only console and
    # the sandbox. Also reachable as a room inside /terrain.
    @app.route("/sql")
    # One file, read-only (?repo=&path=) — where the observatory's session
    # cards send a tapped file, so it opens in the split's right pane.
    @app.route("/code")
    @app.route("/atlas")
    @app.route("/sessions")
    @app.route("/automations")
    # What the agents built and she hasn't taken (routes/branches.py).
    @app.route("/branches")
    def spa_shell(tab=None, slug=None, rest=None):
        return _spa_response()

    @app.route("/legacy/<tab>")
    def spa_legacy_tab(tab):
        # The strangler-fig iframe route is gone — every tab is native now.
        # Keep old /legacy/<tab> bookmarks working.
        from flask import redirect

        target = f"/{tab}" if tab in _NATIVE_TABS else "/todos"
        return redirect(target, code=302)

    @app.route("/index.html")
    def spa_index_file():
        # The service worker precaches "index.html" verbatim (vite-plugin-pwa
        # computes its revision hash from the raw build output), so this must
        # serve the un-injected dist file — and must exist: if it 404s, every
        # SW update fails to install and clients keep their stale service
        # worker (and its cached shell) forever.
        resp = make_response(send_from_directory(DIST_DIR, "index.html"))
        resp.headers["Cache-Control"] = "no-cache"
        return resp

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
