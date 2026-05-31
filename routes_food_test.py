"""Food experiments — controlled elimination diet pacing.

One active test at a time. After a flared test, you're in 'recovering' state
until you manually mark baseline clear — enforces the rest window the user
asked for. Auto-tags safe/suspect on catalog items when test outcomes resolve.
"""
from flask import request, jsonify
from data_helpers import DATA_DIR
from datetime import datetime, timedelta
import store
import uuid


KITCHEN_PATH = DATA_DIR / "kitchen.json"


def _load_tests():
    return store.read("food_tests.json", {"tests": []})


def _save_tests(d):
    store.write("food_tests.json", d)


def _load_queue():
    return store.read("test_queue.json", {"queue": []})


def _save_queue(d):
    store.write("test_queue.json", d)


def _set_safety_tag(food, tag):
    """Auto-apply a safety tag if the food name matches a single catalog item.
    Skips combo strings ('beans + ACV') — those have spaces around '+' and don't match anything."""
    name = (food or "").strip().lower()
    if not name or '+' in name:
        return
    if not KITCHEN_PATH.exists():
        return
    gdata = store.read("kitchen.json")
    known = gdata.get("category_map", {})
    if name not in known:
        return  # not in catalog, can't tag
    tags = gdata.setdefault("safety_tags", {})
    if tag:
        tags[name] = tag
    else:
        tags.pop(name, None)
    store.write("kitchen.json", gdata)


def _today_str():
    return datetime.now().strftime("%Y-%m-%d")


def _add_days(date_str, days):
    d = datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=int(days))
    return d.strftime("%Y-%m-%d")


def _active_test(data):
    """Return the currently-active test, if any. A test is 'active' if outcome is null."""
    return next((t for t in data["tests"] if not t.get("outcome")), None)


def _recovering(data):
    """Return the most recent flared test that hasn't been baseline-cleared yet."""
    for t in reversed(data["tests"]):
        if t.get("outcome") == "flared" and not t.get("cleared_baseline_on"):
            return t
    return None


def _state(data):
    if _active_test(data):
        return "testing"
    if _recovering(data):
        return "recovering"
    return "clear"


def register(app):

    @app.route("/api/body/test/state", methods=["GET"])
    def test_state():
        data = _load_tests()
        queue = _load_queue()["queue"]
        return jsonify({
            "state": _state(data),
            "active": _active_test(data),
            "recovering": _recovering(data),
            "queue": queue,
            "tests": data["tests"],
        })

    @app.route("/api/body/test/start", methods=["POST"])
    def test_start():
        body = request.json or {}
        food = (body.get("food") or "").strip()
        if not food:
            return jsonify({"error": "missing food"}), 400
        data = _load_tests()
        if _active_test(data):
            return jsonify({"error": "A test is already active"}), 400
        if _recovering(data):
            return jsonify({"error": "You're recovering from a flared test. Mark baseline clear first."}), 400
        watch_days = int(body.get("watch_window_days") or 3)
        started_on = (body.get("started_on") or _today_str()).strip()
        new_test = {
            "id": uuid.uuid4().hex[:12],
            "food": food,
            "started_on": started_on,
            "watch_window_days": watch_days,
            "results_due_on": _add_days(started_on, watch_days),
            "outcome": None,
            "outcome_at": None,
            "flare_notes": "",
            "cleared_baseline_on": None,
            "notes": (body.get("notes") or "").strip(),
        }
        data["tests"].append(new_test)
        # Remove from queue if it was queued
        q = _load_queue()
        q["queue"] = [f for f in q["queue"] if f.lower() != food.lower()]
        _save_queue(q)
        _save_tests(data)
        return jsonify({"ok": True, "test": new_test})

    @app.route("/api/body/test/outcome", methods=["POST"])
    def test_outcome():
        body = request.json or {}
        tid = body.get("id")
        outcome = (body.get("outcome") or "").strip().lower()
        if outcome not in ("cleared", "flared"):
            return jsonify({"error": "outcome must be cleared or flared"}), 400
        data = _load_tests()
        test = next((t for t in data["tests"] if t.get("id") == tid), None)
        if not test:
            return jsonify({"error": "test not found"}), 404
        test["outcome"] = outcome
        test["outcome_at"] = _today_str()
        if outcome == "flared":
            test["flare_notes"] = (body.get("flare_notes") or test.get("flare_notes") or "").strip()
            _set_safety_tag(test["food"], "suspect")
            # No cleared_baseline_on — user must mark it manually before next test
        else:
            test["cleared_baseline_on"] = _today_str()  # auto-clear baseline on a passed test
            _set_safety_tag(test["food"], "safe")
        _save_tests(data)
        return jsonify({"ok": True, "test": test})

    @app.route("/api/body/test/extend", methods=["POST"])
    def test_extend():
        body = request.json or {}
        tid = body.get("id")
        days = int(body.get("days") or 2)
        data = _load_tests()
        test = next((t for t in data["tests"] if t.get("id") == tid), None)
        if not test:
            return jsonify({"error": "test not found"}), 404
        if test.get("outcome"):
            return jsonify({"error": "test already resolved"}), 400
        test["watch_window_days"] = int(test.get("watch_window_days", 3)) + days
        test["results_due_on"] = _add_days(test["started_on"], test["watch_window_days"])
        _save_tests(data)
        return jsonify({"ok": True, "test": test})

    @app.route("/api/body/test/cancel", methods=["POST"])
    def test_cancel():
        body = request.json or {}
        tid = body.get("id")
        data = _load_tests()
        data["tests"] = [t for t in data["tests"] if t.get("id") != tid]
        _save_tests(data)
        return jsonify({"ok": True})

    @app.route("/api/body/test/clear-baseline", methods=["POST"])
    def test_clear_baseline():
        """Mark recovery complete — required after a flared test before the user can start the next one."""
        data = _load_tests()
        rec = _recovering(data)
        if not rec:
            return jsonify({"error": "not in recovering state"}), 400
        rec["cleared_baseline_on"] = _today_str()
        _save_tests(data)
        return jsonify({"ok": True, "test": rec})

    @app.route("/api/body/test/log-retro", methods=["POST"])
    def test_log_retro():
        """Log a flared event retroactively — for when a flare happened from
        normal eating, not from a formal test. Creates an instant flared-test entry.
        Body: {food, started_on?, flare_notes?}"""
        body = request.json or {}
        food = (body.get("food") or "").strip()
        if not food:
            return jsonify({"error": "missing food"}), 400
        data = _load_tests()
        if _active_test(data):
            return jsonify({"error": "A test is already active — resolve it first"}), 400
        started_on = (body.get("started_on") or _today_str()).strip()
        new_test = {
            "id": uuid.uuid4().hex[:12],
            "food": food,
            "started_on": started_on,
            "watch_window_days": 3,
            "results_due_on": _add_days(started_on, 3),
            "outcome": "flared",
            "outcome_at": _today_str(),
            "flare_notes": (body.get("flare_notes") or "").strip(),
            "cleared_baseline_on": None,
            "notes": "Logged retroactively (real-life flare, not a formal test).",
        }
        data["tests"].append(new_test)
        _set_safety_tag(food, "suspect")
        _save_tests(data)
        return jsonify({"ok": True, "test": new_test})

    @app.route("/api/body/test/queue/add", methods=["POST"])
    def queue_add():
        body = request.json or {}
        food = (body.get("food") or "").strip()
        if not food:
            return jsonify({"error": "missing food"}), 400
        q = _load_queue()
        if any(f.lower() == food.lower() for f in q["queue"]):
            return jsonify({"error": "already in queue"}), 400
        q["queue"].append(food)
        _save_queue(q)
        return jsonify({"ok": True, "queue": q["queue"]})

    @app.route("/api/body/test/queue/remove", methods=["POST"])
    def queue_remove():
        body = request.json or {}
        food = (body.get("food") or "").strip().lower()
        q = _load_queue()
        q["queue"] = [f for f in q["queue"] if f.lower() != food]
        _save_queue(q)
        return jsonify({"ok": True, "queue": q["queue"]})

    @app.route("/api/body/test/queue/reorder", methods=["POST"])
    def queue_reorder():
        body = request.json or {}
        order = body.get("order") or []
        q = _load_queue()
        # Only keep items currently in the queue, in the new order; ignore unknowns
        existing_lower = {f.lower(): f for f in q["queue"]}
        new_queue = []
        for f in order:
            key = (f or "").strip().lower()
            if key in existing_lower:
                new_queue.append(existing_lower[key])
                del existing_lower[key]
        # Append anything that wasn't in the order to the end
        new_queue.extend(existing_lower.values())
        q["queue"] = new_queue
        _save_queue(q)
        return jsonify({"ok": True, "queue": q["queue"]})
