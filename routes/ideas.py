"""The ideas vision doc (store.IDEAS_FILE) — raw content in, raw content out.

The doc is one markdown file owned by the user (her + the Keeper's vision
scratchpad). The Ideas dashboard tab renders it as collapsible section cards
(static/js/ideas.js) and edits it through these routes. Quick idea *entries*
are a separate store — see routes/devnotes.py (idea_notes.json).
"""
from flask import request, jsonify

import store


def register(app):

    @app.route("/api/ideas")
    def ideas_get():
        ideas = store.IDEAS_FILE
        content = ideas.read_text() if ideas.exists() else ""
        return jsonify({"content": content})

    @app.route("/api/ideas", methods=["POST"])
    def ideas_save():
        data = request.json or {}
        content = data.get("content")
        if not isinstance(content, str):
            return jsonify({"error": "content (string) required"}), 400
        # Refuse a save that would wipe the doc — an empty editor is far more
        # likely a glitched load than an intentional erase of the whole vision.
        if not content.strip() and store.IDEAS_FILE.exists() and store.IDEAS_FILE.read_text().strip():
            return jsonify({"error": "refusing to overwrite the ideas doc with nothing"}), 400
        store.IDEAS_FILE.parent.mkdir(parents=True, exist_ok=True)
        store.IDEAS_FILE.write_text(content)
        return jsonify({"ok": True})
