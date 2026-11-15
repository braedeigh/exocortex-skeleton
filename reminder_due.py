"""Is a recurring reminder due today? — the one server-side answer.

**What this is, in plain English.** The To-Do tile decides "due" in the
browser (frontend/src/features/todos/reminderMath.ts). Three things on the
server need the same answer, and they must never disagree with the tile or
with each other:

  * the phone push at a reminder's `push_at` time
    (scripts/todo_push_dispatcher.py);
  * the System message to the Keeper at that same time, for reminders with
    `tell_keeper` on (scripts/coming_up_dispatcher.py);
  * the "due today" line in the Keeper's wake package (comingup.format_block,
    printed by scripts/boot_context.py).

So the rule lives here once. Interval reminders are due once `every_days`
have passed since the last logged date (or if never logged); weekly ones are
due when nothing has been logged since the most recent scheduled weekday.
Track-mode reminders are silent and snoozed ones are hidden, as in the UI.

Stdlib only: todo_push_dispatcher.py runs under plain python3 from cron.

Prompt that produced this: "remind me to take my estradiol every 5 days ...
on the phone" / "remind me from my keeper as an injection into the context
like my other stuff, not something my keeper has to remember itself."
"""
from datetime import datetime, timedelta


def _days_between(a_iso, b_iso):
    a = datetime.strptime(a_iso, "%Y-%m-%d")
    b = datetime.strptime(b_iso, "%Y-%m-%d")
    return (b - a).days


def last_logged(reminder, entries, today):
    """The newest logged date for this reminder's type on or before `today`,
    or None if it was never logged."""
    rtype = reminder.get("type")
    dates = [e.get("date", "") for e in entries or []
             if isinstance(e, dict) and e.get("type") == rtype and e.get("date", "") <= today]
    return max(dates) if dates else None


def is_due(reminder, entries, today):
    """Mirrors computeReminderState's due test in reminderMath.ts — kept
    deliberately identical, so nothing on the server calls a reminder due
    that the To-Do page isn't showing as due."""
    if (reminder.get("schedule") or "interval") == "weekly":
        weekdays = reminder.get("weekdays") or []
        if not weekdays:
            return False
        base = datetime.strptime(today, "%Y-%m-%d")
        last_scheduled = None
        for i in range(7):
            day = base - timedelta(days=i)
            if (day.isoweekday() % 7) in weekdays:  # 0 = Sunday, as in JS getDay()
                last_scheduled = day.strftime("%Y-%m-%d")
                break
        if last_scheduled is None:
            return False
        rtype = reminder.get("type")
        return not any(isinstance(e, dict) and e.get("type") == rtype
                       and last_scheduled <= e.get("date", "") <= today
                       for e in entries or [])
    last = last_logged(reminder, entries, today)
    if last is None:
        return True
    return _days_between(last, today) >= (reminder.get("every_days") or 3)


def is_live(reminder, today):
    """Would this reminder speak at all today? Not track-mode (silent by
    design) and not snoozed, and it has the id and type everything keys on."""
    if not isinstance(reminder, dict) or not reminder.get("id") or not reminder.get("type"):
        return False
    if reminder.get("mode") == "track":
        return False
    snoozed = reminder.get("snoozed_until")
    return not (snoozed and snoozed > today)


def due_at_time(reminders, entries, now, want=None):
    """Every reminder that wants to speak at `now`, as (reminder, at) pairs:
    live, has a `push_at` that has arrived today, is due today, and passes
    `want(reminder)` if given (e.g. only the ones with tell_keeper on)."""
    today = now.strftime("%Y-%m-%d")
    out = []
    for reminder in (reminders or {}).get("reminders", []):
        if not is_live(reminder, today):
            continue
        push_at = (reminder.get("push_at") or "").strip()
        if not push_at or (want and not want(reminder)):
            continue
        try:
            at = datetime.strptime(f"{today} {push_at}", "%Y-%m-%d %H:%M")
        except ValueError:
            continue
        if at <= now and is_due(reminder, entries, today):
            out.append((reminder, at))
    return out


def due_today(reminders, entries, today, want=None):
    """Every live reminder due on `today` (YYYY-MM-DD) that passes `want` —
    the wake package's view, which doesn't care what time it is."""
    return [r for r in (reminders or {}).get("reminders", [])
            if is_live(r, today) and (not want or want(r)) and is_due(r, entries, today)]
