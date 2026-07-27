#!/usr/bin/env python3
"""spinoff_open.py — the agents' door into the spinoff spawner.

The /spinoff skill (claude-commands/spinoff.md) writes a brief to
SPINOFF_DIR/<slug>/BRIEF.md and then shells out to this script; the app's own
UI hits POST /api/spinoff/open instead. Both wrap routes.spinoff.open_spinoff.
Same narrow-door doctrine as stage_change.py: agents never write session state
directly — one validated entry point, loud precise failures.

    spinoff_open.py <slug>

Minting is a pure index write now — no tmux, no long-lived process needed:
open_spinoff() mints (or rejoins) a Observatory conversation with the
kickoff staged as a draft, and the session appears in the Observatory the
moment this returns. Prints one JSON line to stdout; exits non-zero on
refusal (bad slug, missing brief).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.spinoff import open_spinoff  # noqa: E402


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: spinoff_open.py <slug>"}))
        return 2
    payload, status = open_spinoff(sys.argv[1])
    print(json.dumps(payload))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
