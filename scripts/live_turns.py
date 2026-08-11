#!/usr/bin/env python3
"""Is anyone mid-turn right now? The check that has to run before a deploy.

WHY THIS EXISTS. Reloading the web service kills the relay thread of every turn
running inside it — the agent process survives, but the thing writing down what
it says does not, so the conversation stops dead with no error anywhere. It is
invisible from the server side and it looks like a hang from the owner's side.
Measured across the stored transcripts: 15 of 23 silent turn deaths in one week
were reloads, and several were an agent deploying a fix while someone else's
session was mid-sentence.

Documentation already failed at preventing this once. The instruction to use
`reload` instead of `restart` was written on 2026-08-03 and every agent kept
running `restart` for another eight days, because the files they actually read
still said restart. So this is a MECHANISM, not a note: it exits non-zero while
work is live, and a deploy script that checks it cannot proceed by accident.

WHAT COUNTS AS LIVE. The `running` flag alone is worthless — it is set by the
process that starts a turn and cleared by the process that finishes it, so a
turn killed in between leaves it set forever (there are flags in the index
still reading `running` from July). The flag has to be corroborated by a fresh
`last_at`: a live turn re-stamps it every 30 seconds (_HEARTBEAT_SEC in
routes/observatory.py), so anything older than the staleness window is a
corpse, not a session. Same rule `_effective_running` applies at read time and
the same one `run_dispatcher.py` uses to decide what is really alive — stated
once here so a deploy and a dispatcher can never disagree about who is working.

    ./venv/bin/python3 scripts/live_turns.py          # exit 1 if any are live
    ./venv/bin/python3 scripts/live_turns.py --json

Touches: `store.py` (reads bot_chats/index, never writes), and
`scripts/restart_server.sh`, which refuses to deploy on a non-zero exit.
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Runnable straight from the shell (the deploy guard calls it that way), so the
# repo root has to be importable — same two lines usage_rollup.py opens with.
SKELETON = str(Path(__file__).resolve().parent.parent)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402  (must follow the path fix above)

# How stale `last_at` may be before a `running` flag is presumed orphaned.
# Deliberately the same 600s as routes/observatory._RUNNING_STALE_SEC and
# run_dispatcher's STALE_SEC. If those move, move this.
STALE_SEC = 600


def live_turns(index=None, now=None):
    """Conversations genuinely mid-turn, newest heartbeat first.

    Returns a list of {"id", "last_at", "age_sec"}. A malformed entry is
    skipped rather than raising: this gates a deploy, and it must never be the
    reason a deploy can't happen.
    """
    if index is None:
        index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        return []
    now = now or datetime.now()
    out = []
    for conv_id, entry in index.items():
        if not isinstance(entry, dict) or not entry.get("running"):
            continue
        try:
            age = (now - datetime.fromisoformat(entry.get("last_at", ""))).total_seconds()
        except (TypeError, ValueError):
            # A running flag with no readable heartbeat: unknowable, so treat
            # it as dead. Erring the other way would wedge every deploy behind
            # one malformed entry, and the orphaned flags in this index prove
            # that is the likelier state.
            continue
        if age < STALE_SEC:
            out.append({"id": conv_id,
                        "last_at": entry.get("last_at"),
                        "age_sec": round(age)})
    return sorted(out, key=lambda t: t["age_sec"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--json", action="store_true", help="machine-readable")
    args = ap.parse_args(argv)

    turns = live_turns()
    if args.json:
        print(json.dumps({"live": turns}, indent=2))
    elif turns:
        print(f"{len(turns)} turn(s) running right now:")
        for t in turns:
            print(f"  {t['id']}  last spoke {t['age_sec']}s ago")
    else:
        print("no turns running")
    return 1 if turns else 0


if __name__ == "__main__":
    sys.exit(main())
