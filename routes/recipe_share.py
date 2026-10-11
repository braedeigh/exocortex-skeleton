"""Shared recipes — the HTTP door onto recipe_shares.py.

What this file does: lets her share a recipe (and stop), and serves a shared
recipe — and the list of all of them — to anyone holding the link, worked out
against the age and sex *they* type. The rules about what a visitor may see
are in recipe_shares.py.

Hers (closed to visitors by server.py's auth gate):
    GET  /api/recipes/shares             her open shares: {recipe_id: {token, views}}
    POST /api/recipes/<id>/share         share it: {token, path}
    POST /api/recipes/<id>/unshare       stop: every link to it dies

Anyone's (open: /api/share/ is in public_config.PUBLIC_PATHS):
    GET  /api/share/recipes?sex=&age=    popular: every shared recipe, most opened first
    GET  /api/share/r/<token>?sex=&age=&count=1
                                         one shared recipe; count=1 on the first open
                                         counts a view. 404 once she stops sharing.

`sex` is female / male / both; `age` a whole number of years, 1–120. Anything
else is ignored rather than refused, so a half-typed age still shows the
recipe (without targets).
"""
from flask import jsonify, request

import recipe_shares


def _visitor():
    """The visitor's own sex and age, from the query; unreadable ones become None."""
    sex = request.args.get("sex")
    sex = sex if sex in ("female", "male", "both") else None
    age = request.args.get("age", "")
    age = int(age) if age.isdigit() and 1 <= int(age) <= 120 else None
    return sex, age


def register(app):

    @app.route("/api/recipes/shares")
    def recipe_shares_mine():
        return jsonify(recipe_shares.mine())

    @app.route("/api/recipes/<recipe_id>/share", methods=["POST"])
    def recipe_share(recipe_id):
        try:
            token = recipe_shares.share(recipe_id)
        except KeyError:
            return jsonify({"ok": False, "error": f"no recipe {recipe_id}"}), 404
        return jsonify({"ok": True, "token": token, "path": f"/share/r/{token}"})

    @app.route("/api/recipes/<recipe_id>/unshare", methods=["POST"])
    def recipe_unshare(recipe_id):
        return jsonify({"ok": True, "closed": recipe_shares.unshare(recipe_id)})

    @app.route("/api/share/recipes")
    def shared_recipes():
        sex, age = _visitor()
        return jsonify(recipe_shares.popular(sex, age))

    @app.route("/api/share/r/<token>")
    def shared_recipe(token):
        sex, age = _visitor()
        view = recipe_shares.open_shared(token, sex, age, count=request.args.get("count") == "1")
        if view is None:
            return jsonify({"ok": False, "error": "This link isn't shared any more."}), 404
        return jsonify(view)
