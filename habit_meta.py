"""Per-habit configuration overlay — currently: time-limited *courses*.

A "course" habit (e.g. a 10-day antibiotic) auto-archives off the daily list when
it finishes, but its checkmark history is kept. State is keyed by the same
'section|text' log key as everything else; a plain permanent habit is simply absent
from the file — a pure overlay, like habit_cadence. The actual archive/expiry is
derived from the dates (no persisted flag), so the frontend and these helpers agree.
"""
from datetime import date, datetime
import store

META_FILE = "habit_meta.json"


def load():
    return store.read(META_FILE, {})


def course_day(entry, today=None):
    """1-based day number within the course (day 1 = the start day), or None."""
    if not entry or not entry.get("course_days") or not entry.get("course_start"):
        return None
    start = datetime.strptime(entry["course_start"], "%Y-%m-%d").date()
    return ((today or date.today()) - start).days + 1


def is_expired(entry, today=None):
    """True once the course's final day has passed."""
    d = course_day(entry, today)
    return d is not None and d > entry["course_days"]
