"""Spinoff — the shared spawn door for /spinoff.

A skill in any Claude session writes a brief to SPINOFF_DIR/<slug>/BRIEF.md and
calls this; it spawns a named tmux session running Claude Code seeded with a
kickoff that points at the brief. The brief travels by FILE, never
shell-interpolated into tmux — only the fixed, short kickoff string below is
ever typed into the pane.
"""
import os
import re
from pathlib import Path

from flask import jsonify, request

import store
from .kitchen import shared

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")

# The skeleton checkout root (this file lives in routes/, so its parent's
# parent is the checkout) — override via env for a non-standard layout.
DEFAULT_SPINOFF_CWD = Path(__file__).resolve().parents[1]


def open_spinoff(slug, block=False):
    """Core shared by the route and scripts/spinoff_open.py (the agents' door).

    Returns (payload, http_status). `block=True` makes the kickoff send
    synchronous — REQUIRED for short-lived CLI callers, whose process would
    exit before send_prompt's daemon thread ever types (see shared.send_prompt).
    """
    if not SLUG_RE.match(slug or ""):
        return {"error": "bad slug"}, 400

    brief = store.SPINOFF_DIR / slug / "BRIEF.md"
    if not brief.exists():
        return {"error": f"no brief at {brief}"}, 400

    name = f"spin-{slug}"
    cwd = Path(os.environ.get("EXOCORTEX_SPINOFF_CWD", DEFAULT_SPINOFF_CWD))
    try:
        newly = shared.ensure_claude_session(name, cwd)
    except RuntimeError as e:
        return {"error": str(e)}, 503

    # Only type the kickoff into a session we just spawned — re-invoking
    # against one already live is a rejoin, not a restart.
    if newly:
        kickoff = f"Read {brief} and follow its Protocol section exactly — it defines this session's job."
        shared.send_prompt(name, kickoff, block=block)

    return {
        "ok": True,
        "session": name,
        "newly_spawned": newly,
        "brief": str(brief),
    }, 200


def register(app):

    @app.route("/api/spinoff/open", methods=["POST"])
    def spinoff_open():
        payload, status = open_spinoff((request.json or {}).get("slug", ""))
        return jsonify(payload), status
