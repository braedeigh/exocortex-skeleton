"""sudo.py — the owner's side of agents' sudo requests (sudo_requests.py).

Plain English: agents file requests to have a fixed, listed command run as root
(scripts/sudo_request.py); these endpoints let the page show them and let her
approve one by typing her password, or turn it down.

    GET  /api/sudo/requests                 open requests + the last few closed
    POST /api/sudo/requests/<id>/approve    {"password": "..."} — runs it
    POST /api/sudo/requests/<id>/deny

Approve answers with {"status": ...}: "done" and "failed" close the request and
wake the sessions that asked; "wrong_password" and "needs_password" leave it
open for another try. The password is only ever passed on to sudo's stdin —
never stored, logged, or echoed back.

Touches: sudo_requests.py (all the logic), frontend/src/features/sudo/ (the
roster box and the bottom popup).
"""
from flask import jsonify, request

import sudo_requests


def _authed():
    # The /api gate already turns away anyone not logged in; checked again here
    # so these can never become reachable through a public-path change.
    return getattr(request, "view_mode", "authed") == "authed"


def register(app):

    @app.route("/api/sudo/requests", methods=["GET"])
    def sudo_requests_list():
        if not _authed():
            return jsonify({"error": "unauthorized"}), 401
        return jsonify(sudo_requests.listing())

    @app.route("/api/sudo/requests/<req_id>/approve", methods=["POST"])
    def sudo_request_approve(req_id):
        if not _authed():
            return jsonify({"error": "unauthorized"}), 401
        body = request.get_json(silent=True) or {}
        password = body.get("password") or ""
        if not isinstance(password, str):
            return jsonify({"error": "password must be text"}), 400
        try:
            return jsonify(sudo_requests.approve(req_id, password))
        except KeyError:
            return jsonify({"error": "no such request"}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 409

    @app.route("/api/sudo/requests/<req_id>/deny", methods=["POST"])
    def sudo_request_deny(req_id):
        if not _authed():
            return jsonify({"error": "unauthorized"}), 401
        try:
            sudo_requests.deny(req_id)
        except KeyError:
            return jsonify({"error": "no such request"}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 409
        return jsonify({"ok": True})
