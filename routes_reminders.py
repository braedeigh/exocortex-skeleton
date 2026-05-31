"""Recurring reminders — the configurable list behind the To-Do "pops".

The whole list is saved at once from the manage modal; logging a "done"
goes through the existing /api/activity/log route, so the day-counts come
from activity_log just like the original hardcoded linen reminders did.
"""
from flask import request, jsonify
import store
import re
import uuid


VALID_MODES = ("log", "countdown", "track")

DEFAULT_COLOR = "#9AA0B5"


def _load():
    return store.read("reminders.json", {"reminders": []})


def _save(data):
    store.write("reminders.json", data)


def _slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", str(s or "").strip().lower()).strip("-")
    return s or "reminder"


def _coerce_days(value, fallback):
    try:
        n = int(value)
        return n if n >= 1 else fallback
    except (TypeError, ValueError):
        return fallback


def _coerce_weekdays(value):
    """Accept a list of ints 0-6 (0=Sunday). De-dupe, clamp, sort."""
    out = []
    if isinstance(value, list):
        for x in value:
            try:
                n = int(x)
            except (TypeError, ValueError):
                continue
            if 0 <= n <= 6 and n not in out:
                out.append(n)
    out.sort()
    return out


def _coerce_reminder(raw):
    """Sanitize one reminder dict into the stored shape."""
    if not isinstance(raw, dict):
        return None
    label = str(raw.get("label", "")).strip()
    if not label:
        return None
    every = _coerce_days(raw.get("every_days"), 3)
    overdue = _coerce_days(raw.get("overdue_days"), every * 2)
    if overdue < every:
        overdue = every
    mode = str(raw.get("mode", "log")).strip().lower()
    if mode not in VALID_MODES:
        mode = "log"
    schedule = str(raw.get("schedule", "interval")).strip().lower()
    if schedule not in ("interval", "weekly"):
        schedule = "interval"
    weekdays = _coerce_weekdays(raw.get("weekdays"))
    # A weekly schedule with no days selected is meaningless — fall back to interval.
    if schedule == "weekly" and not weekdays:
        schedule = "interval"
    rid = str(raw.get("id", "")).strip() or ("rem_" + uuid.uuid4().hex[:8])
    rtype = str(raw.get("type", "")).strip() or _slug(label)
    color = str(raw.get("color", "")).strip() or DEFAULT_COLOR
    # Optional paired reminder: logging this one prompts "did you also …?" for the
    # companion (referenced by its activity type, e.g. sheets → wash-eyemasks).
    companion = str(raw.get("companion", "")).strip()
    return {
        "id": rid,
        "emoji": str(raw.get("emoji", "")).strip()[:4],
        "label": label,
        "type": rtype,
        "color": color,
        "schedule": schedule,
        "every_days": every,
        "overdue_days": overdue,
        "weekdays": weekdays,
        "mode": mode,
        "companion": companion,
    }


def register(app):

    @app.route("/api/reminders/save", methods=["POST"])
    def save_reminders():
        body = request.json or {}
        incoming = body.get("reminders")
        if not isinstance(incoming, list):
            return jsonify({"error": "reminders must be a list"}), 400
        cleaned = [r for r in (_coerce_reminder(x) for x in incoming) if r]
        _save({"reminders": cleaned})
        return jsonify({"ok": True, "reminders": cleaned})
