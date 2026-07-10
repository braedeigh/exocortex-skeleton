"""Legacy URL redirects + shared shell constants.

The old split.html app shell and its Jinja pages were retired 2026-07-09 after
the full React rewrite (frontend/ — see frontend/MIGRATION_NOTES.md). The
originals are archived at /opt/exocortex/personal/reference/old-frontend/ and
in this repo's git history. What remains here:

  - VALID_TABS — the canonical dashboard tab list (server.py re-exports it,
    public_config.py imports it).
  - The public-intro loader for the SPA's public landing (routes/spa.py
    injects its output as window.PUBLIC_INTRO_HTML).
  - Redirects that keep old bookmarks working:
      "/dashboard"            → "/dashboard/today"
      "/dashboard/<tab>"      → the native SPA tab ("/todos" for today)
      "/dashboard/research"   → "/research"
      "/car-maintenance"      → "/dashboard/car" (path differs from tab key)
      "/item/buy/<name>"      → "/inventory?buy=<name>" (native deep link)
"""
from urllib.parse import quote

from flask import redirect

from data_helpers import CONTENT_DIR

# The 14 dashboard sub-tabs. Single source of truth — server.py re-exports this
# (`server.VALID_TABS`) for the handful of other places that check tab names.
VALID_TABS = ("today", "map", "kitchen", "inventory", "money", "car", "meditation",
              "media", "movement", "body", "ideas", "ecosystem", "housing", "people")

# Legacy path -> tab key, for paths that differ from the tab key. The bare tab
# paths (/map, /kitchen, …) are native SPA routes owned by routes/spa.py.
_LEGACY_TAB_PATHS = [
    ("/car-maintenance", "car"),
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
    You edit the .md file directly; the SPA shell re-reads it per request.
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


def register(app):

    @app.route("/dashboard")
    def dashboard_bare():
        return redirect("/dashboard/today", code=302)

    @app.route("/dashboard/<tab>")
    def dashboard_tab(tab):
        if tab == "research":
            # Research graduated from dashboard tab to its own place.
            return redirect("/research", code=302)
        if tab not in VALID_TABS:
            return redirect("/dashboard/today", code=302)
        if tab == "today":
            return redirect("/todos", code=302)
        # Every tab is a native SPA route now.
        return redirect(f"/{tab}", code=302)

    def _make_legacy_redirect(tab):
        def view():
            return redirect(f"/dashboard/{tab}", code=302)
        return view

    for _path, _tab in _LEGACY_TAB_PATHS:
        app.add_url_rule(_path, endpoint=f"legacy_{_tab}", view_func=_make_legacy_redirect(_tab))

    @app.route("/item/buy/<path:name>")
    def split_item_buy(name):
        # Old deep link into the inventory buy drawer → the native equivalent.
        return redirect(f"/inventory?buy={quote(name)}", code=302)
