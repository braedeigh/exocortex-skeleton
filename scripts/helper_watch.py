#!/usr/bin/env python3
"""helper_watch.py — a helper's door to watch a session between turns.

Plain English: a helper's chat only runs when something starts a turn, so a
promise like "I'll tell you when that session ships" needs something to wake
it. This sets that something: a watch (watches.py). Once a minute the app
checks it, and when the watched session does what it's waiting for, the
helper's chat is woken with one System message saying what happened. Each
watch fires once.

    ./venv/bin/python3 scripts/helper_watch.py add <session id> \
        [--on done,asked,committed,stalled,error] --note "what you promised her"
    ./venv/bin/python3 scripts/helper_watch.py list [--all] [--closed]
    ./venv/bin/python3 scripts/helper_watch.py drop <watch id>

`--on` takes any of: done (marks itself done, or is closed), asked (files
questions or a sudo card for her), committed (a `git commit` succeeds),
stalled (writes nothing for a long while), error (a turn fails). Without
it: done, asked, committed, error.

Who is watching comes from EXOCORTEX_CONV_ID, which every Observatory turn
carries. `list` shows this session's open watches (`--all`: everyone's,
`--closed`: fired, dropped and expired ones too). This is one of the few
writes a helper may make (tools/helper_gate.py lets it through).

Touches: watches.py (add, listing, drop), exo.db (helper_watches).
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store  # noqa: E402

if os.environ.get("EXOCORTEX_DATA_DIR"):
    store.DATA_DIR = Path(os.environ["EXOCORTEX_DATA_DIR"])

import watches  # noqa: E402


def _line(watch):
    closed = (f"  [{watch['status']} {watch['closed_at']}]"
              if watch["status"] != "watching" else "")
    out = (f"#{watch['id']}  {watch['conv']}  on {','.join(watch['kinds'])}"
           f"  since {watch['created_at']}{closed}\n    {watch['note']}")
    if watch.get("event"):
        out += "\n    → " + watch["event"].replace("\n", "\n    → ")
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description="Watch a session between turns.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add")
    add.add_argument("conv")
    add.add_argument("--on", action="append", default=[],
                     help=f"any of {', '.join(watches.KINDS)} (comma list, repeatable)")
    add.add_argument("--note", required=True)
    listed = sub.add_parser("list")
    listed.add_argument("--all", action="store_true")
    listed.add_argument("--closed", action="store_true")
    drop = sub.add_parser("drop")
    drop.add_argument("watch_id", type=int)
    args = parser.parse_args(argv)
    me = os.environ.get("EXOCORTEX_CONV_ID") or None

    try:
        if args.cmd == "add":
            if not me:
                print("EXOCORTEX_CONV_ID isn't set — only an Observatory session can watch",
                      file=sys.stderr)
                return 1
            watch = watches.add(me, args.conv, args.on, args.note)
            verb = "updated" if watch["updated"] else "watching"
            print(f"{verb}: watch #{watch['id']} on {watch['conv']}"
                  f" ({', '.join(watch['kinds'])}). You'll be woken once when it fires.")
            return 0
        if args.cmd == "drop":
            watch = watches.drop(args.watch_id, owner_conv=me)
            print(f"dropped watch #{watch['id']}")
            return 0
    except watches.WatchError as e:
        print(f"not done: {e}", file=sys.stderr)
        return 1
    found = watches.listing(None if args.all or not me else me, open_only=not args.closed)
    for watch in found:
        print(_line(watch))
    if not found:
        print("No watches." if args.closed else "No open watches.")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
