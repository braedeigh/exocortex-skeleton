#!/usr/bin/env python3
"""Log (or un-log) a reminder's activity from the command line — the Keeper's
door into activity_log.json.

Plain English: when she says in chat "took my estradiol last night", the
Keeper runs

    python3 /opt/exocortex/skeleton/scripts/log_activity.py estradiol --date 2026-11-12

and the dose lands in the same log the To-Do tile writes when she taps it, so
the reminder's day-count resets and its phone push stops. `--remove` takes a
wrong entry back out. It writes exactly what /api/activity/log and
/api/activity/remove (routes/health.py) write — one {"date", "type"} row, at
most one per type per day — so the app can't tell the two doors apart.

The type must be one her reminders.json actually has (a type or a label —
"Estradiol" finds "estradiol"). A typo is refused, not invented: a row for a
type no reminder reads is a dose the tile would never see.

This is the ONE sanctioned exception to "the Keeper doesn't edit dashboard
files" (personal/tulku/PROTOCOLS.md, Dashboard Data). It's allow-listed in
the act-vs-ask gate (tools/act_ask_gate.py) because it's reversible: every
log has a matching --remove.

Data dir: store.DATA_DIR, i.e. EXOCORTEX_DATA_DIR — set for every session
the app spawns. The path written is printed, so a run that hit the wrong
place says so.
"""
import argparse
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import store  # noqa: E402

COLLECTION = "activity_log.json"


def resolve_type(name, reminders):
    """The reminder whose type or label matches `name` (case-insensitive), or
    None."""
    key = (name or "").strip().lower()
    for r in reminders:
        if not isinstance(r, dict):
            continue
        if key in ((r.get("type") or "").lower(), (r.get("label") or "").lower()):
            return r
    return None


def parse_date(value, today):
    """YYYY-MM-DD, or the words today / yesterday."""
    v = (value or "today").strip().lower()
    if v == "today":
        return today.strftime("%Y-%m-%d")
    if v == "yesterday":
        return (today - timedelta(days=1)).strftime("%Y-%m-%d")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        datetime.strptime(v, "%Y-%m-%d")  # raises on 2026-13-40
        return v
    raise ValueError(f"not a date: {value!r} (use YYYY-MM-DD, today or yesterday)")


def log(atype, date):
    """Add one row, replacing any same-day row of the same type. Returns the
    last date now on record for this type."""
    with store.mutate(COLLECTION, {"entries": []}) as data:
        entries = [e for e in data.get("entries", [])
                   if not (e.get("date") == date and e.get("type") == atype)]
        entries.append({"date": date, "type": atype})
        entries.sort(key=lambda e: e.get("date", ""))
        data["entries"] = entries
        return max(e["date"] for e in entries if e.get("type") == atype)


def remove(atype, date):
    """Drop that day's row. Returns True if one was there."""
    with store.mutate(COLLECTION, {"entries": []}) as data:
        before = len(data.get("entries", []))
        data["entries"] = [e for e in data.get("entries", [])
                           if not (e.get("date") == date and e.get("type") == atype)]
        return len(data["entries"]) < before


def main(argv=None, today=None):
    p = argparse.ArgumentParser(description="Log a reminder's activity (e.g. a dose).")
    p.add_argument("type", help="reminder type or label, e.g. estradiol")
    p.add_argument("--date", default="today", help="YYYY-MM-DD, today (default) or yesterday")
    p.add_argument("--remove", action="store_true", help="take that day's entry back out")
    args = p.parse_args(argv)

    today = today or datetime.now()
    reminders = store.read("reminders.json", {"reminders": []}).get("reminders", [])
    rem = resolve_type(args.type, reminders)
    if rem is None:
        known = ", ".join(sorted(r.get("type", "") for r in reminders if isinstance(r, dict)))
        print(f"log_activity: no reminder called {args.type!r}. Known: {known}", file=sys.stderr)
        return 2
    try:
        date = parse_date(args.date, today)
    except ValueError as e:
        print(f"log_activity: {e}", file=sys.stderr)
        return 2
    if date > today.strftime("%Y-%m-%d"):
        print(f"log_activity: {date} is in the future — not logged", file=sys.stderr)
        return 2

    atype = rem["type"]
    where = store.DATA_DIR / COLLECTION
    if args.remove:
        if remove(atype, date):
            print(f"removed {atype} on {date}  ({where})")
        else:
            print(f"nothing to remove: no {atype} on {date}  ({where})")
        return 0
    last = log(atype, date)
    every = rem.get("every_days")
    nxt = ""
    if every and (rem.get("schedule") or "interval") == "interval":
        due = datetime.strptime(last, "%Y-%m-%d") + timedelta(days=int(every))
        nxt = f"; next due {due.strftime('%a %b %-d')}"
    print(f"logged {atype} on {date}{nxt}  ({where})")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ so a
    # test or another module importing this file doesn't start tracing.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
