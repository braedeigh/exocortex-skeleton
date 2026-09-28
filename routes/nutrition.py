"""The nutrients page's HTTP door — her usual day added up, and the food lookup.

What this file does: it serves /food/nutrients
(frontend/src/features/nutrition/), which shows what her usual day of meals
adds up to against the daily targets, and lets her fix a meal's gram weights
and her settings. The adding-up is nutrition.py; the food lookup is fdcdb.py.
Bad input comes back as a 400 with the reason.

    GET  /api/nutrition/day            -> {report, meals, day, settings}
    GET  /api/nutrition/search?q=      -> USDA foods whose name holds every word
    POST /api/nutrition/meals/<name>   {items: [{label, fdc_id, grams, grams_guessed?}]}
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
    """A meal's items, checked: each needs a label, a USDA food id, and grams ≥ 0."""
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
        items.append({"label": label, "fdc_id": fdc_id, "grams": grams,
                      "grams_guessed": bool(item.get("grams_guessed"))})
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
