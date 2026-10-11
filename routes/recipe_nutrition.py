"""Recipe nutrients — the HTTP door onto recipe_nutrition.py.

What this file does: serves what each kitchen recipe gives against her daily
targets, and what in it she's sensitive to, for the Recipes list and a
recipe's own page (frontend/src/features/kitchen/). The working-out is
recipe_nutrition.py; the two things she can correct live in foodstore.py.

    GET  /api/recipes/nutrition          every recipe: one serving's share of
                                         each target, its sensitivity flags,
                                         and her day's gaps
    GET  /api/recipes/<id>/nutrition     one recipe line by line: USDA entry,
                                         grams and how they were found, flags,
                                         and one serving against her targets
    POST /api/recipes/<id>/grams         {line, grams|null, for_amount} — her
                                         own weight for a line (null clears it)

Which USDA entry a food is is set on the food: POST /api/food/foods/<id>/usda
(routes/food.py). Bad input comes back as a 400 with the reason. No feature
gate: her own reads, closed to visitors by server.py's auth gate.
"""
import sqlite3

from flask import jsonify, request

import foodstore
import recipe_nutrition


def _refused(message):
    return jsonify({"ok": False, "error": message}), 400


def register(app):

    @app.route("/api/recipes/nutrition")
    def recipes_nutrition():
        return jsonify(recipe_nutrition.overview())

    @app.route("/api/recipes/<recipe_id>/nutrition")
    def recipe_nutrition_one(recipe_id):
        view = recipe_nutrition.recipe(recipe_id)
        if view is None:
            return jsonify({"ok": False, "error": f"no recipe {recipe_id}"}), 404
        return jsonify(view)

    @app.route("/api/recipes/<recipe_id>/grams", methods=["POST"])
    def recipe_line_grams(recipe_id):
        # Her weight for one line; a number of grams, or null to go back to the worked-out one.
        body = request.get_json(silent=True) or {}
        line = str(body.get("line") or "").strip()
        grams = body.get("grams")
        if not line:
            return _refused("missing line")
        if grams is not None and (isinstance(grams, bool) or not isinstance(grams, (int, float))):
            return _refused("grams must be a number or null")
        try:
            foodstore.set_line_grams(recipe_id, line, grams, body.get("for_amount"))
        except (ValueError, sqlite3.IntegrityError) as exc:
            return _refused(str(exc))
        return jsonify({"ok": True})
