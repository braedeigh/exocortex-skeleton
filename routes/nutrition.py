"""The nutrients page's HTTP door — her usual day added up, and the food lookup.

What this file does: it serves /food/nutrients
(frontend/src/features/nutrition/), which shows what her usual day of meals
adds up to against the daily targets, and lets her fix a meal's gram weights
and her settings. The adding-up is nutrition.py; the food lookup is fdcdb.py.
Bad input comes back as a 400 with the reason.

    GET  /api/nutrition/day            -> {report, meals, day, settings, storage}: storage maps each
                                          nutrient to whether the body stores it (nutrient_storage.py)
    GET  /api/nutrition/search?q=      -> USDA foods whose name holds every word
    GET  /api/nutrition/packaged?q=    -> packaged products (USDA Branded Foods, the makers' labels) by
                                          name or brand; a q of 8+ digits (typed or scanned) is a barcode.
                                          Her own label-photo products (label_products.py) come first
    POST /api/nutrition/labels         multipart photo(s) [+ barcode] -> {job}: the photos saved and a helper
                                          Claude session sent to read them (label_products.reading_brief)
    GET  /api/nutrition/labels/<job>   -> {status: reading|ready|failed|missing, draft?, error?}
    GET  /api/nutrition/labels/<name>/photo -> the photo itself, to check the figures against
    POST /api/nutrition/label-products {draft, photo} -> {food}: a checked draft saved as a product
    GET  /api/nutrition/label-products/<n>/photo -> product -n's label photo (its food name links here)
    GET  /api/nutrition/rank/<key>?per=100g|100kcal&q=&limit=&histamine=low
                                       -> every USDA food ranked by that nutrient, richest first,
                                          each rated against the SIGHI low-histamine list (histamine.py);
                                          histamine=low keeps only the foods SIGHI rates 0
    GET  /api/nutrition/nutrient/<key> -> {row, sexes, facts, storage}: her day's total for one nutrient,
                                          the NIH ODS fact sheet's own words (nutrient_facts.py), and
                                          what the sheet says about the body storing it (nutrient_storage.py)
    GET  /api/nutrition/plan?cap=&kcal= -> the fewest grams of her starred foods (every day, or some days a week for
                                          the nutrients the body stores) that close her
                                          day's gaps (nutrition.plan_additions): cap = most grams of any
                                          one food (default 100), kcal = most calories to add (optional)
    GET  /api/nutrition/measures?ids=  -> {measures: {fdc_id: [{unit, label, grams, kind, source, url}]}}:
                                          grams in one cup / tbsp / egg… of each food (measures.py)
    GET  /api/nutrition/highlights     -> the foods she's starred as interested in eating
    POST /api/nutrition/highlights/<fdc_id> {on: bool, description} — star / unstar one
    POST /api/nutrition/meals/<name>   {items: [{label, fdc_id, grams, grams_guessed?, fill_from?, measure?}]}
                                       (a new name makes a new meal)
    DELETE /api/nutrition/meals/<name> -> the meal gone, and out of her day
    POST /api/nutrition/servings/<name> {servings: n ≥ 0} — how many a day; 0 = not counted
    POST /api/nutrition/settings       {sex?: female|male|both, age?: int}

No feature gate: these are her own reads, and server.py's auth gate closes
them to visitors. Design: docs/nutrition.md.

Prompt that produced this file: "make my own kind of like, Cronometer so I can
plug in my diet and see how to optimize it for my health overall."
"""
from datetime import datetime
from pathlib import Path

from flask import jsonify, request, send_from_directory

import fdcdb
import histamine
import label_products
import measures
import nutrient_facts
import nutrient_storage
import nutrition
import store
from routes import helpers
from routes.kitchen import shared


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
        # Keep how she typed the amount ("1.5 cup"), so the page can show it back; grams stay the truth.
        measure = str(item.get("measure") or "").strip()
        if measure:
            clean["measure"] = measure[:40]
        items.append(clean)
    return items


def register(app):

    @app.route("/api/nutrition/day")
    def nutrition_day():
        data = nutrition.meals()
        with fdcdb.session() as conn:
            report = nutrition.report(conn, nutrition.day_items(data))
        storage = {row["key"]: {"kind": nutrient_storage.kind(row["key"]),
                                "label": nutrient_storage.LABELS[nutrient_storage.kind(row["key"])]}
                   for row in report["nutrients"]}
        return jsonify({"report": report, "meals": data["meals"], "day": data["day"],
                        "settings": nutrition.settings(), "storage": storage})

    @app.route("/api/nutrition/search")
    def nutrition_search():
        # ?single=1 keeps single foods only (nutrition.is_single_food), searched past the first page.
        single = request.args.get("single") == "1"
        with fdcdb.session() as conn:
            foods = fdcdb.search(conn, request.args.get("q") or "", limit=500 if single else 20)
        if single:
            foods = [food for food in foods if nutrition.is_single_food(food)][:20]
        return jsonify({"foods": foods})

    @app.route("/api/nutrition/rank/<key>")
    def nutrition_rank(key):
        try:
            limit = min(max(int(request.args.get("limit") or 50), 1), 500)
        except ValueError:
            return _refused("limit must be a whole number")
        # Rate every food against the SIGHI list; ?histamine=low keeps only its 0s,
        # and ?single=1 only single foods (nutrition.is_single_food).
        names = histamine.names()
        low_only = request.args.get("histamine") == "low"
        single = request.args.get("single") == "1"

        def keep(food):
            if single and not nutrition.is_single_food(food):
                return False
            food["histamine"] = histamine.rate(names, food["description"])
            return not low_only or (food["histamine"] or {}).get("verdict") == "low"
        try:
            with fdcdb.session() as conn:
                result = nutrition.ranking(conn, key, request.args.get("per") or "100g",
                                           request.args.get("q") or "", limit, keep=keep)
        except ValueError as exc:
            return _refused(str(exc))
        return jsonify(dict(result, histamine_source=dict(histamine.SOURCE, loaded=bool(names))))

    @app.route("/api/nutrition/nutrient/<key>")
    def nutrition_nutrient(key):
        # One nutrient's own page: her day's total for it, and what ODS says about it.
        if key not in {k for k, _, _ in nutrition.TRACKED}:
            return _refused(f"unknown nutrient {key}")
        data = nutrition.meals()
        with fdcdb.session() as conn:
            report = nutrition.report(conn, nutrition.day_items(data))
        row = next(row for row in report["nutrients"] if row["key"] == key)
        return jsonify({"row": row, "sexes": report["sexes"], "facts": nutrient_facts.facts(key),
                        "storage": nutrient_storage.storage(key)})

    @app.route("/api/nutrition/plan")
    def nutrition_plan():
        # What to add: her starred foods are the only ones the calculator may use.
        try:
            cap = float(request.args.get("cap") or 100)
            kcal = float(request.args["kcal"]) if request.args.get("kcal") else None
        except ValueError:
            return _refused("cap and kcal must be numbers")
        if not 0 < cap <= 2000 or (kcal is not None and kcal < 0):
            return _refused("cap must be between 0 and 2000 g, kcal 0 or more")
        candidates = [{"fdc_id": food["fdc_id"], "label": food["description"]} for food in nutrition.highlights()]
        with fdcdb.session() as conn:
            try:
                plan = nutrition.plan_additions(conn, nutrition.day_items(), candidates,
                                                cap_grams=cap, energy_cap=kcal)
            except ValueError as exc:
                return _refused(str(exc))
        return jsonify(plan)

    @app.route("/api/nutrition/measures")
    def nutrition_measures():
        # Grams in a cup, tablespoon, egg… of each food, from USDA's portions (measures.py).
        try:
            ids = [int(part) for part in (request.args.get("ids") or "").split(",") if part.strip()][:100]
        except ValueError:
            return _refused("ids must be USDA food ids, comma-separated")
        with fdcdb.session() as conn:
            found = measures.for_foods(conn, ids)
        return jsonify({"measures": {str(fdc_id): rows for fdc_id, rows in found.items()}})

    @app.route("/api/nutrition/highlights")
    def nutrition_highlights():
        return jsonify({"foods": nutrition.highlights()})

    @app.route("/api/nutrition/highlights/<int:fdc_id>", methods=["POST"])
    def nutrition_highlight(fdc_id):
        # Star or unstar a food she's interested in eating; {on: bool, description}.
        body = request.get_json(silent=True) or {}
        description = str(body.get("description") or "").strip()
        if not isinstance(body.get("on"), bool):
            return _refused("on must be true or false")
        with store.mutate(nutrition.HIGHLIGHTS, {}) as data:
            foods = [food for food in data.get("foods") or [] if food.get("fdc_id") != fdc_id]
            if body["on"]:
                if not description:
                    return _refused("a starred food needs its description")
                foods.append({"fdc_id": fdc_id, "description": description,
                              "added": datetime.now().isoformat(timespec="seconds")})
            data["foods"] = foods
        return jsonify({"ok": True, "foods": foods})

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

    @app.route("/api/nutrition/packaged")
    def nutrition_packaged():
        # Packaged products by name or brand; a string of digits is a barcode typed in.
        text = (request.args.get("q") or "").strip()
        digits = text.replace(" ", "").replace("-", "")
        # Her own label-photo products come first: she read them because USDA hadn't got them.
        with fdcdb.session() as conn:
            if digits.isdigit() and len(digits) >= 8:
                foods = label_products.lookup_barcode(digits) + fdcdb.lookup_barcode(conn, digits)
            else:
                foods = label_products.search(text) + fdcdb.search_packaged(conn, text)
        return jsonify({"foods": foods})

    @app.route("/api/nutrition/labels", methods=["POST"])
    def nutrition_label_read():
        # Save the label photos, then hand them to a helper Claude session to read (like the receipt scan).
        photos = [f for f in request.files.getlist("photo") if f and f.filename][:4]
        if not photos:
            return _refused("no photo uploaded")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        folder = label_products.labels_dir()
        shared.chmod_for_claude(folder)
        saved = []
        for index, upload in enumerate(photos):
            extension = Path(upload.filename).suffix.lower() or ".jpg"
            if extension not in label_products.PHOTO_EXTENSIONS:
                return _refused(f"unsupported photo type: {extension}")
            target = folder / f"label-{stamp}-{index + 1}{extension}"
            upload.save(str(target))
            shared.chmod_for_claude(target)
            saved.append(target)
        barcode = "".join(ch for ch in request.form.get("barcode", "") if ch.isdigit())
        brief = label_products.reading_brief([str(path) for path in saved], barcode)
        payload, status = helpers.mint_helper("label", f"label-{stamp}"[:39], brief, f"Label read {stamp}")
        if status != 200:
            return jsonify(payload), status
        return jsonify({"job": saved[0].name, "photos": [path.name for path in saved]})

    @app.route("/api/nutrition/labels/<name>")
    def nutrition_label_job(name):
        # One label read: still reading, ready with its draft to check, or failed.
        return jsonify(label_products.job_status(name))

    @app.route("/api/nutrition/labels/<name>/photo")
    def nutrition_label_photo(name):
        # A label photo, so the figures can be checked against it.
        if not label_products._safe_name(name):
            return _refused("bad photo name")
        return send_from_directory(str(label_products.labels_dir()), name)

    @app.route("/api/nutrition/label-products/<int:number>/photo")
    def nutrition_label_product_photo(number):
        # A saved product's label photo — where its food name links, as a USDA food's links to USDA.
        product = label_products.product(-number)
        if not product or not product.get("photo"):
            return jsonify({"error": "no photo for that product"}), 404
        return send_from_directory(str(label_products.labels_dir()), product["photo"])

    @app.route("/api/nutrition/label-products", methods=["POST"])
    def nutrition_label_save():
        # Save a checked label draft as a product; answers with it as a packaged-search result.
        body = request.get_json(silent=True) or {}
        try:
            product = label_products.save_product(body.get("draft") or {}, photo=body.get("photo"))
        except ValueError as exc:
            return _refused(str(exc))
        return jsonify({"food": label_products.as_result(product)})
