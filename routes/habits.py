"""Habits, edges, and growth notes routes."""
from flask import request, jsonify
from datetime import datetime
from data_helpers import (
    DATA_DIR, CONTENT_DIR, load_json, save_json, parse_md_sections,
    add_item_to_file, remove_item_from_file, habit_log_key,
)
import store


def _rewrite_log_keys(old_key, new_key, also_bare=None):
    """Move every dated entry under old_key (or the legacy bare key) to
    new_key — keeps history attached through renames and section moves."""
    with store.mutate("habits_log.json", {}) as log:
        for date in log:
            day = log[date]
            if not isinstance(day, dict):
                continue
            if old_key in day:
                day[new_key] = day.pop(old_key)
            elif also_bare and also_bare in day:
                day[new_key] = day.pop(also_bare)


def _remove_from_section(item, section, filepath):
    """Remove a single `- [ ] item` line from ONE named section (the global
    remove_item_from_file can't target a section, which matters for habits that
    live in Morning AND Evening). Returns True if a line was removed."""
    lines = filepath.read_text().split("\n")
    out, in_sec, removed = [], False, False
    for line in lines:
        s = line.strip()
        if s == f"## {section}":
            in_sec = True
            out.append(line); continue
        if in_sec and (s.startswith("## ") or s == "---" or s.startswith("<")):
            in_sec = False
        if in_sec and not removed and s in (f"- [ ] {item}", f"- [x] {item}"):
            removed = True
            continue
        out.append(line)
    filepath.write_text("\n".join(out))
    return removed


def _drop_overlays(section, name):
    """Forget cadence + course state for a (section, habit) that's going away."""
    key = habit_log_key(section, name)
    for fname in ("habit_cadence.json", "habit_meta.json"):
        with store.mutate(fname, {}) as d:
            d.pop(key, None)


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
        filepath = CONTENT_DIR / "HABITS.md"
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
        remove_item_from_file(data["item"], CONTENT_DIR / "HABITS.md")
        return jsonify({"ok": True})

    @app.route("/api/habits/move", methods=["POST"])
    def move_habit():
        data = request.json
        item = data["item"]
        to_section = data["to_section"]
        filepath = CONTENT_DIR / "HABITS.md"
        # Where it lives now — the log history follows it to the new section.
        from_section = next(
            (s["name"] for s in parse_md_sections(filepath)
             if any(x["text"] == item for x in s["items"])),
            None,
        ) if filepath.exists() else None
        remove_item_from_file(item, filepath)
        add_item_to_file(item, to_section, filepath)
        if from_section and from_section != to_section:
            _rewrite_log_keys(habit_log_key(from_section, item),
                              habit_log_key(to_section, item), also_bare=item)
        return jsonify({"ok": True})

    @app.route("/api/habits/toggle", methods=["POST"])
    def toggle_habit():
        data = request.json
        habit = data["habit"]
        section = (data.get("section") or "").strip()
        # Section-qualified key so identical texts in different sections track
        # independently; bare text accepted for any legacy caller.
        key = habit_log_key(section, habit) if section else habit
        date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
        with store.mutate("habits_log.json", {}) as log:
            if date not in log:
                log[date] = {}
            if log[date].get(key):
                del log[date][key]
                if not log[date]:
                    del log[date]
            else:
                log[date][key] = True
                if section:
                    log[date].pop(habit, None)   # absorb any legacy bare entry
        return jsonify({"ok": True})

    @app.route("/api/habits/reorder", methods=["POST"])
    def reorder_habits():
        data = request.json
        section = data["section"]
        new_order = data["items"]
        filepath = CONTENT_DIR / "HABITS.md"
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
        filepath = CONTENT_DIR / "HABITS.md"
        text = filepath.read_text()
        text = text.replace(f"- [ ] {old_name}\n", f"- [ ] {new_name}\n", 1)
        text = text.replace(f"- [x] {old_name}\n", f"- [x] {new_name}\n", 1)
        filepath.write_text(text)
        # History follows the rename (qualified key; legacy bare as fallback).
        _rewrite_log_keys(habit_log_key(section, old_name),
                          habit_log_key(section, new_name), also_bare=old_name)
        return jsonify({"ok": True})

    # --- Cadence ladder (daily → weekly → monthly → retired) ---

    @app.route("/api/habits/cadence/promote", methods=["POST"])
    def promote_habit():
        import habit_cadence
        data = request.json or {}
        habit_cadence.promote(data.get("section", ""), data["habit"])
        return jsonify({"ok": True})

    @app.route("/api/habits/cadence/restore", methods=["POST"])
    def restore_habit():
        import habit_cadence
        data = request.json or {}
        habit_cadence.restore(data.get("section", ""), data["habit"])
        return jsonify({"ok": True})

    @app.route("/api/habits/configure", methods=["POST"])
    def configure_habit():
        """Create or re-configure a habit in one shot: which time-of-day section(s)
        it lives in, and an optional course length (auto-archives when it ends).
        Name changes still go through /rename — `name` is the identity here."""
        import habit_meta
        data = request.json or {}
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Name required"}), 400
        name = name[0].upper() + name[1:] if len(name) > 1 else name.upper()
        filepath = CONTENT_DIR / "HABITS.md"

        # remove:true → take the habit out of every section it lives in (history in
        # habits_log is keyed by date and stays put).
        if data.get("remove"):
            for sec in [s["name"] for s in parse_md_sections(filepath)
                        if any(x["text"].lower() == name.lower() for x in s["items"])]:
                _remove_from_section(name, sec, filepath)
                _drop_overlays(sec, name)
            return jsonify({"ok": True})

        sections = [s for s in (data.get("sections") or []) if s]
        if not sections:
            return jsonify({"error": "Pick at least one time of day"}), 400
        course_days = int(data.get("course_days") or 0)

        current = [s["name"] for s in parse_md_sections(filepath)
                   if any(x["text"].lower() == name.lower() for x in s["items"])]
        for sec in sections:
            if sec not in current:
                add_item_to_file(name, sec, filepath)
        for sec in current:
            if sec not in sections:
                _remove_from_section(name, sec, filepath)
                _drop_overlays(sec, name)

        today = datetime.now().strftime("%Y-%m-%d")
        with store.mutate(habit_meta.META_FILE, {}) as meta:
            for sec in sections:
                key = habit_log_key(sec, name)
                if course_days > 0:
                    meta[key] = {
                        "course_start": meta.get(key, {}).get("course_start", today),
                        "course_days": course_days,
                    }
                else:
                    meta.pop(key, None)
        return jsonify({"ok": True})

    # --- Edges ---

    @app.route("/api/edges/add", methods=["POST"])
    def add_edge():
        data = request.json
        item = data["item"].strip()
        item = item[0].upper() + item[1:] if len(item) > 1 else item.upper()
        filepath = CONTENT_DIR / "HABITS.md"
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
        filepath = CONTENT_DIR / "HABITS.md"
        text = filepath.read_text()
        text = text.replace(f"- {old}\n", f"- {new}\n", 1)
        filepath.write_text(text)
        return jsonify({"ok": True})

    @app.route("/api/edges/remove", methods=["POST"])
    def remove_edge():
        data = request.json
        item = data["item"]
        filepath = CONTENT_DIR / "HABITS.md"
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

    @app.route("/api/growth/details", methods=["POST"])
    def growth_details():
        """Set/clear an optional description on a Working On item."""
        data = request.json or {}
        text = data.get("text", "")
        gd = _load_growth()
        for item in gd["items"]:
            if item["text"] == text:
                if "notes" in data:
                    notes = (data.get("notes") or "").strip()
                    if notes:
                        item["notes"] = notes
                    else:
                        item.pop("notes", None)
                _save_growth(gd)
                return jsonify({"ok": True})
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
