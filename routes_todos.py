"""Todos and applications routes."""
from flask import request, jsonify
from datetime import datetime
from data_helpers import find_section_key
import store
import uuid


def _load_apps():
    return store.read("shrike_applied.json", [])


def _save_apps(apps):
    store.write("shrike_applied.json", apps)


def _match(item, ident):
    """A to-do is identified by its stable id; fall back to its text for any
    legacy caller still sending the raw text."""
    return item.get("id") == ident or item.get("text") == ident


def register(app):

    @app.route("/api/todos/add", methods=["POST"])
    def add_todo():
        data = request.json
        item_text = data["item"].strip()
        item_text = item_text[0].upper() + item_text[1:] if len(item_text) > 1 else item_text.upper()
        key = find_section_key(data["section"])
        if not key:
            return jsonify({"error": "Section not found"}), 404
        new_id = uuid.uuid4().hex[:8]
        dup = False
        with store.mutate("todos", {}) as todos:
            sec = todos.setdefault(key, {"items": []})
            sec.setdefault("items", [])
            if item_text.lower() in {x.get("text", "").lower() for x in sec["items"]}:
                dup = True
            else:
                new_item = {
                    "id": new_id, "text": item_text, "done": False,
                    "created": datetime.now().strftime("%Y-%m-%d"),
                }
                due_by = (data.get("due_by") or "").strip()
                if due_by:
                    new_item["due_by"] = due_by
                notes = (data.get("notes") or "").strip()
                if notes:
                    new_item["notes"] = notes
                sec["items"].append(new_item)
        if dup:
            return jsonify({"error": "Already exists in this section"}), 400
        return jsonify({"ok": True, "id": new_id})

    @app.route("/api/todos/snooze", methods=["POST"])
    def snooze_todo():
        """Kick a to-do down the road: hide it until `days` from now (days<=0 clears)."""
        from datetime import timedelta
        data = request.json or {}
        ident = data.get("id") or data.get("item", "")
        days = int(data.get("days", 0) or 0)
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                for item in todos[key].get("items", []):
                    if _match(item, ident):
                        if days > 0:
                            item["snoozed_until"] = (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d")
                        else:
                            item.pop("snoozed_until", None)
                        return jsonify({"ok": True})
        return jsonify({"ok": True})

    @app.route("/api/todos/move", methods=["POST"])
    def move_todo():
        data = request.json
        ident = data.get("id") or data.get("item", "")
        to_key = find_section_key(data["to_section"])
        if not to_key:
            return jsonify({"error": "Section not found"}), 404
        with store.mutate("todos", {}) as todos:
            moved = None
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                items = todos[key].get("items", [])
                for i, item in enumerate(items):
                    if _match(item, ident):
                        moved = items.pop(i)
                        break
                if moved:
                    break
            if moved is None:
                moved = {"id": uuid.uuid4().hex[:8], "text": ident, "done": False}
            todos.setdefault(to_key, {"items": []}).setdefault("items", []).append(moved)
        return jsonify({"ok": True})

    # Optional string attributes the detail editor can set/clear on a to-do.
    # An empty value removes the key (we keep items lean — absent = unset).
    TODO_STR_FIELDS = ("notes", "due_by", "due_time", "place_id", "category", "status")

    @app.route("/api/todos/details", methods=["POST"])
    def todo_details():
        """Set optional attributes on a to-do (empty clears). Only the fields
        present in the payload are touched, so the inline notes editor and the
        detail modal can each send just what they manage. Handles notes/due_by
        plus the scheduling/place/category/duration/status attributes."""
        data = request.json or {}
        ident = data.get("id") or data.get("item", "")
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                for item in todos[key].get("items", []):
                    if _match(item, ident):
                        for f in TODO_STR_FIELDS:
                            if f in data:
                                val = (data.get(f) or "").strip()
                                if val:
                                    item[f] = val
                                else:
                                    item.pop(f, None)
                        if "duration_min" in data:
                            try:
                                dm = int(data.get("duration_min") or 0)
                            except (TypeError, ValueError):
                                dm = 0
                            if dm > 0:
                                item["duration_min"] = dm
                            else:
                                item.pop("duration_min", None)
                        return jsonify({"ok": True})
        return jsonify({"ok": True})

    @app.route("/api/todos/remove", methods=["POST"])
    def remove_todo():
        data = request.json
        ident = data.get("id") or data.get("item", "")
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                items = todos[key].get("items", [])
                for i, item in enumerate(items):
                    if _match(item, ident):
                        items.pop(i)
                        return jsonify({"ok": True})
        return jsonify({"ok": True})

    @app.route("/api/todos/toggle", methods=["POST"])
    def toggle_todo():
        data = request.json
        ident = data.get("id") or data.get("item", "")
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                items = todos[key].get("items", [])
                for item in items:
                    if _match(item, ident):
                        item["done"] = not item["done"]
                        items.remove(item)
                        if item["done"]:
                            items.append(item)
                        else:
                            items.insert(0, item)
                        return jsonify({"ok": True})
        return jsonify({"ok": True})

    @app.route("/api/todos/reorder", methods=["POST"])
    def reorder_todos():
        data = request.json
        key = find_section_key(data["section"])
        if not key:
            return jsonify({"error": "Section not found"}), 404
        new_order = data["items"]  # ids (text accepted as fallback)
        with store.mutate("todos", {}) as todos:
            sec = todos.get(key, {"items": []})
            by_ident = {}
            for item in sec.get("items", []):
                if item.get("id"):
                    by_ident[item["id"]] = item
                by_ident.setdefault(item.get("text"), item)
            sec["items"] = [by_ident.get(ident, {"id": ident, "text": ident, "done": False}) for ident in new_order]
            sec["manual_order"] = True  # a hand-dragged bucket sticks to manual order
            todos[key] = sec
        return jsonify({"ok": True})

    @app.route("/api/todos/autosort", methods=["POST"])
    def autosort_todo():
        """Drop a bucket's manual order so it auto-sorts (due date, then age) again."""
        key = find_section_key((request.json or {}).get("section", ""))
        if not key:
            return jsonify({"error": "Section not found"}), 404
        with store.mutate("todos", {}) as todos:
            sec = todos.get(key)
            if sec is not None:
                sec.pop("manual_order", None)
        return jsonify({"ok": True})

    @app.route("/api/todos/rename", methods=["POST"])
    def rename_todo():
        data = request.json
        ident = data.get("id") or data.get("old", "")
        new_name = (data.get("new") or "").strip()
        if not new_name:
            return jsonify({"ok": True})
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                for item in todos[key].get("items", []):
                    if _match(item, ident):
                        item["text"] = new_name
                        return jsonify({"ok": True})
        return jsonify({"ok": True})

    # --- Applications ---

    @app.route("/api/applications/add", methods=["POST"])
    def add_application():
        data = request.json
        apps = _load_apps()
        app_entry = {
            "company": data["company"].strip(),
            "title": data.get("title", "").strip(),
            "status": data.get("status", "applied"),
            "location": data.get("location", "").strip(),
            "date_applied": data.get("date_applied", datetime.now().strftime("%Y-%m-%d")),
            "notes": data.get("notes", ""),
            "url": data.get("url", ""),
        }
        apps.append(app_entry)
        _save_apps(apps)
        return jsonify({"ok": True})

    @app.route("/api/applications/update", methods=["POST"])
    def update_application():
        data = request.json
        company = data["company"]
        apps = _load_apps()
        for a in apps:
            if a["company"] == company:
                for field in ["status", "title", "location", "notes", "url", "date_applied"]:
                    if field in data:
                        a[field] = data[field]
                _save_apps(apps)
                return jsonify({"ok": True})
        return jsonify({"error": "Not found"}), 404

    @app.route("/api/applications/remove", methods=["POST"])
    def remove_application():
        data = request.json
        company = data["company"]
        apps = _load_apps()
        apps = [a for a in apps if a["company"] != company]
        _save_apps(apps)
        return jsonify({"ok": True})
