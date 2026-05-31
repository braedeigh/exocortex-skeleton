"""Theme settings routes — sky-theme keyframe and phase rule customization."""
from flask import request, jsonify
import store


def load_theme():
    try:
        return store.read("theme_settings.json", {})
    except Exception:
        return {}


def save_theme(data):
    store.write("theme_settings.json", data)


def register(app):

    @app.route("/api/theme/get")
    def theme_get():
        return jsonify(load_theme())

    @app.route("/api/theme/save", methods=["POST"])
    def theme_save():
        data = request.json or {}
        # Whitelist top-level keys so junk doesn't accumulate
        allowed = {"themes", "offsets", "phasesEnabled", "accents", "enabled"}
        clean = {k: v for k, v in data.items() if k in allowed}
        save_theme(clean)
        return jsonify({"ok": True})

    @app.route("/api/theme/reset", methods=["POST"])
    def theme_reset():
        save_theme({})
        return jsonify({"ok": True})
