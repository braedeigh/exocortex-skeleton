"""Coming up — the routes behind the To-dos page's Coming up card.

**What this does, in plain English.** Lists what's near (events, topics, and
to-dos due soon — the same view the Keeper wakes with), and lets the owner add,
edit and clear items by hand. Items made here are marked `created_by: manual`
and skip approval, because she's the one making them. A Keeper's proposals come
in the other door (scripts/coming_up_propose.py → the approval queue →
routes/pending.py) and land marked `keeper`.

    GET  /api/coming_up                 what's near + every item
    POST /api/coming_up                 add one (JSON item)
    POST /api/coming_up/<id>            edit one (JSON fields)
    POST /api/coming_up/<id>/dismiss    clear it — never shown or sent again

All of it goes through comingup.py; the collection is SQL-backed, so nothing
here touches coming_up.json.

Prompt that produced this: "record whether it was created manually or by the
keeper" / "14 yes skip approval" (her own items don't need approving).
"""
from datetime import date

from flask import jsonify, request

import comingup


def register(app):

    @app.route("/api/coming_up")
    def coming_up_list():
        """What's near, soonest first, plus every item that isn't dismissed
        (so she can see and edit things that aren't in the window yet)."""
        today = date.today()
        items, todos = comingup.upcoming(today)
        near_ids = {it["id"] for it in items}
        everything = [it for it in comingup.load_items()
                      if it.get("status") != "dismissed"]
        everything.sort(key=lambda it: (it.get("date") or "", it.get("time") or ""))
        return jsonify({
            "today": today.isoformat(),
            "near": [dict(it, when=comingup.when_label(it["date"], today, it.get("end_date", "")))
                     for it in items],
            "todos": [dict(r, when=comingup.when_label(r["date"], today)) for r in todos],
            "items": [dict(it, near=it["id"] in near_ids) for it in everything],
        })

    @app.route("/api/coming_up", methods=["POST"])
    def coming_up_add():
        try:
            item = comingup.add_item(request.json or {}, "manual")
        except comingup.ItemError as e:
            return jsonify({"error": str(e)}), 400
        return jsonify({"ok": True, "item": item})

    @app.route("/api/coming_up/<item_id>", methods=["POST"])
    def coming_up_edit(item_id):
        """Edit an item's fields. Who made it never changes, and editing a
        reminder's time puts it back to pending so the new time can fire."""
        try:
            item = comingup.update_item(item_id, request.json or {})
        except comingup.ItemError as e:
            return jsonify({"error": str(e)}), 400
        if item is None:
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True, "item": item})

    @app.route("/api/coming_up/<item_id>/dismiss", methods=["POST"])
    def coming_up_dismiss(item_id):
        if not comingup.set_status(item_id, "dismissed"):
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True})
