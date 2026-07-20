"""The owner profile — first entry point of the planned setup flow.

GET/PUT /api/profile is the form door; the pending-changes queue's "profile"
kind (routes/pending.py) is the conversational door — both write through
`apply_profile_update`, the one merge implementation, so there is exactly one
writer of profile.json. Schema validation (schemas/profile.json) fires at the
store.mutate() write seam, same as everywhere else — this module never
pre-validates.
"""
from flask import jsonify, request

import store
from config import get_profile

PROFILE_FILE = "profile"  # -> data/profile.json


def apply_profile_update(updates: dict) -> None:
    """Merge a partial profile dict over the stored file.

    Only keys present in `updates` change. A key explicitly set to "" clears
    it back to inherited (env var / default) — see config.get_profile()'s
    "empty stored value means unset" rule. Used by both PUT /api/profile and
    the pending queue's "profile" kind (routes/pending.py's _commit).
    """
    with store.mutate(PROFILE_FILE, {}) as data:
        for key in ("owner_name", "owner_email", "app_name"):
            if key in updates:
                data[key] = updates[key]


def _profile_response():
    return jsonify({"profile": get_profile(), "stored": store.read(PROFILE_FILE, {})})


def register(app):
    @app.route("/api/profile", methods=["GET"])
    def get_profile_route():
        return _profile_response()

    @app.route("/api/profile", methods=["PUT"])
    def put_profile_route():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "body must be a JSON object"}), 400
        apply_profile_update(body)
        return _profile_response()
