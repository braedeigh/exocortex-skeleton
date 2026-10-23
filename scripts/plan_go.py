#!/usr/bin/env python3
"""plan_go.py — a helper presses a session's Go button because the owner said to.

She can tell a helper "make that one go" instead of tapping Go herself. The
helper runs this with the session's id and her words, quoted exactly; it
presses that session's Go the same way her tap does (routes/spinoff.py
go_offer). A planning session's plan card starts the builder and closes the
planner; an ordinary Go card starts planning sessions. Her words are written
into that session's chat first, so a Go she didn't tap is always visible.

    ./venv/bin/python3 scripts/plan_go.py 2026-10-13.105444 --owner-said "make the pond one go"

Only a helper may run it (the caller's EXOCORTEX_CONV_ID must be a helper
session), only with her words, and only on a session with a Go button up.
Prints one JSON line; exits non-zero on refusal.

Touches: routes/spinoff.py (go_by_word), tools/helper_gate.py (lets a helper
run it), helper_chat.py (tells the helper when), tests/test_plan_go.py.

Prompt: "change it such thtaa i can tell you to make one go"
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.spinoff import go_by_word  # noqa: E402

_USAGE = 'usage: plan_go.py <session id> --owner-said "<her words, quoted exactly>"'


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    # Exactly: the session id, the flag, her words. Anything else is refused
    # rather than guessed at.
    if len(arguments) != 3 or arguments[1] != "--owner-said" or not arguments[2].strip():
        print(json.dumps({"error": _USAGE}))
        return 2
    caller = os.environ.get("EXOCORTEX_CONV_ID")
    if not caller:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not an Observatory turn?"}))
        return 2
    payload, status = go_by_word(arguments[0], caller, arguments[2])
    print(json.dumps(payload))
    return 0 if status == 200 and payload.get("ok") else 1


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), as request_input.py does.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
