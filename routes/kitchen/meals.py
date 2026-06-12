"""Weekly meal-prep defaults (meal_defaults.json) and generate-list — resolving
this week's meal cluster into the active grocery list."""
from datetime import datetime

from flask import request, jsonify

import store


def register(app):

    @app.route("/api/meal-defaults/this-week/vegetables", methods=["POST"])
    def update_this_week_vegetables():
        data = request.json or {}
        vegetables = (data.get("vegetables") or [])[:2]
        meal = store.read("meal_defaults.json", {})
        mp = meal.setdefault("meal_prep", {})
        tw = mp.setdefault("this_week", {})
        tw["vegetables"] = vegetables
        tw["week_of"] = datetime.now().strftime("%Y-%m-%d")
        store.write("meal_defaults.json", meal)
        return jsonify({"ok": True})

    @app.route("/api/meal-defaults/this-week/protein", methods=["POST"])
    def update_this_week_protein():
        data = request.json or {}
        protein = (data.get("protein") or "").strip()
        if not protein:
            return jsonify({"error": "Empty protein"}), 400
        meal = store.read("meal_defaults.json", {})
        mp = meal.setdefault("meal_prep", {})
        tw = mp.setdefault("this_week", {})
        tw["protein"] = protein
        store.write("meal_defaults.json", meal)
        return jsonify({"ok": True})

    @app.route("/api/meal-defaults/side-salad/toggle", methods=["POST"])
    def toggle_side_salad():
        data = request.json or {}
        meal = store.read("meal_defaults.json", {})
        salad = meal.setdefault("side_salad", {})
        if "enabled" in data:
            salad["enabled_this_week"] = bool(data["enabled"])
        else:
            salad["enabled_this_week"] = not salad.get("enabled_this_week", False)
        store.write("meal_defaults.json", meal)
        return jsonify({"ok": True, "enabled": salad["enabled_this_week"]})

    @app.route("/api/meal-defaults/generate-list", methods=["POST"])
    def generate_grocery_from_meal():
        """Resolve this week's meal cluster into the active grocery list.

        Pantry rules (per plan):
          - Meal-prep core (always_vegetables, protein, picked vegetables): always add (consumed weekly)
          - Grain, side-salad ingredients, breakfast staples: pantry-aware (skip if in pantry)
        """
        meal = store.read("meal_defaults.json", {})
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}, "pantry": {}, "last_bought": {}})

        mp = meal.setdefault("meal_prep", {})
        tw = mp.setdefault("this_week", {})

        # Auto-flip protein if unset: pick the one NOT most recently bought
        protein = tw.get("protein")
        if not protein:
            rotation = mp.get("protein_rotation") or []
            last_bought = gdata.get("last_bought", {})
            if len(rotation) >= 2:
                dated = sorted(rotation, key=lambda p: last_bought.get(p, ""), reverse=True)
                protein = dated[-1]
            elif rotation:
                protein = rotation[0]
            if protein:
                tw["protein"] = protein
                store.write("meal_defaults.json", meal)

        # Targets: (name, pantry_aware)
        targets = []
        grain = mp.get("grain")
        if grain:
            targets.append((grain, True))
        for v in mp.get("always_vegetables", []):
            targets.append((v, False))
        if protein:
            targets.append((protein, False))
        for v in tw.get("vegetables", []):
            targets.append((v, False))
        salad = meal.get("side_salad", {})
        if salad.get("enabled_this_week"):
            for ing in salad.get("ingredients", []):
                targets.append((ing, True))
        for s in meal.get("breakfast_staples", []):
            targets.append((s, True))

        items = gdata.setdefault("items", [])
        cat_map = gdata.setdefault("category_map", {})
        pantry_keys_lower = {k.lower() for k in gdata.get("pantry", {}).keys()}
        items_lower = {i["name"].lower() for i in items}

        added, skipped_pantry, skipped_listed = [], [], []
        for name, pantry_aware in targets:
            nlow = name.lower()
            if nlow in items_lower:
                skipped_listed.append(name)
                continue
            if pantry_aware and nlow in pantry_keys_lower:
                skipped_pantry.append(name)
                continue
            category = cat_map.get(nlow, "other")
            items.append({"name": name, "category": category, "checked": False})
            items_lower.add(nlow)
            added.append(name)

        store.write("kitchen.json", gdata)
        return jsonify({
            "ok": True,
            "added": added,
            "skipped_in_pantry": skipped_pantry,
            "skipped_already_on_list": skipped_listed,
            "this_week": tw,
        })
