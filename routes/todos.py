"""Todos and applications routes."""
from flask import request, jsonify
from datetime import datetime
from pathlib import Path
from data_helpers import find_section_key
import store
import subprocess
import sys
import uuid


def _load_apps():
    return store.read("shrike_applied.json", [])


def _save_apps(apps):
    store.write("shrike_applied.json", apps)


def _match(item, ident):
    """A to-do is identified by its stable id; fall back to its text for any
    legacy caller still sending the raw text."""
    return item.get("id") == ident or item.get("text") == ident


def _clean_fronts(val):
    """Front ids (fronts.json) as a deduped list. Accepts a list, or a single
    string for any legacy caller still sending the pre-list `theme` field;
    None/empties -> []."""
    if isinstance(val, str):
        val = [val]
    out = []
    for v in val or []:
        v = str(v).strip()
        if v and v not in out:
            out.append(v)
    return out


def _apply_fronts(item, data):
    """Set/clear a to-do's `fronts` list from a payload. `fronts` (list) is
    the real contract; `theme` (single string) is accepted as a legacy alias.
    An empty value clears, same as the string attrs (absent = untagged)."""
    if "fronts" not in data and "theme" not in data:
        return
    fronts = _clean_fronts(data["fronts"] if "fronts" in data else data.get("theme"))
    if fronts:
        item["fronts"] = fronts
    else:
        item.pop("fronts", None)


# The journal engine (tools/stream/stream.py) weaves "marked to-do complete"
# lines into Journal/Daily/<day>.md, computed live from todos.json — see its
# render_day_text / todo_completion_markers. That weave is only as fresh as
# the last render, and markdowns otherwise only re-render when a card lands,
# so any write here that changes a completion fact (done/undone, or the
# finished_* fields) fires a fire-and-forget re-render of the affected day(s).
_STREAM_SCRIPT = Path(__file__).resolve().parent.parent / "tools" / "stream" / "stream.py"


def _rerender_days(*days):
    """Best-effort `stream.py render --day <day>` for each distinct, truthy day
    in `days`. Must never raise and never affect the caller's response — the
    journal engine can be entirely unavailable (no TULKU_STREAM_ROOT /
    EXOCORTEX_CONTENT_DIR configured, as in the route test env) and this is
    just a silent no-op in that case."""
    seen = set()
    for day in days:
        if not day or day in seen:
            continue
        seen.add(day)
        try:
            subprocess.run(
                [sys.executable, str(_STREAM_SCRIPT), "render", "--day", day],
                capture_output=True, text=True, timeout=10,
            )
        except Exception:
            pass


def _graduate_linked_buy(parent_id, sub_id):
    """The to-do → buy half of the bridge: when a shopping item is checked done,
    move its linked buy-list item into owned inventory. Finds the buy item by its
    {'parent','sub'} link, then hands off to inventory.graduate_buy_item.
    Best-effort — never raises into the toggle's response.

    Prompt: "if I check one off, the UI and data interact" — a to-do and a buy
    item can mirror each other; checking the to-do graduates the buy item."""
    try:
        bdata = store.read("buy_list.json", {"items": []})
        match = next(
            (i for i in bdata["items"]
             if isinstance(i.get("todo"), dict)
             and i["todo"].get("parent") == parent_id
             and i["todo"].get("sub") == sub_id),
            None,
        )
        if match:
            from routes.inventory import graduate_buy_item
            graduate_buy_item(match["name"])
    except Exception:
        pass


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
                # Optional attributes from the add modal's "More details" —
                # same vocabulary the detail editor manages.
                for f in ("due_time", "place_id", "after_date", "after_id"):
                    val = (data.get(f) or "").strip()
                    if val:
                        new_item[f] = val
                _apply_fronts(new_item, data)
                try:
                    dm = int(data.get("duration_min") or 0)
                except (TypeError, ValueError):
                    dm = 0
                if dm > 0:
                    new_item["duration_min"] = dm
                # New items land on top. In auto-sorted buckets the sort re-floats
                # them anyway (created desc); in manually-ordered buckets this is
                # what keeps a fresh add above the older + checked-off rows.
                sec["items"].insert(0, new_item)
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
    # after_date/after_id back the "do after" feature: a to-do stays hidden
    # (client-side, same model as snooze) until the date arrives or the
    # referenced to-do is done/gone. Life-domain tagging is the `fronts` LIST
    # (ids from fronts.json, same shape as research topics — see
    # _apply_fronts); the old single `theme` string and free-standing
    # `category` tag were retired 2026-07-14. finished_on ('YYYY-MM-DD') +
    # finished_time ('HH:MM') record when a to-do was ACTUALLY done,
    # assignable by hand from the edit form — distinct from `done_at`, which
    # is auto-stamped by the toggle handler for when she MARKED it done (now
    # minute-precision, see toggle_todo). finished_note is an optional
    # completion note — "how it went" — distinct from the item's description
    # `notes`.
    TODO_STR_FIELDS = ("notes", "due_by", "due_time", "place_id",
                        "after_date", "after_id", "finished_on", "finished_time",
                        "finished_note")

    @app.route("/api/todos/details", methods=["POST"])
    def todo_details():
        """Set optional attributes on a to-do (empty clears). Only the fields
        present in the payload are touched, so the inline notes editor and the
        detail modal can each send just what they manage. Handles notes/due_by
        plus the scheduling/place/category/duration/after attributes."""
        data = request.json or {}
        ident = data.get("id") or data.get("item", "")
        # finished_on/finished_time/finished_note all feed the journal weave's
        # marker rule — re-render if the patch touches any of them (old +
        # new finished_on day, plus done_at's day, cover every day the marker
        # could have moved from/to).
        touches_finish = any(f in data for f in ("finished_on", "finished_time", "finished_note"))
        rerender_days = []
        matched = False
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                for item in todos[key].get("items", []):
                    if _match(item, ident):
                        matched = True
                        old_finished_on = item.get("finished_on")
                        for f in TODO_STR_FIELDS:
                            if f in data:
                                val = (data.get(f) or "").strip()
                                if val:
                                    item[f] = val
                                else:
                                    item.pop(f, None)
                        _apply_fronts(item, data)
                        if "duration_min" in data:
                            try:
                                dm = int(data.get("duration_min") or 0)
                            except (TypeError, ValueError):
                                dm = 0
                            if dm > 0:
                                item["duration_min"] = dm
                            else:
                                item.pop("duration_min", None)
                        if touches_finish:
                            rerender_days.append(old_finished_on)
                            rerender_days.append(item.get("finished_on"))
                            done_at = item.get("done_at") or ""
                            if done_at:
                                rerender_days.append(done_at[:10])
                        break
                if matched:
                    break
        _rerender_days(*rerender_days)
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

    @app.route("/api/todos/bulk", methods=["POST"])
    def bulk_todos():
        """Apply one action to many to-dos in a single atomic write:
        {"ids": [...], "action": "details"|"snooze"|"move"|"remove"} plus
        "patch" (details), "days" (snooze), or "to_section" (move). Missing
        ids are not an error — an id can vanish between poll and tap — so
        matched items are updated and the rest come back in "missing"."""
        from datetime import timedelta
        data = request.json or {}
        action = data.get("action")
        if action not in ("details", "snooze", "move", "remove"):
            return jsonify({"error": "Unknown action"}), 400
        to_key = None
        if action == "move":
            to_key = find_section_key(data.get("to_section", ""))
            if not to_key:  # checked before mutate so nothing is touched
                return jsonify({"error": "Section not found"}), 404
        idents = set(data.get("ids") or [])
        if not idents:
            return jsonify({"ok": True, "updated": 0, "missing": []})
        patch = data.get("patch") or {}
        days = int(data.get("days", 0) or 0)

        def _hits(item):
            """Idents this item answers to (id, plus text as legacy fallback)."""
            return {v for v in (item.get("id"), item.get("text")) if v in idents}

        found = set()
        updated = 0
        with store.mutate("todos", {}) as todos:
            moved = []
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                items = todos[key].get("items", [])
                if action in ("move", "remove"):
                    keep = []
                    for item in items:
                        hit = _hits(item)
                        if not hit:
                            keep.append(item)
                            continue
                        found.update(hit)
                        if action == "move" and key == to_key:
                            keep.append(item)  # already home — don't churn order
                        else:
                            if action == "move":
                                moved.append(item)
                            updated += 1
                    todos[key]["items"] = keep
                else:
                    for item in items:
                        hit = _hits(item)
                        if not hit:
                            continue
                        found.update(hit)
                        updated += 1
                        if action == "snooze":
                            if days > 0:
                                item["snoozed_until"] = (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d")
                            else:
                                item.pop("snoozed_until", None)
                        else:  # details — same set/clear contract as /details
                            for f in TODO_STR_FIELDS:
                                if f in patch:
                                    val = (patch.get(f) or "").strip()
                                    if val:
                                        item[f] = val
                                    else:
                                        item.pop(f, None)
                            _apply_fronts(item, patch)
                            if "duration_min" in patch:
                                try:
                                    dm = int(patch.get("duration_min") or 0)
                                except (TypeError, ValueError):
                                    dm = 0
                                if dm > 0:
                                    item["duration_min"] = dm
                                else:
                                    item.pop("duration_min", None)
            if action == "move":
                todos.setdefault(to_key, {"items": []}).setdefault("items", []).extend(moved)
        return jsonify({"ok": True, "updated": updated,
                        "missing": sorted(i for i in idents if i not in found)})

    @app.route("/api/todos/toggle", methods=["POST"])
    def toggle_todo():
        data = request.json
        ident = data.get("id") or data.get("item", "")
        # Days whose journal weave needs a re-render — collected while the store
        # is still open, fired only after `with` exits (so the subprocess reads
        # the write we just made, not a stale todos.json).
        rerender_days = []
        matched = False
        toggled_id = None
        now_done = False
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                items = todos[key].get("items", [])
                for item in items:
                    if _match(item, ident):
                        matched = True
                        toggled_id = item.get("id")
                        item["done"] = not item["done"]
                        now_done = item["done"]
                        items.remove(item)
                        if item["done"]:
                            # done_at = when she MARKED it done, now stamped to
                            # minute precision ('YYYY-MM-DDTHH:MM'); it lingers
                            # struck-through in place today, then load_todos
                            # sweeps it to Done. Legacy items carry date-only
                            # values ('YYYY-MM-DD') — every reader must treat
                            # the day part as done_at[:10], never compare the
                            # raw string against a bare date for equality.
                            item["done_at"] = datetime.now().strftime("%Y-%m-%dT%H:%M")
                            # Checking the main task marks every sub-task done too;
                            # un-checking leaves them as they are (no symmetric undo).
                            for sub in item.get("subtasks", []):
                                sub["done"] = True
                            items.append(item)
                            rerender_days.append(item["done_at"][:10])
                        else:
                            old_done_at = item.pop("done_at", None)
                            items.insert(0, item)
                            if old_done_at:
                                rerender_days.append(old_done_at[:10])
                        if item.get("finished_on"):
                            rerender_days.append(item["finished_on"])
                        break
                if matched:
                    break
        _rerender_days(*rerender_days)
        # bridge: checking a standalone shopping to-do (sub=None link, e.g. the
        # vacuum / kitchen table) graduates its linked buy-list item into owned
        # inventory. Parent cards aren't linked, so bulk-checking one won't
        # cascade — graduation fires on the item actually toggled.
        if now_done and toggled_id:
            _graduate_linked_buy(toggled_id, None)
        return jsonify({"ok": True})

    @app.route("/api/todos/cleared", methods=["GET"])
    def cleared_todos():
        """Done to-dos whose EFFECTIVE completion day == ?date (finished_on
        if set, else done_at — compared by day part only, since done_at may
        carry minute precision while finished_on and ?date are date-only).
        Each row is enriched with `marked` (raw done_at, when present — the
        frontend formats it) and `note` (finished_note, when present).
        Also returns `marked_items`: the journal stream weaves these
        between entries by time. A marker sits at the most precise
        moment she's claimed — finished_on + finished_time when she set
        them, else the tap stamp's minute. A claim or stamp with no
        minute has no position to stand on, so it stays out of
        marked_items (the summary card still shows it). Scans every bucket: items finished today are
        still in their ladder bucket until tomorrow's sweep
        (_sweep_done_todos only archives done_at < today). Reads the
        store raw on purpose — load_todos() would trigger the sweep's
        write, and a GET must not mutate data."""
        date = (request.args.get("date") or "").strip()
        if not date:
            return jsonify({"items": [], "marked_items": []})
        todos = store.read("todos", {})
        items = []
        marked_items = []
        for sec in todos.values():
            if not isinstance(sec, dict):
                continue
            for item in sec.get("items", []):
                if not (isinstance(item, dict) and item.get("done")):
                    continue
                done_at = item.get("done_at") or ""
                # The marker's moment: her edited claim when it carries a
                # time, else the tap stamp when it carries a minute. A
                # day-only claim deliberately yields NO marker — the claim
                # overrides the tap, and it has no minute to stand on.
                if item.get("finished_on"):
                    marker_day = item["finished_on"] if item.get("finished_time") else None
                    marker_time = item.get("finished_time")
                elif len(done_at) > 10:
                    marker_day, marker_time = done_at[:10], done_at[11:16]
                else:
                    marker_day = None
                if marker_day == date:
                    marked_items.append({
                        "id": item.get("id"),
                        "text": item.get("text", ""),
                        "time": marker_time,
                    })
                # done_at may carry minute precision ('YYYY-MM-DDTHH:MM');
                # finished_on is always date-only. Compare day parts only.
                effective = (item.get("finished_on") or done_at)[:10]
                if effective != date:
                    continue
                row = {"id": item.get("id"), "text": item.get("text", "")}
                if item.get("finished_on") and item.get("finished_time"):
                    row["time"] = item["finished_time"]
                if item.get("fronts"):
                    row["fronts"] = item["fronts"]
                if item.get("done_at"):
                    row["marked"] = item["done_at"]
                if item.get("finished_note"):
                    row["note"] = item["finished_note"]
                items.append(row)
        items.sort(key=lambda r: ("time" not in r, r.get("time", "")))
        marked_items.sort(key=lambda r: r["time"])
        return jsonify({"items": items, "marked_items": marked_items})

    @app.route("/api/todos/subtask/add", methods=["POST"])
    def add_subtask():
        data = request.json or {}
        ident = data.get("id") or data.get("item", "")
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"ok": True})
        sub_id = uuid.uuid4().hex[:8]
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                for item in todos[key].get("items", []):
                    if _match(item, ident):
                        item.setdefault("subtasks", []).append(
                            {"id": sub_id, "text": text, "done": False}
                        )
                        return jsonify({"ok": True, "sub_id": sub_id})
        return jsonify({"ok": True})

    @app.route("/api/todos/subtask/toggle", methods=["POST"])
    def toggle_subtask():
        data = request.json or {}
        ident = data.get("id") or data.get("item", "")
        sub_id = data.get("sub_id")
        parent_id = None
        became_done = False
        with store.mutate("todos", {}) as todos:
            found = False
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                for item in todos[key].get("items", []):
                    if _match(item, ident):
                        parent_id = item.get("id")
                        for sub in item.get("subtasks", []):
                            if sub.get("id") == sub_id:
                                sub["done"] = not sub["done"]
                                became_done = sub["done"]
                                break
                        found = True
                        break
                if found:
                    break
        # bridge: checking a linked shopping subtask graduates its buy-list item
        # into owned inventory. Run AFTER the mutate closes so the buy/active
        # writes can't deadlock on the todos lock we just held.
        if became_done:
            _graduate_linked_buy(parent_id, sub_id)
        return jsonify({"ok": True})

    @app.route("/api/todos/subtask/remove", methods=["POST"])
    def remove_subtask():
        data = request.json or {}
        ident = data.get("id") or data.get("item", "")
        sub_id = data.get("sub_id")
        with store.mutate("todos", {}) as todos:
            for key in todos:
                if not isinstance(todos[key], dict):
                    continue
                for item in todos[key].get("items", []):
                    if _match(item, ident):
                        subs = [s for s in item.get("subtasks", []) if s.get("id") != sub_id]
                        if subs:
                            item["subtasks"] = subs
                        else:
                            item.pop("subtasks", None)
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
