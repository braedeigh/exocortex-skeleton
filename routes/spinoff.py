"""Spinoff — the shared spawn door for /spinoff.

A skill in any Claude session writes a brief to SPINOFF_DIR/<slug>/BRIEF.md and
calls this; it mints a Reading Room conversation (routes/reading_room.py)
config'd as a builder session with the kickoff carried on the entry AND flagged
`autostart`, so the session fires its own kickoff the moment she opens it in the
Reading Room — no manual send. (The kickoff still rides in `draft` as the text
carrier; `autostart` is what turns "prefill the compose box and wait" into "send
it automatically" — see the Reading Room's history-load effect and the
draft/autostart consume in _send_to_conversation.) The brief travels by FILE,
never typed/shell-interpolated anywhere — only the fixed, short kickoff sentence
below is ever staged.

Why the flag and not a server-side spawn: the durable turn lives in the gunicorn
worker (detached thread + _running_procs + SSE), which the standalone
scripts/spinoff_open.py CLI door can't host. Marking the entry and letting the
Reading Room fire the existing send path auto-starts a spinoff from EITHER door
(route or CLI) without new subprocess/auth machinery, and never spawns claude
unattended — it fires when she's actually in the room.
"""
import os
import re
from pathlib import Path

from flask import jsonify, request

import store
from routes.reading_room import _BUILDER_TOOLS, _chats_dir, _new_conv_id, _now

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")

# The skeleton checkout root (this file lives in routes/, so its parent's
# parent is the checkout) — override via env for a non-standard layout.
DEFAULT_SPINOFF_CWD = Path(__file__).resolve().parents[1]


def open_spinoff(slug):
    """Core shared by the route and scripts/spinoff_open.py (the agents' door).

    Mints (or rejoins) a Reading Room conversation for the spinoff, with the
    kickoff staged as a draft rather than sent — a re-invocation against a
    spinoff that already has a live (non-archived) conversation is a rejoin,
    not a restart, and leaves that conversation untouched.
    """
    if not SLUG_RE.match(slug or ""):
        return {"error": "bad slug"}, 400

    brief = store.SPINOFF_DIR / slug / "BRIEF.md"
    if not brief.exists():
        return {"error": f"no brief at {brief}"}, 400

    _chats_dir()   # the index (and its .lock) lives inside it
    with store.mutate("bot_chats/index", {}) as index:
        existing = next(
            (cid for cid, entry in index.items()
             if isinstance(entry, dict) and entry.get("spinoff_slug") == slug
             and not entry.get("archived")),
            None)
        if existing:
            return {"ok": True, "conversation_id": existing,
                    "newly_spawned": False, "brief": str(brief)}, 200

        cwd = Path(os.environ.get("EXOCORTEX_SPINOFF_CWD", DEFAULT_SPINOFF_CWD))
        kickoff = (f"Read {brief} and follow its Protocol section exactly — "
                   "it defines this session's job.")
        conv_id = _new_conv_id(index)
        index[conv_id] = {
            "bot": "keeper", "spinoff_slug": slug, "title": f"spin: {slug}",
            "started": _now(), "last_at": _now(), "claude_session_id": None,
            "cost_usd": 0.0, "journal": False, "cwd": str(cwd),
            "allowed_tools": list(_BUILDER_TOOLS), "draft": kickoff,
            "autostart": True,
        }

    return {
        "ok": True,
        "conversation_id": conv_id,
        "newly_spawned": True,
        "staged": True,
        "autostart": True,
        "brief": str(brief),
    }, 200


def register(app):

    @app.route("/api/spinoff/open", methods=["POST"])
    def spinoff_open():
        payload, status = open_spinoff((request.json or {}).get("slug", ""))
        return jsonify(payload), status
