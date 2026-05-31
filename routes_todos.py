"""Todos and applications routes."""
from flask import request, jsonify
from datetime import datetime
from data_helpers import load_todos, save_todos, find_section_key
import store


def _load_apps():
    return store.read("shrike_applied.json", [])


def _save_apps(apps):
    store.write("shrike_applied.json", apps)


def register(app):

    @app.route("/api/todos/add", methods=["POST"])
    def add_todo():
        data = request.json
        item_text = data["item"].strip()
        item_text = item_text[0].upper() + item_text[1:] if len(item_text) > 1 else item_text.upper()
        section_name = data["section"]
        todos = load_todos()
        key = find_section_key(section_name)
        if not key:
            return jsonify({"error": "Section not found"}), 404
        sec = todos.get(key, {"items": []})
        if item_text.lower() in {x["text"].lower() for x in sec.get("items", [])}:
            return jsonify({"error": "Already exists in this section"}), 400
        sec.setdefault("items", []).append({"text": item_text, "done": False})
        todos[key] = sec
        save_todos(todos)
        return jsonify({"ok": True})

    @app.route("/api/todos/move", methods=["POST"])
    def move_todo():
        data = request.json
        item_text = data["item"]
        to_section_name = data["to_section"]
        todos = load_todos()
        to_key = find_section_key(to_section_name)
        if not to_key:
            return jsonify({"error": "Section not found"}), 404
        for key in todos:
            sec = todos[key]
            items = sec.get("items", [])
            for i, item in enumerate(items):
                if item["text"] == item_text:
                    items.pop(i)
                    break
        todos.setdefault(to_key, {"items": []}).setdefault("items", []).append({"text": item_text, "done": False})
        save_todos(todos)
        return jsonify({"ok": True})

    @app.route("/api/todos/remove", methods=["POST"])
    def remove_todo():
        data = request.json
        item_text = data["item"]
        todos = load_todos()
        for key in todos:
            items = todos[key].get("items", [])
            for i, item in enumerate(items):
                if item["text"] == item_text:
                    items.pop(i)
                    save_todos(todos)
                    return jsonify({"ok": True})
        return jsonify({"ok": True})

    @app.route("/api/todos/toggle", methods=["POST"])
    def toggle_todo():
        data = request.json
        item_text = data["item"]
        todos = load_todos()
        for key in todos:
            items = todos[key].get("items", [])
            for item in items:
                if item["text"] == item_text:
                    item["done"] = not item["done"]
                    if item["done"]:
                        items.remove(item)
                        items.append(item)
                    else:
                        items.remove(item)
                        items.insert(0, item)
                    save_todos(todos)
                    return jsonify({"ok": True})
        return jsonify({"ok": True})

    @app.route("/api/todos/reorder", methods=["POST"])
    def reorder_todos():
        data = request.json
        section_name = data["section"]
        new_order = data["items"]
        todos = load_todos()
        key = find_section_key(section_name)
        if not key:
            return jsonify({"error": "Section not found"}), 404
        sec = todos.get(key, {"items": []})
        old_items = {item["text"]: item for item in sec.get("items", [])}
        sec["items"] = [old_items.get(text, {"text": text, "done": False}) for text in new_order]
        todos[key] = sec
        save_todos(todos)
        return jsonify({"ok": True})

    @app.route("/api/todos/rename", methods=["POST"])
    def rename_todo():
        data = request.json
        old_name = data["old"]
        new_name = data["new"].strip()
        todos = load_todos()
        for key in todos:
            items = todos[key].get("items", [])
            for item in items:
                if item["text"] == old_name:
                    item["text"] = new_name
                    save_todos(todos)
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
