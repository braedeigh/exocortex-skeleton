"""The journal's day pages: which days have an entry, read one, save one.

**What this does, in plain English.** Each day of the journal is one markdown
file, `Journal/Daily/YYYY-MM-DD.md`, in the content folder. These three doors
are how the Journal page lists the days, opens one (with the day before and
after it, so the arrows work), and saves an edit. The files themselves are
rendered from the card pool (`routes/cards.py`); this module only reads and
writes the finished pages.

They used to sit inside `server.py`. They are their own module so the desktop
app's small server (`standalone_app.py`), which never loads `server.py`, can
serve the same doors.

Touches: `store.py` (the content folder, the atomic text write),
`server.py` and `standalone_app.py` (both register this).
"""
from datetime import datetime

from flask import jsonify, request

import store


def _daily_dir():
    """The folder the day pages live in. Read at call time so a test that
    points the store somewhere else is followed."""
    return store.CONTENT_DIR / "Journal" / "Daily"


def _dates():
    """Every day that has a page, oldest first. A folder that isn't there yet
    is simply no days."""
    return sorted(page.stem for page in _daily_dir().glob("*.md"))


def _is_date(text):
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def register(app):
    @app.route("/api/journal/dates")
    def journal_dates():
        return jsonify({"dates": _dates()})

    @app.route("/api/journal/<date>")
    def journal_get(date):
        if not _is_date(date):
            return jsonify({"error": "invalid date"}), 400
        path = _daily_dir() / f"{date}.md"
        content = path.read_text() if path.exists() else ""
        # The arrows: prev is the newest day strictly before this one, next
        # the oldest strictly after. Worked out whether or not this day has a
        # page itself, so an empty today still steps back.
        dates = _dates()
        earlier = [day for day in dates if day < date]
        later = [day for day in dates if day > date]
        return jsonify({"date": date, "content": content,
                        "prev": earlier[-1] if earlier else None,
                        "next": later[0] if later else None})

    @app.route("/api/journal/<date>", methods=["POST"])
    def journal_save(date):
        if not _is_date(date):
            return jsonify({"error": "invalid date"}), 400
        content = (request.json or {}).get("content", "")
        store.write_text_file(_daily_dir() / f"{date}.md", content)
        return jsonify({"ok": True})
