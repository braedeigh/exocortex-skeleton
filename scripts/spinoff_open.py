#!/usr/bin/env python3
"""spinoff_open.py — the agents' door into the spinoff spawner.

The /spinoff skill (claude-commands/spinoff.md) writes a brief to
SPINOFF_DIR/<slug>/BRIEF.md and then shells out to this script; the app's own
UI hits POST /api/spinoff/open instead. Both wrap routes.spinoff.open_spinoff.
Same narrow-door doctrine as stage_change.py: agents never write session state
directly — one validated entry point, loud precise failures.

    spinoff_open.py <slug> [--room personal|orchestra]

Minting is a pure index write now — no tmux, no long-lived process needed:
open_spinoff() mints (or rejoins) an Observatory conversation carrying the
kickoff, and the session appears in the Observatory the moment this returns.
The kickoff rides in `draft` but is marked `autostart`, so the session sends
it ITSELF the first time she opens the conversation — nobody hits send.

Without --room the spinoff lands in the room the CALLING session is in, read
off EXOCORTEX_CONV_ID; --room (or --lane, the code's word for the same thing)
overrides that. Prints one JSON line to stdout — `lane` in the reply is the
room it actually landed in, worth reading back to her. Exits non-zero on
refusal (bad slug, unknown room, missing brief).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.spinoff import open_spinoff  # noqa: E402


USAGE = "usage: spinoff_open.py <slug> [--room personal|orchestra]"


def main():
    # Hand-parsed rather than argparse: two forms, and a refusal here has to
    # print the same one-JSON-line shape as open_spinoff's, not argparse's
    # stderr essay — the caller is an agent reading stdout.
    args = sys.argv[1:]
    room = None
    if len(args) == 3 and args[1] in ("--room", "--lane"):
        args, room = args[:1], args[2]
    if len(args) != 1:
        print(json.dumps({"error": USAGE}))
        return 2
    payload, status = open_spinoff(args[0], lane=room)
    print(json.dumps(payload))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
