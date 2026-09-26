"""Food catalog routes — the HTTP seam onto foodstore.py.

Everything here is a thin call into foodstore, which holds the logic and the
plain-English explanation of the model (foods, products, the names that map to
them). The routes exist so the catalog can be edited from the app, or by a
Claude session over HTTP, rather than only by hand in Python.

    GET  /api/food/catalog            every food, its names/products/links,
                                      plus the names no food answers to yet
    POST /api/food/rebuild            re-read recipes, trips, grocery list
    POST /api/food/adopt              make a food for every unmatched name
    POST /api/food/foods              {name, kind?, category?, safety?, note?}
    POST /api/food/foods/<id>         change a food's fields
    POST /api/food/foods/<id>/names   {name} — another way it's written
    POST /api/food/merge              {keep, drop} — fold drop into keep
    POST /api/food/products           {food, name, brand?, store?, size?, receipt_text?, organic?}
    POST /api/food/products/<id>      change a product (food, name, brand, organic…)
    POST /api/food/links              {target, target_id, food? | product_id?}
    POST /api/food/links/<id>/delete
    POST /api/food/makes              {recipe_id, food|null}
    POST /api/food/rotation           {recipe_id, per_week|null, since?, note?}

Buy-organic-or-not for the grocery list (estimatestore.py):

    GET  /api/food/list-verdicts      each list item with its research verdict
                                      and Claude's estimate, plus the vocab,
                                      whether a run is going, and the last run
    POST /api/food/estimates/run      {force?} — start scripts/estimate_organic.py
    POST /api/food/estimates/<id>/review   {review: unreviewed|confirmed|disputed}

A food may be given as its id or as any name it goes by. Bad input (an unknown
food, a name another food already has, a value a CHECK refuses) comes back as
a 400 with the reason, never a 500.
"""
import os
import sqlite3
import subprocess
import sys

from flask import jsonify, request

import estimatestore
import foodstore
import store

# The estimate run, started detached so it outlives this request and worker.
_ESTIMATE_SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts", "estimate_organic.py")


def _food_ref(value):
    """A food reference from JSON: numbers are ids, anything else a name."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        return value
    text = str(value).strip()
    return int(text) if text.isdigit() else text


def _run(fn, *args, **kwargs):
    """Call foodstore and turn a refused edit into a 400 with its reason."""
    try:
        return jsonify({"ok": True, "result": fn(*args, **kwargs)})
    except (ValueError, sqlite3.IntegrityError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


def register(app):

    @app.route("/api/food/catalog")
    def food_catalog():
        return jsonify(foodstore.catalog())

    @app.route("/api/food/rebuild", methods=["POST"])
    def food_rebuild():
        return _run(foodstore.rebuild)

    @app.route("/api/food/adopt", methods=["POST"])
    def food_adopt():
        return _run(foodstore.adopt)

    @app.route("/api/food/foods", methods=["POST"])
    def food_add():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"ok": False, "error": "missing name"}), 400
        return _run(foodstore.add_food, name, kind=body.get("kind") or "food",
                    category=body.get("category"), safety=body.get("safety"),
                    note=body.get("note"))

    @app.route("/api/food/foods/<int:food_id>", methods=["POST"])
    def food_update(food_id):
        return _run(foodstore.update_food, food_id, **(request.json or {}))

    @app.route("/api/food/foods/<int:food_id>/names", methods=["POST"])
    def food_add_name(food_id):
        name = ((request.json or {}).get("name") or "").strip()
        if not name:
            return jsonify({"ok": False, "error": "missing name"}), 400
        return _run(foodstore.add_name, food_id, name)

    @app.route("/api/food/merge", methods=["POST"])
    def food_merge():
        body = request.json or {}
        return _run(foodstore.merge, _food_ref(body.get("keep")), _food_ref(body.get("drop")))

    @app.route("/api/food/products", methods=["POST"])
    def food_add_product():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"ok": False, "error": "missing name"}), 400
        return _run(foodstore.add_product, _food_ref(body.get("food")), name,
                    brand=body.get("brand"), store_name=body.get("store"),
                    size=body.get("size"), note=body.get("note"),
                    receipt_text=body.get("receipt_text"), organic=body.get("organic"))

    @app.route("/api/food/products/<int:product_id>", methods=["POST"])
    def food_update_product(product_id):
        body = dict(request.json or {})
        if "food" in body:
            body["food"] = _food_ref(body["food"])
        return _run(foodstore.update_product, product_id, **body)

    @app.route("/api/food/links", methods=["POST"])
    def food_link():
        body = request.json or {}
        if not body.get("target") or not body.get("target_id"):
            return jsonify({"ok": False, "error": "missing target or target_id"}), 400
        return _run(foodstore.link, body["target"], body["target_id"],
                    food=_food_ref(body.get("food")), product_id=body.get("product_id"),
                    note=body.get("note"))

    @app.route("/api/food/links/<int:link_id>/delete", methods=["POST"])
    def food_unlink(link_id):
        return _run(foodstore.unlink, link_id)

    @app.route("/api/food/makes", methods=["POST"])
    def food_makes():
        body = request.json or {}
        if not body.get("recipe_id"):
            return jsonify({"ok": False, "error": "missing recipe_id"}), 400
        return _run(foodstore.set_makes, body["recipe_id"], _food_ref(body.get("food")))

    @app.route("/api/food/rotation", methods=["POST"])
    def food_rotation():
        body = request.json or {}
        if not body.get("recipe_id"):
            return jsonify({"ok": False, "error": "missing recipe_id"}), 400
        return _run(foodstore.set_rotation, body["recipe_id"],
                    per_week=body.get("per_week", 1), since=body.get("since"),
                    note=body.get("note"))

    # The grocery list's buy-organic chips: what's known per item, and the
    # words to show it in.
    @app.route("/api/food/list-verdicts")
    def food_list_verdicts():
        view = estimatestore.list_view()
        view.update(vocab=estimatestore.vocab(), running=estimatestore.running(),
                    last_run=estimatestore.last_run())
        return jsonify(view)

    # Start an estimate run for the list items with none yet. Launched in its
    # own session, the same way routes/spinoff.py launches its runner, and
    # refused while one is already going.
    @app.route("/api/food/estimates/run", methods=["POST"])
    def food_estimates_run():
        if estimatestore.running():
            return jsonify({"ok": False, "error": "an estimate run is already going"}), 409
        command = [sys.executable, _ESTIMATE_SCRIPT]
        if (request.json or {}).get("force"):
            command.append("--force")
        with open(store.DATA_DIR / "estimate_organic.log", "ab") as log:
            subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             env=dict(os.environ, EXOCORTEX_DATA_DIR=str(store.DATA_DIR)),
                             start_new_session=True)
        return jsonify({"ok": True})

    @app.route("/api/food/estimates/<int:estimate_id>/review", methods=["POST"])
    def food_estimate_review(estimate_id):
        return _run(estimatestore.review, estimate_id, (request.json or {}).get("review"))
