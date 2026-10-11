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

The same door takes the questions back down. Her message arriving in this
session clears them by itself; but when her answer comes by another route (she
answered in a different session's chat and a peer relayed her words), nothing
of hers arrives here, so the session withdraws its own questions and says
where her answer came from. The chat keeps the block, marked answered
elsewhere, with that line under it:

    ./venv/bin/python3 scripts/request_input.py --answered "relayed by <session>: she said \"A)\""

The conversation id comes from EXOCORTEX_CONV_ID, injected into every Reading
Room turn's environment by routes/observatory.py `_spawn`. Prints one JSON
line to stdout; exits non-zero on refusal (no conv id, empty question, unknown
conversation, nothing open to withdraw).

Touches: routes/observatory.py (request_input, withdraw_questions),
tests/test_request_input.py.

Prompt: "Agent symbol stayed orange when it got the answer from another chat
and not me" (the --answered form).
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.observatory import request_input, withdraw_questions  # noqa: E402

_USAGE = ('usage: request_input.py "<question>" ["<question>" ...]'
          '  |  request_input.py --answered "<where her answer came from>"')


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    # Withdraw the open questions: `--answered` plus exactly one line saying
    # where her answer came from. Anything else after the flag is refused
    # rather than guessed at, so a mistyped call can't file "--answered" as a
    # question or drop half of what was meant.
    withdrawing = bool(arguments) and arguments[0] == "--answered"
    if withdrawing:
        if len(arguments) != 2 or not arguments[1].strip():
            print(json.dumps({"error": _USAGE}))
            return 2
    # One argument per question; at least one has to say something.
    elif not any(q.strip() for q in arguments):
        print(json.dumps({"error": _USAGE}))
        return 2
    conv_id = os.environ.get("EXOCORTEX_CONV_ID")
    if not conv_id:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not a Observatory turn?"}))
        return 2
    if withdrawing:
        payload, status = withdraw_questions(conv_id, arguments[1])
    else:
        payload, status = request_input(conv_id, arguments)
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
