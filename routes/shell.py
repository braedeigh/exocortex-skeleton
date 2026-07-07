"""Shell/page routes — the split.html "app shell" and the handful of standalone
pages (personality, about, food-map) that don't carry the shell chrome.

URL scheme (post-migration):
  - "/"                     → the shell, dashboard view, "today" tab. Kept as a
                              plain render (never redirected) — it's the PWA
                              start_url and the public homepage.
  - "/dashboard"            → 302 → "/dashboard/today"
  - "/dashboard/<tab>"      → the shell, dashboard view, that tab active. Unknown
                              tabs fall back (302) to "/dashboard/today".
  - "/journal" "/files" "/settings"
                            → the shell with that view active (journal/keeper/
                              settings iframe shown in the right pane).
  - "/settings-view"        → settings.html standalone (iframe content for the
                              shell's settings view — mirrors "/journal-view").
  - legacy tab paths (/map, /kitchen, /inventory, /money, /car-maintenance,
    /meditation, /media, /movement, /body, /ideas, /ecosystem, /housing,
    /people, /research) → 302 → the matching "/dashboard/<tab>" (302, not 301:
    still iterating on the scheme, don't want browsers caching the redirect forever).
  - "/item/buy/<name>"      → the shell, dashboard view, inventory tab, with the
                              buy-item drawer open.
  - "/tab/<name>"           → iframe content for the dashboard pane (index.html).
  - "/journal-view", "/keeper" → iframe content, unchanged.
"""
from flask import request, render_template, redirect, make_response

from data_helpers import CONTENT_DIR

# The 14 dashboard sub-tabs. Single source of truth — server.py re-exports this
# (`server.VALID_TABS`) for the handful of other places that check tab names.
VALID_TABS = ("today", "map", "kitchen", "inventory", "money", "car", "meditation",
              "media", "movement", "body", "ideas", "ecosystem", "housing", "people",
              "research")

# Legacy path -> tab key. The path can differ from the tab key (car-maintenance
# -> "car"); everything here 302-redirects to "/dashboard/<tab>".
_LEGACY_TAB_PATHS = [
    ("/map", "map"),
    ("/kitchen", "kitchen"),
    ("/inventory", "inventory"),
    ("/money", "money"),
    ("/car-maintenance", "car"),
    ("/meditation", "meditation"),
    ("/media", "media"),
    ("/movement", "movement"),
    ("/body", "body"),
    ("/ideas", "ideas"),
    ("/ecosystem", "ecosystem"),
    ("/housing", "housing"),
    ("/people", "people"),
    ("/research", "research"),
]

# Path to the file that backs the public homepage fake-terminal intro.
PUBLIC_INTRO_PATH = CONTENT_DIR / "public_intro.md"


def _render_inline(s):
    """Escape HTML and convert `code` spans into cc-file styling."""
    import html as _html
    import re as _re
    s = _html.escape(s)
    return _re.sub(r"`([^`]+)`", r'<span class="cc-file">\1</span>', s)


def _load_public_intro_html():
    """Read tulku/public_intro.md and render it to HTML for the fake terminal.

    Conventions:
      - Paragraphs separated by blank lines.
      - A paragraph whose lines all start with ⎿ becomes a block of `cc-tool` lines.
      - A single-line paragraph wrapped in _..._ becomes a dim italic intro (`cc-p cc-dim`).
      - Everything else is a normal `cc-p` paragraph.
    You edit the .md file directly; template auto-reload picks it up.
    """
    if not PUBLIC_INTRO_PATH.exists():
        return ""
    text = PUBLIC_INTRO_PATH.read_text().strip()
    blocks = []
    for para in text.split("\n\n"):
        para = para.strip()
        if not para:
            continue
        lines = [ln for ln in para.split("\n") if ln.strip()]
        if lines and all(ln.strip().startswith("⎿") for ln in lines):
            rendered = []
            for ln in lines:
                body = _render_inline(ln.strip()[1:].lstrip())
                rendered.append(f'<div class="cc-tool">⎿  {body}</div>')
            blocks.append("\n".join(rendered))
        elif len(lines) == 1 and lines[0].startswith("_") and lines[0].endswith("_"):
            body = _render_inline(lines[0][1:-1])
            blocks.append(f'<p class="cc-p cc-dim">{body}</p>')
        else:
            body = _render_inline(" ".join(lines))
            blocks.append(f'<p class="cc-p">{body}</p>')
    return "\n".join(blocks)


def _split_response(active_tab, item_name="", active_view="dashboard"):
    """Render split.html (the app shell) with the given dashboard tab and
    top-level view ("dashboard" | "journal" | "files" | "settings") active.

    Reads the view mode off `request.view_mode` (set by server.py's
    before_request gate in production) via getattr so a bare test app — which
    has no such gate — still renders (defaulting to "authed").
    """
    view_mode = getattr(request, "view_mode", "authed")
    public_intro_html = _load_public_intro_html() if view_mode == "public" else ""
    resp = make_response(render_template(
        "split.html",
        active_tab=active_tab,
        item_name=item_name,
        active_view=active_view,
        view_mode=view_mode,
        public_intro_html=public_intro_html,
    ))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


def register(app):

    @app.route("/")
    def split_home():
        return _split_response("today")

    @app.route("/dashboard")
    def dashboard_bare():
        return redirect("/dashboard/today", code=302)

    @app.route("/dashboard/<tab>")
    def dashboard_tab(tab):
        if tab not in VALID_TABS:
            return redirect("/dashboard/today", code=302)
        return _split_response(tab)

    def _make_legacy_redirect(tab):
        def view():
            return redirect(f"/dashboard/{tab}", code=302)
        return view

    for _path, _tab in _LEGACY_TAB_PATHS:
        app.add_url_rule(_path, endpoint=f"legacy_{_tab}", view_func=_make_legacy_redirect(_tab))

    @app.route("/journal")
    def journal_shell():
        return _split_response("today", active_view="journal")

    @app.route("/files")
    def files_shell():
        return _split_response("today", active_view="files")

    @app.route("/settings")
    def settings_shell():
        return _split_response("today", active_view="settings")

    @app.route("/settings-view")
    def settings_view():
        return render_template("settings.html")

    @app.route("/item/buy/<path:name>")
    def split_item_buy(name):
        return _split_response("inventory", item_name=name)

    @app.route("/tab/<name>")
    def tab_view(name):
        """Iframe content endpoint — renders index.html for the given tab."""
        if name not in VALID_TABS:
            return redirect("/")
        item_name = request.args.get("item", "")
        resp = make_response(render_template("index.html", active_tab=name, item_name=item_name))
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp

    @app.route("/personality")
    def personality_page():
        return render_template("personality.html")

    @app.route("/about")
    def about_page():
        return render_template("about.html")

    @app.route("/food-map")
    def food_map_page():
        """Standalone, shareable food-sourcing map — no dashboard chrome. Public; the
        map renders read-only for visitors (no Add/Edit/Delete) and pulls its data
        from the public /api/data/ecosystem stream."""
        return render_template("food_map.html")

    @app.route("/journal-view")
    def journal_view():
        return render_template("journal.html")

    @app.route("/keeper")
    def keeper_page():
        return render_template("keeper.html")
