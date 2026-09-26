#!/usr/bin/env python3
"""spinoff_offer.py — the agents' door for OFFERING spinoffs as a Go button.

The /spinoff skill (claude-commands/spinoff.md) writes each brief, then calls
this instead of asking "shall I?" in words. It stages the offer on the calling
session's own conversation, and her chat grows a Go card. Go spawns the
sessions (routes/spinoff.py go_offer) and takes her to the first one. Talking
on instead is fine too: the card waits. Same narrow-door doctrine as
request_input.py and spinoff_open.py: agents never write session state
directly.

    spinoff_offer.py <slug> [<slug> ...] [--room personal|coding]

The conversation id comes from EXOCORTEX_CONV_ID, which every Observatory turn
carries. A terminal session has none, so this refuses, and the skill falls back
to asking in words and running spinoff_open.py itself. Prints one JSON line;
exits non-zero on refusal (no conv id, missing brief, bad slug or room).
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.spinoff import offer_spinoff  # noqa: E402

USAGE = "usage: spinoff_offer.py <slug> [<slug> ...] [--room personal|coding]"


def main():
    # Pull the one flag out wherever it sits; everything left is a slug. The
    # server validates the values, so a bad one comes back as the same
    # one-JSON-line refusal the caller already reads.
    args = sys.argv[1:]
    room = None
    for flag in ("--room", "--lane"):
        if flag in args:
            i = args.index(flag)
            if i + 1 >= len(args):
                print(json.dumps({"error": USAGE}))
                return 2
            room = args[i + 1]
            args = args[:i] + args[i + 2:]
    if not args:
        print(json.dumps({"error": USAGE}))
        return 2
    conv_id = os.environ.get("EXOCORTEX_CONV_ID")
    if not conv_id:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not an Observatory "
                                   "turn; confirm in words and use "
                                   "spinoff_open.py"}))
        return 2
    payload, status = offer_spinoff(conv_id, args, lane=room)
    print(json.dumps(payload))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
