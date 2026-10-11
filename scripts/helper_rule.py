#!/usr/bin/env python3
"""helper_rule.py — a helper's door to the owner's standing rules for it.

Plain English: a helper's chat is rolling — each turn it is handed only her
last few messages, so an instruction she gave last week is gone. Her standing
rules are the one thing that stays: a short list of her lasting instructions
to this helper, in her exact words with the date, handed to it at the start
of every turn. This is how the helper adds to that list when she says
something meant to last, and takes a rule off when she takes it back.

    ./venv/bin/python3 scripts/helper_rule.py add "<her exact words>"
    ./venv/bin/python3 scripts/helper_rule.py list
    ./venv/bin/python3 scripts/helper_rule.py drop <number>

The list is a markdown file she can open and edit herself:
<data dir>/helper_rules/room-<room>.md for a room's helper, swarm-<id>.md for
a swarm's. Which helper is asking comes from EXOCORTEX_CONV_ID, which every
Observatory turn carries; only a helper session has rules. This is one of
the few writes a helper may make (tools/helper_gate.py lets it through).

Touches: helper_chat.py (rules, add_rule, drop_rule, rules_path), the session
index (to see which helper is asking).
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store  # noqa: E402

if os.environ.get("EXOCORTEX_DATA_DIR"):
    store.DATA_DIR = Path(os.environ["EXOCORTEX_DATA_DIR"])

import helper_chat  # noqa: E402
import swarms  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description="The owner's standing rules for a helper.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add")
    add.add_argument("words", help="her exact words")
    sub.add_parser("list")
    drop = sub.add_parser("drop")
    drop.add_argument("number", type=int)
    args = parser.parse_args(argv)

    # Refuse anyone who isn't a helper: the rules belong to a helper's chat.
    me = os.environ.get("EXOCORTEX_CONV_ID") or ""
    index = store.read("bot_chats/index", {})
    entry = index.get(me) if isinstance(index, dict) else None
    if not isinstance(entry, dict) or entry.get("role") not in swarms.HELPER_ROLES:
        print("not done: only a helper session has standing rules (EXOCORTEX_CONV_ID"
              f" is {me or 'not set'})", file=sys.stderr)
        return 1
    try:
        if args.cmd == "add":
            print(f"added: {helper_chat.add_rule(entry, args.words)}")
        elif args.cmd == "drop":
            print(f"dropped: {helper_chat.drop_rule(entry, args.number)}")
    except ValueError as e:
        print(f"not done: {e}", file=sys.stderr)
        return 1
    found = helper_chat.rules(entry)
    print(f"Her standing rules ({helper_chat.rules_path(entry)}):")
    for number, rule in enumerate(found, 1):
        print(f"{number}. {rule}")
    if not found:
        print("(none yet)")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
