"""The grocery list core: active list + pantry, categories/aisles, the item
catalog (category_map, purchase_counts, item notes), meal notes, and trip log.

Everything here is pure JSON-in/JSON-out against kitchen.json (plus the small
kitchen_trips.json / meal_notes.json files) — no agent pipelines, no uploads.
"""
from datetime import datetime

from flask import request, jsonify

import store


def register(app):

    @app.route("/api/kitchen/add", methods=["POST"])
    def add_kitchen_item():
        data = request.json
        name = data["name"].strip()
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        if any(i["name"].lower() == name.lower() for i in gdata["items"]):
            return jsonify({"error": "Already on the list"}), 400
        cat_map = gdata.get("category_map", {})
        category = data.get("category", "").strip().lower()
        if not category or category == "other":
            category = cat_map.get(name.lower(), "other")
        if category != "other":
            cat_map[name.lower()] = category
            gdata["category_map"] = cat_map
        gdata["items"].append({"name": name, "category": category, "checked": False})
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/add-with-category", methods=["POST"])
    def add_kitchen_item_with_category():
        """Atomic: upsert catalog entry + add to active list with the given category."""
        data = request.json
        name = (data.get("name") or "").strip()
        category = (data.get("category") or "other").strip().lower() or "other"
        if not name:
            return jsonify({"error": "Empty name"}), 400
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        cat_map = gdata.setdefault("category_map", {})
        cat_map[name.lower()] = category
        if any(i["name"].lower() == name.lower() for i in gdata["items"]):
            # Already on list — just refresh category in catalog and return
            store.write("kitchen.json", gdata)
            return jsonify({"ok": True, "already_on_list": True})
        gdata["items"].append({"name": name, "category": category, "checked": False})
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/remove", methods=["POST"])
    def remove_kitchen_item():
        data = request.json
        name = data["name"]
        gdata = store.read("kitchen.json")
        # If the item was checked (counted as purchased) at delete time, decrement
        # the purchase count so the user can undo a mistaken "bought" without
        # polluting buy-frequency stats. Matches toggle's decrement-on-uncheck.
        removed = next((i for i in gdata["items"] if i["name"] == name), None)
        if removed and removed.get("checked"):
            counts = gdata.setdefault("purchase_counts", {})
            key = name.lower()
            counts[key] = max(0, counts.get(key, 0) - 1)
        gdata["items"] = [i for i in gdata["items"] if i["name"] != name]
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/toggle", methods=["POST"])
    def toggle_kitchen_item():
        data = request.json
        name = data["name"]
        gdata = store.read("kitchen.json")
        all_checked = True
        counts = gdata.setdefault("purchase_counts", {})
        for i in gdata["items"]:
            if i["name"] == name:
                was_checked = i.get("checked", False)
                i["checked"] = not was_checked
                if not was_checked:
                    counts[name.lower()] = counts.get(name.lower(), 0) + 1
                else:
                    counts[name.lower()] = max(0, counts.get(name.lower(), 0) - 1)
            if not i.get("checked", False):
                all_checked = False
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True, "all_checked": all_checked})

    @app.route("/api/kitchen/safety-tag", methods=["POST"])
    def set_safety_tag():
        """Set safety_tag on a catalog item: 'safe' | 'suspect' | 'inflammatory' | '' (clear)."""
        body = request.json or {}
        name = (body.get("name") or "").strip().lower()
        tag = (body.get("tag") or "").strip().lower()
        if tag not in ("safe", "suspect", "inflammatory", ""):
            return jsonify({"error": "tag must be safe, suspect, inflammatory, or empty"}), 400
        if not name:
            return jsonify({"error": "missing name"}), 400
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        tags = gdata.setdefault("safety_tags", {})
        if tag:
            tags[name] = tag
        else:
            tags.pop(name, None)
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/clear-all", methods=["POST"])
    def clear_kitchen_all():
        """Empty the grocery list completely — no pantry hand-off, no trip log."""
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        gdata["items"] = []
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/item/note", methods=["POST"])
    def update_kitchen_item_note():
        body = request.json or {}
        name = (body.get("name") or "").strip()
        note = (body.get("note") or "").strip()
        if not name:
            return jsonify({"error": "missing name"}), 400
        gdata = store.read("kitchen.json", {"items": []})
        for item in gdata.get("items", []):
            if item.get("name", "").lower() == name.lower():
                item["note"] = note
                break
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/clear", methods=["POST"])
    def clear_kitchen_checked():
        gdata = store.read("kitchen.json")
        checked = [i for i in gdata["items"] if i.get("checked")]
        gdata["items"] = [i for i in gdata["items"] if not i.get("checked")]
        pantry = gdata.setdefault("pantry", {})
        today = datetime.now().strftime("%Y-%m-%d")
        for item in checked:
            pantry[item["name"].lower()] = {"added": today}
        store.write("kitchen.json", gdata)
        trips = store.read("kitchen_trips.json", {"trips": []})
        if not trips["trips"] or trips["trips"][-1]["date"] != today:
            trips["trips"].append({"date": today})
        store.write("kitchen_trips.json", trips)
        return jsonify({"ok": True})

    # --- pantry -----------------------------------------------------------------

    @app.route("/api/kitchen/pantry/need", methods=["POST"])
    def pantry_need_item():
        data = request.json
        name = data["name"].strip()
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        pantry = gdata.get("pantry", {})
        pantry.pop(name.lower(), None)
        cat_map = gdata.get("category_map", {})
        category = cat_map.get(name.lower(), "other")
        if not any(i["name"].lower() == name.lower() for i in gdata["items"]):
            gdata["items"].append({"name": name, "category": category, "checked": False})
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/pantry/add", methods=["POST"])
    def pantry_add_item():
        data = request.json
        name = data["name"].strip()
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        pantry = gdata.setdefault("pantry", {})
        today = datetime.now().strftime("%Y-%m-%d")
        pantry[name.lower()] = {"added": today}
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/pantry/remove", methods=["POST"])
    def pantry_remove_item():
        data = request.json
        name = data["name"].strip()
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        gdata.get("pantry", {}).pop(name.lower(), None)
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    # --- aisles / locations / categories ------------------------------------------

    @app.route("/api/kitchen/aisle/set", methods=["POST"])
    def set_aisle():
        """Set or clear the aisle number for a catalog item. aisle=null clears.
        Side effect: also updates category_map so the catalog's grouping logic
        knows aisle items sit under the @aisles sentinel.
        """
        data = request.json or {}
        name = (data.get("name") or "").strip().lower()
        aisle = data.get("aisle")
        if not name:
            return jsonify({"error": "Empty name"}), 400
        gdata = store.read("kitchen.json", {})
        aisles = gdata.setdefault("aisles", {})
        cat_map = gdata.setdefault("category_map", {})
        if aisle in (None, "", 0):
            aisles.pop(name, None)
            # When clearing an aisle, restore to "other" if the category was @aisles
            if cat_map.get(name) == "@aisles":
                cat_map[name] = "other"
        else:
            try:
                aisles[name] = int(aisle)
                cat_map[name] = "@aisles"
            except (TypeError, ValueError):
                return jsonify({"error": "Invalid aisle number"}), 400
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/location/set", methods=["POST"])
    def set_location():
        """Unified picker — set EITHER a section category OR an aisle number for an item.
        Body: { name, location }. location can be:
          - "" or null  → clear (default to 'other')
          - "produce", "dairy", etc. → section category
          - "aisle:5"  → aisle 5
        Atomically updates category_map + aisles to keep them consistent.
        """
        data = request.json or {}
        name = (data.get("name") or "").strip().lower()
        loc = (data.get("location") or "").strip()
        if not name:
            return jsonify({"error": "Empty name"}), 400
        gdata = store.read("kitchen.json", {})
        aisles = gdata.setdefault("aisles", {})
        cat_map = gdata.setdefault("category_map", {})
        if loc.startswith("aisle:"):
            try:
                n = int(loc.split(":", 1)[1])
            except (ValueError, IndexError):
                return jsonify({"error": "Invalid aisle"}), 400
            aisles[name] = n
            cat_map[name] = "@aisles"
        else:
            aisles.pop(name, None)
            cat_map[name] = loc or "other"
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/category/rename", methods=["POST"])
    def rename_category():
        """Rename a category everywhere it appears: category_order, category_map values, items[].category."""
        data = request.json or {}
        old = (data.get("old") or "").strip().lower()
        new = (data.get("new") or "").strip().lower()
        if not old or not new:
            return jsonify({"error": "old and new required"}), 400
        if old == "@aisles" or new == "@aisles":
            return jsonify({"error": "@aisles is reserved"}), 400
        if old == new:
            return jsonify({"ok": True, "noop": True})
        gdata = store.read("kitchen.json", {})
        # category_order
        order = gdata.get("category_order") or []
        if new in order and old in order:
            # Avoid duplicates — drop the old slot, keep the existing new
            order = [c for c in order if c != old]
        else:
            order = [new if c == old else c for c in order]
        gdata["category_order"] = order
        # category_map values
        cm = gdata.get("category_map") or {}
        for k, v in list(cm.items()):
            if v == old:
                cm[k] = new
        # items[].category
        for it in gdata.get("items", []) or []:
            if it.get("category") == old:
                it["category"] = new
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/category/delete", methods=["POST"])
    def delete_category():
        """Remove a category. All items in it move to reassign_to (default 'other')."""
        data = request.json or {}
        name = (data.get("name") or "").strip().lower()
        reassign_to = (data.get("reassign_to") or "other").strip().lower()
        if not name:
            return jsonify({"error": "name required"}), 400
        if name == "@aisles":
            return jsonify({"error": "@aisles is reserved"}), 400
        if reassign_to == "@aisles":
            return jsonify({"error": "Cannot reassign to @aisles"}), 400
        gdata = store.read("kitchen.json", {})
        order = gdata.get("category_order") or []
        gdata["category_order"] = [c for c in order if c != name]
        cm = gdata.get("category_map") or {}
        moved = 0
        for k, v in list(cm.items()):
            if v == name:
                cm[k] = reassign_to
                moved += 1
        for it in gdata.get("items", []) or []:
            if it.get("category") == name:
                it["category"] = reassign_to
                moved += 1
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True, "moved": moved})

    @app.route("/api/kitchen/category-order", methods=["POST"])
    def save_category_order():
        data = request.json
        order = data.get("order", [])
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        gdata["category_order"] = order
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    # --- catalog ------------------------------------------------------------------

    @app.route("/api/kitchen/catalog/add", methods=["POST"])
    def add_catalog_item():
        data = request.json
        name = data["name"].strip().lower()
        category = data.get("category", "other").strip().lower()
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        cat_map = gdata.setdefault("category_map", {})
        if name not in cat_map or category != "other":
            cat_map[name] = category
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/catalog/remove", methods=["POST"])
    def remove_catalog_item():
        data = request.json
        name = data["name"].strip().lower()
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        gdata.get("category_map", {}).pop(name, None)
        gdata.get("purchase_counts", {}).pop(name, None)
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/catalog/rename", methods=["POST"])
    def rename_catalog_item():
        """Rename a catalog item. Migrates ALL related maps + preserves user's display casing.
        new_display preserves the casing the user typed; new_name is the canonical lowercase key.
        """
        data = request.json
        old = data["old_name"].strip().lower()
        new_display = data["new_name"].strip()
        new = new_display.lower()
        if not new or old == new:
            return jsonify({"ok": True, "noop": True})
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        # Migrate every map that's keyed by the catalog name (lowercase)
        for mapname in ("category_map", "purchase_counts", "aisles", "item_notes", "last_bought", "pantry"):
            m = gdata.get(mapname)
            if isinstance(m, dict) and old in m:
                m[new] = m.pop(old)
        # Update items on the active list — preserve user's display casing
        for item in gdata.get("items", []) or []:
            if item.get("name", "").lower() == old:
                item["name"] = new_display
        store.write("kitchen.json", gdata)

        # Migrate catalog_name in grocery_trips so historic line_items still link
        tdata = store.read("grocery_trips.json", {"trips": []})
        changed = False
        for trip in tdata.get("trips", []):
            for li in trip.get("line_items", []) or []:
                if (li.get("catalog_name") or "").lower() == old:
                    li["catalog_name"] = new
                    changed = True
        if changed:
            store.write("grocery_trips.json", tdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/catalog/note", methods=["POST"])
    def save_catalog_note():
        data = request.json
        name = data["name"].strip().lower()
        note = data.get("note", "").strip()
        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        notes = gdata.setdefault("item_notes", {})
        if note:
            notes[name] = note
        else:
            notes.pop(name, None)
        store.write("kitchen.json", gdata)
        return jsonify({"ok": True})

    # --- meal notes ----------------------------------------------------------------

    @app.route("/api/kitchen/meal-notes", methods=["GET"])
    def get_meal_notes():
        notes = store.read("meal_notes.json", [])
        return jsonify({"notes": notes})

    @app.route("/api/kitchen/meal-notes", methods=["POST"])
    def add_meal_note():
        data = request.json
        text = data.get("text", "").strip()
        if not text:
            return jsonify({"error": "empty note"}), 400
        notes = store.read("meal_notes.json", [])
        today = datetime.now().strftime("%Y-%m-%d")
        notes.insert(0, {"date": today, "text": text})
        notes = notes[:50]
        store.write("meal_notes.json", notes)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/meal-notes/delete", methods=["POST"])
    def delete_meal_note():
        data = request.json
        idx = data.get("index", -1)
        notes = store.read("meal_notes.json", [])
        if 0 <= idx < len(notes):
            notes.pop(idx)
            store.write("meal_notes.json", notes)
        return jsonify({"ok": True})

    # --- trip log ------------------------------------------------------------------

    @app.route("/api/kitchen/trips/log", methods=["POST"])
    def log_kitchen_trip():
        data = request.json
        date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        tdata = store.read("kitchen_trips.json", {"trips": []})
        if not any(t["date"] == date for t in tdata["trips"]):
            tdata["trips"].append({"date": date})
            tdata["trips"].sort(key=lambda t: t["date"])
        store.write("kitchen_trips.json", tdata)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/trips/remove", methods=["POST"])
    def remove_kitchen_trip():
        data = request.json
        date = data["date"]
        tdata = store.read("kitchen_trips.json", {"trips": []})
        tdata["trips"] = [t for t in tdata["trips"] if t["date"] != date]
        store.write("kitchen_trips.json", tdata)
        # Drop the matching kitchen entries from the activity log too. Only write
        # if something matched, so a missing activity_log.json isn't created.
        adata = store.read("activity_log.json", {"entries": []})
        kept = [e for e in adata.get("entries", []) if not (e["date"] == date and e["type"] == "kitchen")]
        if len(kept) != len(adata.get("entries", [])):
            adata["entries"] = kept
            store.write("activity_log.json", adata)
        return jsonify({"ok": True})
