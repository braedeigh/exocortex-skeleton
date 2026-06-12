"""Per-tab dev notes (the friction log at the bottom of every page).

Also home to "send to ideas": a dev note that turns out to be a product/vision
idea rather than a page tweak gets appended to the ideas doc (store.IDEAS_FILE)
and removed from the notes panel — capture without losing it in the queue.
"""
from flask import request, jsonify
from datetime import datetime
import secrets

import store


def load_dev_notes():
    return store.read("dev_notes.json", {"tabs": {}})


def save_dev_notes(d):
    store.write("dev_notes.json", d)


IDEAS_INBOX_HEADER = "## Inbox — sent from dev notes"


def _append_to_ideas(note, tab):
    """Append a dev note under the inbox header of the ideas doc (newest first),
    creating the file/section on first use."""
    ideas = store.IDEAS_FILE
    entry = f"- **(from {tab} dev notes, {note.get('created', '')})** {note.get('text', '').strip()}"
    if ideas.exists():
        text = ideas.read_text()
    else:
        ideas.parent.mkdir(parents=True, exist_ok=True)
        text = "# Ideas\n"
    if IDEAS_INBOX_HEADER not in text:
        if not text.endswith("\n"):
            text += "\n"
        text += f"\n---\n\n{IDEAS_INBOX_HEADER}\n"
    lines = text.split("\n")
    at = lines.index(IDEAS_INBOX_HEADER) + 1
    while at < len(lines) and lines[at].strip() == "":
        at += 1
    lines.insert(at, entry)
    if at + 1 == len(lines):
        lines.append("")
    ideas.write_text("\n".join(lines))


def register(app):

    @app.route("/api/devnote/add", methods=["POST"])
    def add_devnote():
        data = request.json
        tab = (data.get("tab") or "").strip()
        text = (data.get("text") or "").strip()
        if not tab or not text:
            return jsonify({"error": "tab and text required"}), 400
        d = load_dev_notes()
        d.setdefault("tabs", {}).setdefault(tab, []).append({
            "id": secrets.token_hex(4),
            "text": text,
            "created": datetime.now().strftime("%Y-%m-%d %H:%M"),
        })
        save_dev_notes(d)
        return jsonify({"ok": True})

    @app.route("/api/devnotes/<tab>", methods=["GET"])
    def get_devnotes(tab):
        notes = load_dev_notes().get("tabs", {}).get(tab, [])
        return jsonify({"tab": tab, "notes": notes})

    @app.route("/api/devnote/remove", methods=["POST"])
    def remove_devnote():
        data = request.json
        tab = data.get("tab", "")
        nid = data.get("id", "")
        d = load_dev_notes()
        notes = d.get("tabs", {}).get(tab, [])
        d["tabs"][tab] = [n for n in notes if n.get("id") != nid]
        save_dev_notes(d)
        return jsonify({"ok": True})

    @app.route("/api/devnote/edit", methods=["POST"])
    def edit_devnote():
        data = request.json
        tab = (data.get("tab") or "").strip()
        nid = data.get("id", "")
        text = (data.get("text") or "").strip()
        if not tab or not nid or not text:
            return jsonify({"error": "tab, id and text required"}), 400
        d = load_dev_notes()
        notes = d.get("tabs", {}).get(tab, [])
        for n in notes:
            if n.get("id") == nid:
                n["text"] = text
                break
        else:
            return jsonify({"error": "note not found"}), 404
        save_dev_notes(d)
        return jsonify({"ok": True})

    @app.route("/api/devnote/to_ideas", methods=["POST"])
    def devnote_to_ideas():
        data = request.json or {}
        tab = (data.get("tab") or "").strip()
        nid = (data.get("id") or "").strip()
        d = load_dev_notes()
        notes = d.get("tabs", {}).get(tab, [])
        note = next((n for n in notes if n.get("id") == nid), None)
        if note is None:
            return jsonify({"error": "note not found"}), 404
        _append_to_ideas(note, tab)
        d["tabs"][tab] = [n for n in notes if n.get("id") != nid]
        save_dev_notes(d)
        return jsonify({"ok": True})
