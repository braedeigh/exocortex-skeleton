"""The nutrients page's HTTP door — her usual day added up, and the food lookup.

What this file does: it serves /food/nutrients
(frontend/src/features/nutrition/), which shows what her usual day of meals
adds up to against the daily targets, and lets her fix a meal's gram weights
and her settings. The adding-up is nutrition.py; the food lookup is fdcdb.py.
Bad input comes back as a 400 with the reason.

    GET  /api/nutrition/day            -> {report, meals, day, settings}
    GET  /api/nutrition/search?q=      -> USDA foods whose name holds every word
    GET  /api/nutrition/rank/<key>?per=100g|100kcal&q=&limit=
                                       -> every USDA food ranked by that nutrient, richest first
    POST /api/nutrition/meals/<name>   {items: [{label, fdc_id, grams, grams_guessed?, fill_from?}]}
                                       (a new name makes a new meal)
    DELETE /api/nutrition/meals/<name> -> the meal gone, and out of her day
    POST /api/nutrition/servings/<name> {servings: n ≥ 0} — how many a day; 0 = not counted
    POST /api/nutrition/settings       {sex?: female|male|both, age?: int}

No feature gate: these are her own reads, and server.py's auth gate closes
them to visitors. Design: docs/nutrition.md.

Prompt that produced this file: "make my own kind of like, Cronometer so I can
plug in my diet and see how to optimize it for my health overall."
"""
from flask import jsonify, request

import fdcdb
import nutrition
import store


def _refused(message):
    return jsonify({"error": message}), 400


def _clean_items(raw):
    """A meal's items, checked: each needs a label, a USDA food id, and grams ≥ 0.

    An optional fill_from (a second USDA food id, for the nutrients the first
    lacks) is kept when it's a number.
    """
    if not isinstance(raw, list):
        raise ValueError("items must be a list")
    items = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("each item must be an object")
        label = str(item.get("label") or "").strip()
        try:
            fdc_id = int(item.get("fdc_id"))
            grams = float(item.get("grams"))
        except (TypeError, ValueError):
            raise ValueError(f"{label or 'an item'}: fdc_id and grams must be numbers")
        if not label or grams < 0:
            raise ValueError(f"{label or 'an item'}: needs a label and grams of 0 or more")
        clean = {"label": label, "fdc_id": fdc_id, "grams": grams,
                 "grams_guessed": bool(item.get("grams_guessed"))}
        if str(item.get("fill_from") or "").isdigit():
            clean["fill_from"] = int(item["fill_from"])
        items.append(clean)
    return items


def register(app):

    @app.route("/api/nutrition/day")
    def nutrition_day():
        data = nutrition.meals()
        with fdcdb.session() as conn:
            report = nutrition.report(conn, nutrition.day_items(data))
        return jsonify({"report": report, "meals": data["meals"], "day": data["day"],
                        "settings": nutrition.settings()})

    @app.route("/api/nutrition/search")
    def nutrition_search():
        with fdcdb.session() as conn:
            return jsonify({"foods": fdcdb.search(conn, request.args.get("q") or "")})

    @app.route("/api/nutrition/rank/<key>")
    def nutrition_rank(key):
        try:
            limit = min(max(int(request.args.get("limit") or 50), 1), 500)
        except ValueError:
            return _refused("limit must be a whole number")
        try:
            with fdcdb.session() as conn:
                return jsonify(nutrition.ranking(conn, key, request.args.get("per") or "100g",
                                                 request.args.get("q") or "", limit))
        except ValueError as exc:
            return _refused(str(exc))

    @app.route("/api/nutrition/meals/<name>", methods=["POST"])
    def nutrition_meal(name):
        body = request.get_json(silent=True) or {}
        try:
            items = _clean_items(body.get("items"))
        except ValueError as exc:
            return _refused(str(exc))
        # Replace this one meal's items, keeping its note and every other meal.
        with store.mutate(nutrition.MEALS, {}) as data:
            meal = data.setdefault("meals", {}).setdefault(name, {})
            meal["items"] = items
        return jsonify({"ok": True, "meal": meal})

    @app.route("/api/nutrition/meals/<name>", methods=["DELETE"])
    def nutrition_meal_delete(name):
        # Delete a meal, and take it out of her usual day with it.
        with store.mutate(nutrition.MEALS, {}) as data:
            if name not in (data.get("meals") or {}):
                return _refused(f"no meal called {name}")
            del data["meals"][name]
            data["day"] = [slot for slot in data.get("day") or [] if slot.get("meal") != name]
        return jsonify({"ok": True})

    @app.route("/api/nutrition/servings/<name>", methods=["POST"])
    def nutrition_servings(name):
        # Set how many of a meal she eats a day. The day keeps its order; a meal
        # newly counted joins the end, and 0 takes it out of the day (the meal stays saved).
        body = request.get_json(silent=True) or {}
        servings = body.get("servings")
        if isinstance(servings, bool) or not isinstance(servings, (int, float)) or not 0 <= servings <= 20:
            return _refused("servings must be a number from 0 to 20")
        with store.mutate(nutrition.MEALS, {}) as data:
            if name not in (data.get("meals") or {}):
                return _refused(f"no meal called {name}")
            day = [slot for slot in data.get("day") or []]
            slot = next((slot for slot in day if slot.get("meal") == name), None)
            if servings == 0:
                day = [other for other in day if other is not slot]
            elif slot:
                slot["servings"] = servings
            else:
                day.append({"meal": name, "servings": servings})
            data["day"] = day
        return jsonify({"ok": True, "day": day})

    @app.route("/api/nutrition/settings", methods=["POST"])
    def nutrition_settings():
        body = request.get_json(silent=True) or {}
        if "sex" in body and body["sex"] not in ("female", "male", "both"):
            return _refused("sex must be female, male or both")
        if "age" in body and not (isinstance(body["age"], int) and 19 <= body["age"] <= 120):
            return _refused("age must be a whole number from 19 up")
        with store.mutate(nutrition.SETTINGS, {}) as data:
            data.update({key: body[key] for key in ("sex", "age") if key in body})
        return jsonify({"ok": True, "settings": nutrition.settings()})
