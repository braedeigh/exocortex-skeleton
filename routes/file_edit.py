"""file_edit.py — the owner's side of editing a file in the browser (file_edits.py).

Plain English: the /code page's Edit button reads a file through here and
saves her change back; and when a session has asked her to open a file
(scripts/open_file.py), these endpoints list those requests for the orange
card and let her turn one down.

    GET  /api/file-edit?repo=&path=            the whole file + its version
    POST /api/file-edit                        {"repo","path","content","version"} — saves it
    GET  /api/file-edit/requests               open requests from sessions
    POST /api/file-edit/requests/<id>/dismiss  close one without saving

Owner only, every one: this door opens settings files the public read-only
door refuses. A refusal answers with a short reason and never with file text;
a save that finds the file changed on disk answers 409 and writes nothing.

Touches: file_edits.py (all the logic), frontend/src/features/fileedit/ (the
editor and the card), frontend/src/features/terrain/FileCodePage.tsx.
"""
from flask import jsonify, request

import file_edits


def _authed():
    # The /api gate already turns away anyone not logged in; checked again here
    # so these can never become reachable through a public-path change.
    return getattr(request, "view_mode", "authed") == "authed"


def register(app):

    @app.route("/api/file-edit", methods=["GET"])
    def file_edit_read():
        if not _authed():
            return jsonify({"error": "unauthorized"}), 401
        try:
            answer = file_edits.read((request.args.get("repo") or "").strip(),
                                     (request.args.get("path") or "").strip())
        except file_edits.Refused as refusal:
            return jsonify({"error": str(refusal)}), refusal.status
        # Never kept by the browser or anything between: this can be a settings file.
        response = jsonify(answer)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/file-edit", methods=["POST"])
    def file_edit_save():
        if not _authed():
            return jsonify({"error": "unauthorized"}), 401
        body = request.get_json(silent=True) or {}
        try:
            return jsonify(file_edits.save(str(body.get("repo") or "").strip(),
                                           str(body.get("path") or "").strip(),
                                           body.get("content"), body.get("version")))
        except file_edits.Refused as refusal:
            return jsonify({"error": str(refusal)}), refusal.status

    @app.route("/api/file-edit/requests", methods=["GET"])
    def file_edit_requests():
        if not _authed():
            return jsonify({"error": "unauthorized"}), 401
        return jsonify(file_edits.listing())

    @app.route("/api/file-edit/requests/<req_id>/dismiss", methods=["POST"])
    def file_edit_request_dismiss(req_id):
        if not _authed():
            return jsonify({"error": "unauthorized"}), 401
        try:
            file_edits.dismiss(req_id)
        except KeyError:
            return jsonify({"error": "no such request"}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 409
        return jsonify({"ok": True})
