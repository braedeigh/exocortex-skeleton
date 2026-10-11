"""Coming up — dated things the Keeper should know are approaching.

**What this is, in plain English.** A small list of *events* (something happens
on a day: an appointment, a festival) and *topics* (something the owner wants
the Keeper to bring up on a day, or at an exact time). Each item says who made
it — `manual` (the owner, from the app) or `keeper` (proposed by a Keeper and
approved) — and, once a timed item has been delivered, when.

Two readers use it:
  * the wake — `scripts/boot_context.py` prints `format_block()` at the end of
    the Keeper's boot package, so a fresh Keeper wakes already knowing what's
    near ("in 3 days", "tomorrow", "today");
  * the clock — `scripts/coming_up_dispatcher.py` asks `due_to_fire()` every
    minute and sends a short system reminder into the pinned Keeper chat when
    an item's `remind_at` arrives. That's a separate moment from the item's
    own `time` (when the thing happens): a topic fires at its own time by
    default, an event only if it was given a reminder time.

To-dos with a `due_by` date are shown alongside, READ-ONLY: `todos.json`
stays the one truth for tasks, and nothing here writes it.

Storage is the `coming_up` collection through `store.py` — SQL-backed (a doc
in exo.db), with `coming_up.json` as its export mirror; never write the mirror.

Touches: `store.py` (SQL_COLLECTIONS lists `coming_up`), `scripts/boot_context.py`,
`scripts/coming_up_dispatcher.py`, `routes/coming_up.py`, `routes/pending.py`
(the `coming_up` approval kind), `tests/test_comingup.py`.

Prompt that produced this: "I want to inject it into the journal prompt ... a
reminder of an upcoming event surfacing on/before the day" / "prompt me to talk
about certain topics at certain times" / "I want times".
"""
import uuid
from datetime import date, datetime, timedelta

import store

COLLECTION = "coming_up"
KINDS = ("event", "topic")
CREATORS = ("manual", "keeper")
# pending → fired (delivered) | missed (the moment passed while nothing could
# deliver it) | dismissed (the owner cleared it; it never shows again).
STATUSES = ("pending", "fired", "missed", "dismissed")
DEFAULT_LEAD_DAYS = 14
# How far ahead a to-do's due date counts as "coming up".
TODO_LEAD_DAYS = 14
DATE_FORMAT = "%Y-%m-%d"
TIME_FORMAT = "%H:%M"


def _empty():
    return {"items": []}


def load_items():
    """Every item in the collection, whatever its status."""
    data = store.read(COLLECTION, _empty())
    items = data.get("items") if isinstance(data, dict) else None
    return [it for it in (items or []) if isinstance(it, dict)]


def _parse_date(value):
    try:
        return datetime.strptime(str(value or ""), DATE_FORMAT).date()
    except ValueError:
        return None


def _parse_time(value):
    try:
        return datetime.strptime(str(value or ""), TIME_FORMAT).time()
    except ValueError:
        return None


def _parse_moment(value):
    try:
        return datetime.strptime(str(value or ""), f"{DATE_FORMAT} {TIME_FORMAT}")
    except ValueError:
        return None


# --- Clean an item before it is stored -------------------------------------
# One door for every writer (the route, the approval commit, seed scripts), so
# the dispatcher and the wake never meet a half-formed item.

class ItemError(ValueError):
    """An item that can't be stored, with the reason in plain words."""


def clean_item(raw, created_by):
    """A stored-shape copy of `raw`, or ItemError saying what's wrong.

    Required: a title and a real date. Optional: a time ("HH:MM", when it
    happens), a `remind_at` ("YYYY-MM-DD HH:MM", when the system reminder
    fires — only items with one are ever pushed into a chat), an end date for
    multi-day events, a note, and a lead window in days."""
    if not isinstance(raw, dict):
        raise ItemError("item must be an object")
    if created_by not in CREATORS:
        raise ItemError(f"created_by must be one of {CREATORS}")
    title = str(raw.get("title") or "").strip()
    if not title:
        raise ItemError("title is required")
    kind = raw.get("kind") or "event"
    if kind not in KINDS:
        raise ItemError(f"kind must be one of {KINDS}")
    day = _parse_date(raw.get("date"))
    if day is None:
        raise ItemError("date must be YYYY-MM-DD")
    time_text = str(raw.get("time") or "").strip()
    if time_text and _parse_time(time_text) is None:
        raise ItemError("time must be HH:MM (24-hour)")
    end_text = str(raw.get("end_date") or "").strip()
    if end_text:
        end = _parse_date(end_text)
        if end is None or end < day:
            raise ItemError("end_date must be YYYY-MM-DD, on or after date")
    # When the reminder fires — a separate moment from when the thing happens.
    # A topic ("ask me at 6 PM") fires at its own time unless told otherwise;
    # an event fires only if given a remind_at, because a ping AT an
    # appointment's start time is too late to be any use.
    remind_at = str(raw.get("remind_at") or "").strip()
    if not remind_at and kind == "topic" and time_text:
        remind_at = f"{day.strftime(DATE_FORMAT)} {time_text}"
    if remind_at and _parse_moment(remind_at) is None:
        raise ItemError("remind_at must be 'YYYY-MM-DD HH:MM'")
    try:
        lead = int(raw.get("lead_days", DEFAULT_LEAD_DAYS))
    except (TypeError, ValueError):
        raise ItemError("lead_days must be a whole number")
    if lead < 0 or lead > 365:
        raise ItemError("lead_days must be between 0 and 365")
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:8]),
        "kind": kind,
        "title": title,
        "note": str(raw.get("note") or "").strip(),
        "date": day.strftime(DATE_FORMAT),
        "time": time_text,
        "end_date": end_text,
        "remind_at": remind_at,
        "lead_days": lead,
        "created_by": created_by,
        "created": raw.get("created") or datetime.now().strftime("%Y-%m-%d %H:%M"),
        "status": "pending",
        "fired_at": None,
    }


def add_item(raw, created_by):
    """Clean and append one item; returns the stored item."""
    item = clean_item(raw, created_by)
    with store.mutate(COLLECTION, _empty()) as data:
        data.setdefault("items", []).append(item)
    return item


def update_item(item_id, fields):
    """Edit one item: re-clean it with the new fields merged over the old, so
    an edit meets exactly the rules an add does. Who made it and when never
    change. A changed reminder time puts it back to `pending` so the new time
    can fire; anything else keeps its status. Returns the item, or None if
    there's no such id."""
    with store.mutate(COLLECTION, _empty()) as data:
        items = data.setdefault("items", [])
        for i, old in enumerate(items):
            if not isinstance(old, dict) or old.get("id") != item_id:
                continue
            merged = {**old, **(fields or {}), "id": item_id}
            # A topic's reminder that was only ever its own time (the default)
            # follows the time when the time changes — otherwise moving "ask
            # me at 6" to 7 would still ping at 6. A reminder set on purpose
            # stays put unless the edit names a new one.
            fields = fields or {}
            was_default = (old.get("kind") == "topic" and old.get("time")
                           and old.get("remind_at") == f"{old.get('date')} {old.get('time')}")
            if was_default and "remind_at" not in fields:
                merged["remind_at"] = ""
            new = clean_item(merged, old.get("created_by", "manual"))
            new["created"] = old.get("created") or new["created"]
            if new["remind_at"] != old.get("remind_at"):
                new["status"], new["fired_at"] = "pending", None
            else:
                new["status"], new["fired_at"] = old.get("status", "pending"), old.get("fired_at")
            items[i] = new
            return new
    return None


def set_status(item_id, status, fired_at=None):
    """Move one item to a new status. Returns True if the item was found."""
    if status not in STATUSES:
        raise ItemError(f"status must be one of {STATUSES}")
    found = False
    with store.mutate(COLLECTION, _empty()) as data:
        for it in data.get("items", []):
            if isinstance(it, dict) and it.get("id") == item_id:
                it["status"] = status
                if fired_at is not None:
                    it["fired_at"] = fired_at
                found = True
    return found


# --- What's near: the wake's view -------------------------------------------

def _is_visible(item, today):
    """Inside its lead window and not over yet. Dismissed items never show; a
    fired one keeps showing until its day passes, because delivering the
    reminder doesn't make the event any less upcoming."""
    if item.get("status") == "dismissed":
        return False
    start = _parse_date(item.get("date"))
    if start is None:
        return False
    end = _parse_date(item.get("end_date")) or start
    lead = item.get("lead_days", DEFAULT_LEAD_DAYS)
    if not isinstance(lead, int):
        lead = DEFAULT_LEAD_DAYS
    return start - timedelta(days=lead) <= today <= end


def _todo_rows(todos, today):
    """Open to-dos due between today and TODO_LEAD_DAYS out, as plain dicts.
    Same skip rules the phone push uses: the Done bucket, done items, and
    anything snoozed past today stay out."""
    horizon = today + timedelta(days=TODO_LEAD_DAYS)
    rows = []
    for key, section in (todos or {}).items():
        if key == "done" or not isinstance(section, dict):
            continue
        for it in section.get("items", []):
            if not isinstance(it, dict) or it.get("done"):
                continue
            due = _parse_date(it.get("due_by"))
            if due is None or not (today <= due <= horizon):
                continue
            snoozed = _parse_date(it.get("snoozed_until"))
            if snoozed and snoozed > today:
                continue
            rows.append({"title": str(it.get("text") or "").strip(),
                         "date": due.strftime(DATE_FORMAT),
                         "time": str(it.get("due_time") or "").strip(),
                         "todo_id": it.get("id")})
    return rows


def upcoming(today=None, todos=None):
    """Everything near, soonest first: (items, todo_rows)."""
    today = today or date.today()
    if todos is None:
        todos = store.read("todos", {})
    items = [it for it in load_items() if _is_visible(it, today)]
    items.sort(key=lambda it: (it.get("date") or "", it.get("time") or ""))
    rows = _todo_rows(todos, today)
    rows.sort(key=lambda r: (r["date"], r["time"]))
    return items, rows


def when_label(start_text, today, end_text=""):
    """'today' / 'tomorrow' / 'in N days', or 'on now, through <date>' for a
    multi-day event already under way."""
    start = _parse_date(start_text)
    if start is None:
        return ""
    end = _parse_date(end_text) or start
    if start < today <= end:
        return f"on now, through {end.strftime('%a %b %-d')}"
    days = (start - today).days
    if days == 0:
        return "today"
    if days == 1:
        return "tomorrow"
    return f"in {days} days"


def when_text(date_text, time_text, end_text=""):
    """A date (and time, and end date) as a person says it: 'Sat Oct 17–Sun
    Oct 18, 10:00 AM'."""
    start = _parse_date(date_text)
    text = start.strftime("%a %b %-d") if start else date_text
    end = _parse_date(end_text)
    if end and end != start:
        text += f"–{end.strftime('%a %b %-d')}"
    t = _parse_time(time_text)
    if t:
        text += ", " + datetime.combine(date.today(), t).strftime("%-I:%M %p")
    return text


def format_block(today=None, todos=None):
    """The Coming up section of the boot package, as markdown."""
    today = today or date.today()
    items, rows = upcoming(today, todos)
    lines = ["## Coming up", ""]
    if not items and not rows:
        lines.append("Nothing dated in the window.")
        return "\n".join(lines) + "\n"
    # One list, soonest first: events, topics and due to-dos interleaved by
    # date, so "in 5 days" never sits below "in 22 days".
    entries = []
    for it in items:
        label = when_label(it["date"], today, it.get("end_date", ""))
        what = "Bring up" if it.get("kind") == "topic" else "Event"
        who = "the keeper" if it.get("created_by") == "keeper" else "you"
        line = (f"- **{label}** — {what}: {it['title']} "
                f"({when_text(it['date'], it.get('time', ''), it.get('end_date', ''))}; "
                f"added by {who})")
        if it.get("note"):
            line += f" — {it['note']}"
        entries.append(((it["date"], it.get("time") or ""), line))
    for r in rows:
        label = when_label(r["date"], today)
        entries.append(((r["date"], r["time"]),
                        f"- **{label}** — To-do due: {r['title']} "
                        f"({when_text(r['date'], r['time'])}; to-do {r['todo_id']})"))
    entries.sort(key=lambda pair: pair[0])
    lines.extend(line for _, line in entries)
    return "\n".join(lines) + "\n"


# --- What's due now: the clock's view ----------------------------------------

def due_to_fire(now=None):
    """Pending items whose `remind_at` has arrived, oldest first, as
    (item, due_datetime) pairs. Items with no remind_at never fire — they live
    in the wake's Coming up block only."""
    now = now or datetime.now()
    out = []
    for it in load_items():
        if it.get("status") != "pending":
            continue
        due_at = _parse_moment(it.get("remind_at"))
        if due_at is None:
            continue
        if due_at <= now:
            out.append((it, due_at))
    out.sort(key=lambda pair: pair[1])
    return out
