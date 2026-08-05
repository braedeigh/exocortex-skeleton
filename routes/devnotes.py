"""Per-tab dev notes + idea notes (the two capture panels at the bottom of
every page).

Dev notes are friction ("this page is bugging me"); idea notes are wants
("this page could…"). Same shape, two files: dev_notes.json / idea_notes.json,
both {"tabs": {<tab>: [{id, text, created}, ...]}}. A dev note that turns out
to be an idea moves between them verbatim via /api/devnote/to_ideas (id and
created survive, so undo is exact). The Ideas tab reads idea_notes across all
tabs to show them sorted by page.
"""
from flask import request, jsonify
from datetime import datetime
import secrets

import store


def load_dev_notes():
    return store.read("dev_notes.json", {"tabs": {}})


def save_dev_notes(d):
    store.write("dev_notes.json", d)


def load_idea_notes():
    return store.read("idea_notes.json", {"tabs": {}})


def save_idea_notes(d):
    store.write("idea_notes.json", d)


def _new_note(text):
    return {
        "id": secrets.token_hex(4),
        "text": text,
        "created": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }


def _restore_note(data, load, save):
    """Shared undo-restore: re-insert a full note (id/created intact) at its
    original index. Inserting twice can't duplicate."""
    tab = (data.get("tab") or "").strip()
    note = data.get("note") or {}
    nid = str(note.get("id") or "").strip()
    text = str(note.get("text") or "").strip()
    if not tab or not nid or not text:
        return None, (jsonify({"error": "tab and note {id, text} required"}), 400)
    clean = {"id": nid, "text": text, "created": str(note.get("created") or "")}
    # The night-crew green-light survives an undo — rebuilding the note without
    # it would silently unqueue work she'd already lit (routes/nightcrew.py).
    if note.get("night") is True:
        clean["night"] = True
    d = load()
    notes = d.setdefault("tabs", {}).setdefault(tab, [])
    if not any(n.get("id") == nid for n in notes):
        try:
            idx = int(data.get("index"))
        except (TypeError, ValueError):
            idx = len(notes)
        notes.insert(max(0, min(idx, len(notes))), clean)
        save(d)
    return clean, None


def _remove_note(d, tab, nid):
    """Drop a note by id from a loaded notes dict. Returns the removed note."""
    notes = d.get("tabs", {}).get(tab, [])
    note = next((n for n in notes if n.get("id") == nid), None)
    if note is not None:
        d["tabs"][tab] = [n for n in notes if n.get("id") != nid]
    return note


def register(app):

    # --- Dev notes ---

    @app.route("/api/devnote/add", methods=["POST"])
    def add_devnote():
        data = request.json
        tab = (data.get("tab") or "").strip()
        text = (data.get("text") or "").strip()
        if not tab or not text:
            return jsonify({"error": "tab and text required"}), 400
        d = load_dev_notes()
        d.setdefault("tabs", {}).setdefault(tab, []).append(_new_note(text))
        save_dev_notes(d)
        return jsonify({"ok": True})

    @app.route("/api/devnotes/all", methods=["GET"])
    def get_devnotes_all():
        return jsonify({"tabs": load_dev_notes().get("tabs", {})})

    @app.route("/api/devnotes/<tab>", methods=["GET"])
    def get_devnotes(tab):
        notes = load_dev_notes().get("tabs", {}).get(tab, [])
        return jsonify({"tab": tab, "notes": notes})

    @app.route("/api/devnote/remove", methods=["POST"])
    def remove_devnote():
        data = request.json
        d = load_dev_notes()
        _remove_note(d, data.get("tab", ""), data.get("id", ""))
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
                # Editing the text answers any questions the night crew left on
                # this note (scripts/nightcrew_run.py writes `night_questions`
                # when a worker finds the note ambiguous) — her amended words
                # supersede the ask, and the changed text is itself what
                # re-queues the note for the next night.
                if n.get("text") != text:
                    n.pop("night_questions", None)
                n["text"] = text
                break
        else:
            return jsonify({"error": "note not found"}), 404
        save_dev_notes(d)
        return jsonify({"ok": True})

    @app.route("/api/devnote/restore", methods=["POST"])
    def restore_devnote():
        """Undo of delete / send-to-ideas: put the note back in dev notes.
        `remove_from_ideas` also pulls it back out of idea_notes (the inverse
        of to_ideas)."""
        data = request.json or {}
        clean, err = _restore_note(data, load_dev_notes, save_dev_notes)
        if err:
            return err
        if data.get("remove_from_ideas"):
            tab = (data.get("tab") or "").strip()
            di = load_idea_notes()
            if _remove_note(di, tab, clean["id"]) is not None:
                save_idea_notes(di)
        return jsonify({"ok": True})

    @app.route("/api/devnote/to_ideas", methods=["POST"])
    def devnote_to_ideas():
        """Move a dev note (verbatim — id and created survive) into the same
        tab's idea notes."""
        data = request.json or {}
        tab = (data.get("tab") or "").strip()
        nid = (data.get("id") or "").strip()
        d = load_dev_notes()
        note = _remove_note(d, tab, nid)
        if note is None:
            return jsonify({"error": "note not found"}), 404
        di = load_idea_notes()
        ideas = di.setdefault("tabs", {}).setdefault(tab, [])
        if not any(n.get("id") == nid for n in ideas):   # redo after undo can't dup
            ideas.append(note)
        save_idea_notes(di)
        save_dev_notes(d)
        return jsonify({"ok": True})

    # --- Idea notes (same component, second file) ---

    @app.route("/api/ideanote/add", methods=["POST"])
    def add_ideanote():
        data = request.json
        tab = (data.get("tab") or "").strip() or "general"
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "text required"}), 400
        d = load_idea_notes()
        d.setdefault("tabs", {}).setdefault(tab, []).append(_new_note(text))
        save_idea_notes(d)
        return jsonify({"ok": True})

    @app.route("/api/ideanotes/all", methods=["GET"])
    def get_ideanotes_all():
        return jsonify({"tabs": load_idea_notes().get("tabs", {})})

    @app.route("/api/ideanotes/<tab>", methods=["GET"])
    def get_ideanotes(tab):
        notes = load_idea_notes().get("tabs", {}).get(tab, [])
        return jsonify({"tab": tab, "notes": notes})

    @app.route("/api/ideanote/remove", methods=["POST"])
    def remove_ideanote():
        data = request.json
        d = load_idea_notes()
        _remove_note(d, data.get("tab", ""), data.get("id", ""))
        save_idea_notes(d)
        return jsonify({"ok": True})

    @app.route("/api/ideanote/edit", methods=["POST"])
    def edit_ideanote():
        data = request.json
        tab = (data.get("tab") or "").strip()
        nid = data.get("id", "")
        text = (data.get("text") or "").strip()
        if not tab or not nid or not text:
            return jsonify({"error": "tab, id and text required"}), 400
        d = load_idea_notes()
        notes = d.get("tabs", {}).get(tab, [])
        for n in notes:
            if n.get("id") == nid:
                n["text"] = text
                break
        else:
            return jsonify({"error": "note not found"}), 404
        save_idea_notes(d)
        return jsonify({"ok": True})

    @app.route("/api/ideanote/restore", methods=["POST"])
    def restore_ideanote():
        data = request.json or {}
        _, err = _restore_note(data, load_idea_notes, save_idea_notes)
        if err:
            return err
        return jsonify({"ok": True})
