#!/usr/bin/env python3
"""request_input.py — the running session's door to ask the owner for input.

A session that hits a real fork it can't resolve calls this to hand the turn
back to her: it sets `awaiting_input` (the question) on its OWN conversation,
its Orchestra card glows orange, and her next message answers it (the next
`--resume` turn — nothing else wakes the session; she is the transport). Same
narrow-door doctrine as spinoff_open.py: agents never write session state
directly — one validated entry point, loud precise failures.

    ./venv/bin/python3 scripts/request_input.py "your question for her"

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
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        print(json.dumps({"error": 'usage: request_input.py "<question>"'}))
        return 2
    conv_id = os.environ.get("EXOCORTEX_CONV_ID")
    if not conv_id:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not a Observatory turn?"}))
        return 2
    payload, status = request_input(conv_id, sys.argv[1])
    print(json.dumps(payload))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
