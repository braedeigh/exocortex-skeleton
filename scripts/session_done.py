#!/usr/bin/env python3
"""session_done.py — the running session's door to say "my work here is finished".

A session calls this as its very last act, once the job it was started for is
done: the work committed, nothing waiting on the owner, no detached job still
running. It stamps `done_at` on its OWN conversation. The card then shows
"done — closes at …" with a Keep open button, and after
routes/observatory.py DONE_GRACE_MINUTES the minute tick
(scripts/coming_up_dispatcher.py) closes it. Anything that starts a new turn
in the session — the owner's reply, a peer's message — cancels the countdown.
Same narrow-door doctrine as request_input.py: agents never write session
state directly.

    ./venv/bin/python3 scripts/session_done.py ["one line: what was finished"]

The conversation id comes from EXOCORTEX_CONV_ID, which routes/observatory.py
puts in every turn's environment. Prints one JSON line; exits non-zero on a
refusal (not an Observatory turn, the pinned Keeper, a question or Go button
or approval still waiting on the owner, a detached job still running).
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.observatory import mark_done  # noqa: E402


def main():
    if len(sys.argv) > 2:
        print(json.dumps({"error": 'usage: session_done.py ["what was finished"]'}))
        return 2
    conv_id = os.environ.get("EXOCORTEX_CONV_ID")
    if not conv_id:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not an Observatory turn?"}))
        return 2
    payload, status = mark_done(conv_id, sys.argv[1] if len(sys.argv) == 2 else "")
    print(json.dumps(payload))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
