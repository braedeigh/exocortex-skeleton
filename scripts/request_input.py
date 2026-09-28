#!/usr/bin/env python3
"""request_input.py — the running session's door to ask the owner for input.

A session that hits real questions it can't resolve calls this to hand the
turn back to her: it files every open question on its OWN conversation, its
card glows orange, the questions print on the roster card (with a box she
answers in) and at the bottom of its chat, and her next message answers them
(the next `--resume` turn — nothing else wakes the session; she is the
transport). One argument per question; filing again replaces the earlier set.
Same narrow-door doctrine as spinoff_open.py: agents never write session
state directly — one validated entry point, loud precise failures.

    ./venv/bin/python3 scripts/request_input.py "first question" "second question"

The conversation id comes from EXOCORTEX_CONV_ID, injected into every Reading
Room turn's environment by routes/observatory.py `_spawn`. Prints one JSON
line to stdout; exits non-zero on refusal (no conv id, empty question, unknown
conversation).
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.observatory import request_input  # noqa: E402


def main():
    # One argument per question; at least one has to say something.
    questions = sys.argv[1:]
    if not any(q.strip() for q in questions):
        print(json.dumps({"error": 'usage: request_input.py "<question>" ["<question>" ...]'}))
        return 2
    conv_id = os.environ.get("EXOCORTEX_CONV_ID")
    if not conv_id:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not a Observatory turn?"}))
        return 2
    payload, status = request_input(conv_id, questions)
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
