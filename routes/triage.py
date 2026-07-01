"""Triage — a button that opens a Claude tmux session you talk to about your
todos; it reorders todos.json directly as you chat.

Reuses the recipe pipeline's session machinery (ensure_claude_session) and the
existing /phone terminal to talk — minus the parse/review-file ceremony. Triage
just reorders, live. The skill lives in TRIAGE_DIR/CLAUDE.md (the vault); this
module only spawns the session, then the frontend deep-links to /phone?session=triage.
"""
from flask import jsonify

import store
from .kitchen import shared


def register(app):

    @app.route("/api/triage/open", methods=["POST"])
    def triage_open():
        # TRIAGE_DIR/.claude/settings.json grants the session edit-acceptance +
        # the data dir in its workspace, so reordering todos.json never stalls on
        # a permission prompt in an unattended pane.
        # The tmux session is named "todo" so it shows as a "Todo" tab in the
        # terminal pane's session bar; its working dir is TRIAGE_DIR, so it boots
        # with the triage skill (CLAUDE.md) loaded.
        newly = shared.ensure_claude_session(
            "todo", store.TRIAGE_DIR, dirs=(store.TRIAGE_DIR,),
        )
        return jsonify({"ok": True, "session": "todo", "newly_spawned": newly})
