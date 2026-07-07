"""Inventory routes — buy list, active inventory (things owned/in use), restock loop."""
from flask import request, jsonify
from data_helpers import DATA_DIR
from datetime import datetime
import store


def register(app):

    # --- Priority Notes (freeform sticky-note for buy decisions) ---

    @app.route("/api/priority-notes/save", methods=["POST"])
    def save_priority_notes():
        data = request.json or {}
        text = data.get("text", "")
        store.write("priority_notes.json", {"text": text})
        return jsonify({"ok": True})

    # --- Buy List ---

    @app.route("/api/buy/add", methods=["POST"])
    def add_buy_item():
        data = request.json
        name = data["name"].strip()
        priority = data.get("priority", "medium")
        where = data.get("where", "").strip()
        notes = data.get("notes", "").strip()
        category = data.get("category", "").strip()
        cost = data.get("cost", "").strip()
        why = data.get("why", "").strip()
        by = data.get("by", "").strip()
        order_url = data.get("order_url", "").strip()
        # what sort of purchase: consumable | durable | service ('' = unsorted)
        kind = data.get("kind", "").strip()
        bdata = store.read("buy_list.json", {"items": []})
        if any(i["name"].lower() == name.lower() for i in bdata["items"]):
            return jsonify({"error": "Already on the list"}), 400
        bdata["items"].append({
            "name": name, "priority": priority, "where": where,
            "notes": notes, "category": category,
            "cost": cost, "why": why, "by": by,
            "order_url": order_url, "kind": kind,
            "added": datetime.now().isoformat(timespec="seconds"),
        })
        store.write("buy_list.json", bdata)
        return jsonify({"ok": True})

    @app.route("/api/buy/get")
    def get_buy_item():
        name = request.args.get("name", "")
        buy_path = DATA_DIR / "buy_list.json"
        if not buy_path.exists():
            return jsonify({"error": "Not found"}), 404
        bdata = store.read("buy_list.json")
        for i in bdata["items"]:
            if i["name"] == name:
                return jsonify(i)
        return jsonify({"error": "Not found"}), 404

    @app.route("/api/buy/remove", methods=["POST"])
    def remove_buy_item():
        data = request.json
        name = data["name"]
        with store.mutate("buy_list.json") as bdata:
            bdata["items"] = [i for i in bdata["items"] if i["name"] != name]
        return jsonify({"ok": True})

    @app.route("/api/buy/update", methods=["POST"])
    def update_buy_item():
        data = request.json
        name = data["name"]
        with store.mutate("buy_list.json") as bdata:
            for i in bdata["items"]:
                if i["name"] == name:
                    if "priority" in data:
                        i["priority"] = data["priority"]
                    if "where" in data:
                        i["where"] = data["where"]
                    if "notes" in data:
                        i["notes"] = data["notes"]
                    if "category" in data:
                        i["category"] = data["category"]
                    if "cost" in data:
                        i["cost"] = data["cost"]
                    if "why" in data:
                        i["why"] = data["why"]
                    if "by" in data:
                        i["by"] = data["by"]
                    if "order_url" in data:
                        i["order_url"] = data["order_url"]
                    if "kind" in data:
                        i["kind"] = data["kind"]
                    if "new_name" in data:
                        new_name = data["new_name"].strip()
                        if new_name and new_name != name and not any(x["name"].lower() == new_name.lower() for x in bdata["items"] if x is not i):
                            i["name"] = new_name
                    break
        return jsonify({"ok": True})

    # --- Active Inventory ---

    def _load_active():
        return store.read("active_inventory.json", {"items": []})

    def _save_active(adata):
        store.write("active_inventory.json", adata)

    @app.route("/api/active/add", methods=["POST"])
    def add_active_item():
        data = request.json
        name = data["name"].strip()
        if not name:
            return jsonify({"error": "Empty name"}), 400
        adata = _load_active()
        if any(i["name"].lower() == name.lower() for i in adata["items"]):
            return jsonify({"error": "Already in inventory"}), 400
        ordered_at = data.get("ordered_at")
        if ordered_at is None:
            ordered_at = [datetime.now().strftime("%Y-%m-%d")]
        adata["items"].append({
            "name": name,
            "category": data.get("category", "").strip(),
            "status": data.get("status", "in_use"),
            "last_cost": data.get("last_cost", "").strip(),
            "where": data.get("where", "").strip(),
            "notes": data.get("notes", "").strip(),
            "order_url": data.get("order_url", "").strip(),
            "ordered_at": ordered_at,
        })
        _save_active(adata)
        return jsonify({"ok": True})

    @app.route("/api/active/update", methods=["POST"])
    def update_active_item():
        data = request.json
        name = data["name"]
        adata = _load_active()
        for i in adata["items"]:
            if i["name"] == name:
                for k in ("status", "last_cost", "where", "notes", "category", "order_url", "ordered_at", "review", "retired_on"):
                    if k in data:
                        i[k] = data[k]
                if "new_name" in data:
                    new_name = data["new_name"].strip()
                    if new_name and new_name != name and not any(x["name"].lower() == new_name.lower() for x in adata["items"] if x is not i):
                        i["name"] = new_name
                break
        _save_active(adata)
        return jsonify({"ok": True})

    @app.route("/api/active/retire", methods=["POST"])
    def retire_active_item():
        data = request.json
        name = data["name"]
        review = data.get("review", "").strip()
        adata = _load_active()
        for i in adata["items"]:
            if i["name"] == name:
                i["status"] = "finished"
                i["retired_on"] = datetime.now().strftime("%Y-%m-%d")
                if review:
                    i["review"] = review
                break
        _save_active(adata)
        return jsonify({"ok": True})

    @app.route("/api/active/unretire", methods=["POST"])
    def unretire_active_item():
        data = request.json
        name = data["name"]
        adata = _load_active()
        for i in adata["items"]:
            if i["name"] == name:
                i["status"] = "in_use"
                i.pop("retired_on", None)
                break
        _save_active(adata)
        return jsonify({"ok": True})

    @app.route("/api/active/remove", methods=["POST"])
    def remove_active_item():
        data = request.json
        name = data["name"]
        adata = _load_active()
        adata["items"] = [i for i in adata["items"] if i["name"] != name]
        _save_active(adata)
        return jsonify({"ok": True})

    @app.route("/api/buy/move-to-active", methods=["POST"])
    def move_buy_to_active():
        data = request.json
        name = data["name"]
        buy_path = DATA_DIR / "buy_list.json"
        if not buy_path.exists():
            return jsonify({"error": "No buy list"}), 404
        bdata = store.read("buy_list.json")
        item = next((i for i in bdata["items"] if i["name"] == name), None)
        if not item:
            return jsonify({"error": "Not on buy list"}), 404
        bdata["items"] = [i for i in bdata["items"] if i["name"] != name]
        store.write("buy_list.json", bdata)

        adata = _load_active()
        today = datetime.now().strftime("%Y-%m-%d")
        existing = next((i for i in adata["items"] if i["name"].lower() == name.lower()), None)
        if existing:
            existing["status"] = "in_use"
            existing["last_cost"] = item.get("cost", "") or existing.get("last_cost", "")
            existing.setdefault("ordered_at", [])
            existing["ordered_at"].append(today)
            if item.get("where"):
                existing["where"] = item["where"]
            if item.get("order_url"):
                existing["order_url"] = item["order_url"]
        else:
            adata["items"].append({
                "name": item["name"],
                "category": item.get("category", ""),
                "status": "in_use",
                "last_cost": item.get("cost", ""),
                "where": item.get("where", ""),
                "notes": item.get("notes", ""),
                "order_url": item.get("order_url", ""),
                "ordered_at": [today],
            })
        _save_active(adata)
        return jsonify({"ok": True})

    @app.route("/api/active/restock", methods=["POST"])
    def restock_active_item():
        data = request.json
        name = data["name"]
        adata = _load_active()
        item = next((i for i in adata["items"] if i["name"] == name), None)
        if not item:
            return jsonify({"error": "Not in active inventory"}), 404
        item["status"] = "running_low"
        _save_active(adata)

        bdata = store.read("buy_list.json", {"items": []})
        if not any(i["name"].lower() == name.lower() for i in bdata["items"]):
            bdata["items"].append({
                "name": item["name"],
                "priority": "high",
                "where": item.get("where", ""),
                "notes": item.get("notes", ""),
                "category": item.get("category", ""),
                "cost": item.get("last_cost", ""),
                "why": "running low — restock",
                "by": "",
                "order_url": item.get("order_url", ""),
                "kind": "consumable",  # restocks come from the consumables loop
                "added": datetime.now().isoformat(timespec="seconds"),
            })
            store.write("buy_list.json", bdata)
        return jsonify({"ok": True})
