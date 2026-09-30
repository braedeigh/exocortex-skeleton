"""Linear room — the Observatory lane whose sessions work in Linear with the
owner, and the door that lists them.

What this file does, in plain English. Linear is an outside issue tracker;
the owner plans and runs a project there, and Claude reaches it through the
`linear` MCP server (installed at user scope, so every session carries its
tools). The `linear` lane (routes/observatory.py's _LANES) roots a session in
store.LINEAR_ROOM_DIR — a vault folder whose CLAUDE.md says which team and
which plan, and what must never be written to an outside service — so a
session there already knows the project the way a Coding session knows the
checkout. This file is the lane's one door:

  GET /api/linear-room — every conversation in the lane, archived included,
                      newest first, each saying whether it's still running.
                      Drawn by the Linear door on the Observatory roster and
                      its page (/observatory/linear). Same shape as
                      routes/research_room.py's list, without the worker
                      fields — nothing is dispatched into this room.

Touches: routes/observatory.py (the lane profile, the running/tokens readers,
the model choices), store.LINEAR_ROOM_DIR. Callers: the frontend's LinearDoor
and LinearPage. The roster hides these sessions from the rooms (frontend
sessionFilters.roomRoster), the same way it hides research sessions.

Prompt that produced this: "add the linear MCP … we are going to be working
on my foods app together through it" — a Linear room on the Observatory.
"""
from flask import jsonify

import store

LANE = "linear"


def _room_rows(index):
    """Every Linear-lane conversation as a row for the door and the page.
    Membership is the lane, resolved — a session rooted in the room folder
    counts even if its entry never had the lane written on it."""
    from routes.observatory import _conv_lane, _effective_running, _session_tokens

    rows = []
    for cid, entry in index.items():
        if not isinstance(entry, dict) or _conv_lane(entry) != LANE:
            continue
        running = bool(entry.get("running")) and _effective_running(cid, entry)
        row = {
            "id": cid,
            "title": entry.get("title") or "",
            "started": entry.get("started") or entry.get("last_at") or "",
            "last_at": entry.get("last_at") or "",
            "running": running,
            "archived": entry.get("archived") or None,
            "last_error": entry.get("last_error") or None,
        }
        tokens = _session_tokens(cid)
        if tokens:
            row["tokens"] = tokens
        rows.append(row)
    rows.sort(key=lambda r: r["started"], reverse=True)
    return rows


def register(app):

    @app.route("/api/linear-room")
    def linear_room_list():
        """Every Linear session, archived included, newest first — plus the
        model choices, so the page's "+ New Linear session" sheet offers the
        same picker the roster does."""
        from routes.observatory import _MODEL_CHOICES

        rows = _room_rows(store.read("bot_chats/index", {}))
        return jsonify({
            "sessions": rows,
            "running": sum(1 for r in rows if r["running"]),
            "failed": sum(1 for r in rows if r["last_error"] and not r["archived"]),
            "model_choices": list(_MODEL_CHOICES),
        })
