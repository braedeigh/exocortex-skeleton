#!/usr/bin/env python3
"""plan_ready.py — a planning session says its plan is ready for the owner's go.

A /spinoff planning session (claude-commands/spinoff/plan_protocol.md) runs
this once it has posted its plan in the chat, with the plan in a line or two.
Its roster card turns purple and shows "plan: <summary>", so a plan waiting on
her is visible from the front page. Her next message takes the mark off (the
plan may be about to change); the planner runs this again once the plan is
ready again. Marking again replaces the summary.

    ./venv/bin/python3 scripts/plan_ready.py "Move the Done drawer to the top; two files, one test"

The conversation id comes from EXOCORTEX_CONV_ID, injected into every
Observatory turn. Prints one JSON line to stdout; exits non-zero on refusal
(no conv id, empty summary, not a planning session, unknown conversation).
Same narrow-door doctrine as request_input.py: agents never write session
state directly.

Touches: routes/observatory.py (mark_plan_ready), tools/plan_gate.py (lets a
planner run it), tests/test_plan_ready.py.

Prompt: "i want them to be purple if they have a plan ready. with a little
blurb that says plan: {summary of plan}"
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.observatory import mark_plan_ready  # noqa: E402

_USAGE = 'usage: plan_ready.py "<the plan, in a line or two>"'


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    # The summary is the arguments joined, so an unquoted call still works.
    summary = " ".join(arguments).strip()
    if not summary:
        print(json.dumps({"error": _USAGE}))
        return 2
    conv_id = os.environ.get("EXOCORTEX_CONV_ID")
    if not conv_id:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not an Observatory turn?"}))
        return 2
    payload, status = mark_plan_ready(conv_id, summary)
    print(json.dumps(payload))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), as request_input.py does.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
