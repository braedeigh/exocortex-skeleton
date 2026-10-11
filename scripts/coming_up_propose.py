#!/usr/bin/env python3
"""A Keeper proposes a Coming up item — and it pops over the chat it came from.

**What this does, in plain English.** When a Keeper hears about something
dated — an appointment, an event, a thing the owner wants to be asked about
later — it runs this instead of writing any file. The proposal goes into the
approval queue tagged with the Keeper's own conversation (EXOCORTEX_CONV_ID),
so the Approve / Deny sheet pops up right over that chat. Nothing is added
until the owner approves; once approved, the item is marked as set by the
keeper, and any reminder it later sends says so.

    coming_up_propose.py --title "Permafest" --date 2026-10-17 \\
        --end-date 2026-10-18 --time 10:00 --lead-days 30 \\
        --note "Dripping Springs, RSVP at the site"

    coming_up_propose.py --kind topic --title "How the job search feels" \\
        --date 2026-10-10 --time 18:00

A topic with a time fires a reminder at that time. An event only fires one if
given `--remind-at "YYYY-MM-DD HH:MM"` (a ping at an appointment's start time
would be too late to use); otherwise it just shows in the morning's list.

Non-zero exit with the reason on stderr if the item is malformed; nothing is
staged in that case.

Touches: `scripts/stage_change.py` (the queue writer), `comingup.py` (the
checks, and the add on Approve via `routes/pending.py`).

Prompt that produced this: "record whether it was created manually or by the
keeper. Maybe it would pop up to approve it like other things in the chat."
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.stage_change import stage_change, StageError  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description="Propose a Coming up item for approval.")
    parser.add_argument("--title", required=True)
    parser.add_argument("--date", required=True, help="YYYY-MM-DD (the first day)")
    parser.add_argument("--kind", choices=("event", "topic"), default="event")
    parser.add_argument("--time", default="", help="HH:MM, when it happens")
    parser.add_argument("--end-date", default="", help="YYYY-MM-DD, for multi-day events")
    parser.add_argument("--remind-at", default="", help="'YYYY-MM-DD HH:MM', when to ping")
    parser.add_argument("--lead-days", type=int, default=None,
                        help="how many days ahead it starts showing (default 14)")
    parser.add_argument("--note", default="")
    args = parser.parse_args(argv)

    payload = {"title": args.title, "date": args.date, "kind": args.kind,
               "time": args.time, "end_date": args.end_date,
               "remind_at": args.remind_at, "note": args.note}
    if args.lead_days is not None:
        payload["lead_days"] = args.lead_days
    summary = f"{'Bring up' if args.kind == 'topic' else 'Coming up'}: {args.title} ({args.date})"
    try:
        entry = stage_change("coming_up", payload, summary=summary, by="keeper")
    except StageError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps({"staged": True, "id": entry["id"]}))
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
