"""Habits, edges, and growth notes routes."""
from flask import request, jsonify
from datetime import datetime
from data_helpers import DATA_DIR, TULKU_DIR, load_json, save_json, parse_md_sections, add_item_to_file, remove_item_from_file
import store


def _load_growth():
    return store.read("growth_notes.json", {"items": []})


def _save_growth(data):
    store.write("growth_notes.json", data)


def register(app):

    @app.route("/api/habits/add", methods=["POST"])
    def add_habit():
        data = request.json
        item = data["item"].strip()
        item = item[0].upper() + item[1:] if len(item) > 1 else item.upper()
        section = data["section"]
        filepath = TULKU_DIR / "HABITS.md"
        sections = parse_md_sections(filepath)
        for s in sections:
            if s["name"] == section:
                if item.lower() in {x["text"].lower() for x in s["items"]}:
                    return jsonify({"error": "Already exists in this section"}), 400
        add_item_to_file(item, section, filepath)
        return jsonify({"ok": True})

    @app.route("/api/habits/remove", methods=["POST"])
    def remove_habit():
        data = request.json
        remove_item_from_file(data["item"], TULKU_DIR / "HABITS.md")
        return jsonify({"ok": True})

    @app.route("/api/habits/move", methods=["POST"])
    def move_habit():
        data = request.json
        item = data["item"]
        to_section = data["to_section"]
        filepath = TULKU_DIR / "HABITS.md"
        remove_item_from_file(item, filepath)
        add_item_to_file(item, to_section, filepath)
        return jsonify({"ok": True})

    @app.route("/api/habits/toggle", methods=["POST"])
    def toggle_habit():
        data = request.json
        habit = data["habit"]
        date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        with store.mutate("habits_log.json", {}) as log:
            if date not in log:
                log[date] = {}
            if log[date].get(habit):
                del log[date][habit]
                if not log[date]:
                    del log[date]
            else:
                log[date][habit] = True
        return jsonify({"ok": True})

    @app.route("/api/habits/reorder", methods=["POST"])
    def reorder_habits():
        data = request.json
        section = data["section"]
        new_order = data["items"]
        filepath = TULKU_DIR / "HABITS.md"
        text = filepath.read_text()
        lines = text.split("\n")
        target = f"## {section}"
        start = None
        end = None
        for i, line in enumerate(lines):
            if line.strip() == target:
                start = i + 1
            elif start is not None and (line.strip().startswith("## ") or line.strip() == "---" or line.strip().startswith("<")):
                end = i
                break
        if start is None:
            return jsonify({"error": "Section not found"}), 404
        if end is None:
            end = len(lines)
        non_item_lines = [l for l in lines[start:end] if not (l.strip().startswith("- [ ] ") or l.strip().startswith("- [x] "))]
        new_items = [f"- [ ] {item}" for item in new_order]
        lines[start:end] = new_items + non_item_lines
        filepath.write_text("\n".join(lines))
        return jsonify({"ok": True})

    @app.route("/api/habits/settings", methods=["POST"])
    def update_habit_settings():
        data = request.json
        with store.mutate("habit_settings.json", {"hidden": []}) as current:
            if "hidden" in data:
                current["hidden"] = data["hidden"]
        return jsonify({"ok": True})

    @app.route("/api/habits/rename", methods=["POST"])
    def rename_habit():
        data = request.json
        old_name = data["old"]
        new_name = data["new"].strip()
        section = data["section"]
        filepath = TULKU_DIR / "HABITS.md"
        text = filepath.read_text()
        text = text.replace(f"- [ ] {old_name}\n", f"- [ ] {new_name}\n", 1)
        text = text.replace(f"- [x] {old_name}\n", f"- [x] {new_name}\n", 1)
        filepath.write_text(text)
        log_path = DATA_DIR / "habits_log.json"
        if log_path.exists():
            with store.mutate("habits_log.json") as log:
                for date in log:
                    if old_name in log[date]:
                        log[date][new_name] = log[date].pop(old_name)
        return jsonify({"ok": True})

    # --- Edges ---

    @app.route("/api/edges/add", methods=["POST"])
    def add_edge():
        data = request.json
        item = data["item"].strip()
        item = item[0].upper() + item[1:] if len(item) > 1 else item.upper()
        filepath = TULKU_DIR / "HABITS.md"
        text = filepath.read_text()
        for line in text.split("\n"):
            if line.strip().startswith("- ") and line.strip()[2:].lower() == item.lower():
                return jsonify({"error": "Already exists"}), 400
        idx = text.find("</details>")
        if idx >= 0:
            text = text[:idx] + f"- {item}\n" + text[idx:]
            filepath.write_text(text)
        return jsonify({"ok": True})

    @app.route("/api/edges/rename", methods=["POST"])
    def rename_edge():
        data = request.json
        old = data["old"]
        new = data["new"].strip()
        filepath = TULKU_DIR / "HABITS.md"
        text = filepath.read_text()
        text = text.replace(f"- {old}\n", f"- {new}\n", 1)
        filepath.write_text(text)
        return jsonify({"ok": True})

    @app.route("/api/edges/remove", methods=["POST"])
    def remove_edge():
        data = request.json
        item = data["item"]
        filepath = TULKU_DIR / "HABITS.md"
        text = filepath.read_text()
        text = text.replace(f"- {item}\n", "", 1)
        filepath.write_text(text)
        return jsonify({"ok": True})

    # --- Growth Notes ---

    @app.route("/api/growth/add", methods=["POST"])
    def add_growth():
        data = request.json
        text = data["text"].strip()
        if not text:
            return jsonify({"error": "Empty text"}), 400
        gd = _load_growth()
        for item in gd["items"]:
            if item["text"].lower() == text.lower():
                return jsonify({"error": "Already exists"}), 400
        gd["items"].append({
            "text": text,
            "added": datetime.now().strftime("%Y-%m-%d"),
            "status": "active",
            "incorporated": None
        })
        _save_growth(gd)
        return jsonify({"ok": True})

    @app.route("/api/growth/remove", methods=["POST"])
    def remove_growth():
        data = request.json
        text = data["text"]
        gd = _load_growth()
        gd["items"] = [i for i in gd["items"] if i["text"] != text]
        _save_growth(gd)
        return jsonify({"ok": True})

    @app.route("/api/growth/reorder", methods=["POST"])
    def reorder_growth():
        data = request.json
        order = data["order"]
        gd = _load_growth()
        by_text = {i["text"]: i for i in gd["items"]}
        reordered = []
        for t in order:
            if t in by_text:
                reordered.append(by_text.pop(t))
        reordered.extend(by_text.values())
        gd["items"] = reordered
        _save_growth(gd)
        return jsonify({"ok": True})

    @app.route("/api/growth/rename", methods=["POST"])
    def rename_growth():
        data = request.json
        old = data["old"]
        new = data["new"].strip()
        if not new:
            return jsonify({"error": "Empty text"}), 400
        gd = _load_growth()
        for item in gd["items"]:
            if item["text"] == old:
                item["text"] = new
                break
        _save_growth(gd)
        return jsonify({"ok": True})

    @app.route("/api/growth/incorporate", methods=["POST"])
    def incorporate_growth():
        data = request.json
        text = data["text"]
        gd = _load_growth()
        for item in gd["items"]:
            if item["text"] == text:
                item["status"] = "incorporated"
                item["incorporated"] = datetime.now().strftime("%Y-%m-%d")
                break
        _save_growth(gd)
        return jsonify({"ok": True})

    @app.route("/api/growth/reactivate", methods=["POST"])
    def reactivate_growth():
        data = request.json
        text = data["text"]
        gd = _load_growth()
        for item in gd["items"]:
            if item["text"] == text:
                item["status"] = "active"
                item["incorporated"] = None
                break
        _save_growth(gd)
        return jsonify({"ok": True})
