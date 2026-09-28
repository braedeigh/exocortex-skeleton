#!/usr/bin/env python3
"""Is anyone mid-turn, or is a background job running? The check that has to
run before a deploy or a reboot.

WHY THIS EXISTS. Reloading the web service kills the relay thread of every turn
running inside it — the agent process survives, but the thing writing down what
it says does not, so the conversation stops dead with no error anywhere. It is
invisible from the server side and it looks like a hang from the owner's side.
Measured across the stored transcripts: 15 of 23 silent turn deaths in one week
were reloads, and several were an agent deploying a fix while someone else's
session was mid-sentence. A restart or a reboot is worse: it also kills every
detached job (scripts/run_detached.py), which a reload leaves alone.

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
Detached jobs count too, unless `--turns-only` (what a plain reload uses, since
a reload doesn't touch them): run_detached.running_jobs() says which are live.

WHERE THE DATA IS. Run from an ordinary terminal, EXOCORTEX_DATA_DIR usually
isn't set, and `store` quietly falls back to an empty folder inside the code
checkout — where this check once found no index and answered "no turns
running" while two were, and a reboot killed both. So when that variable is
missing, the data folder is read from the service's own `Environment=` line
(`systemctl show`), and if the index still can't be found this refuses
(exit 2) instead of guessing "all clear".

    ./venv/bin/python3 scripts/live_turns.py               # exit 1 if anything is live
    ./venv/bin/python3 scripts/live_turns.py --turns-only  # ignore detached jobs
    ./venv/bin/python3 scripts/live_turns.py --json

Touches: `store.py` (reads bot_chats/index, never writes),
`scripts/run_detached.py` (running_jobs), `config.SERVICE_NAME`, and its
callers: `scripts/restart_server.sh`, which refuses to deploy on a non-zero
exit, and the vault's reboot script, which waits for zero.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Runnable straight from the shell (the deploy guard calls it that way), so the
# repo root has to be importable — same two lines usage_rollup.py opens with.
SKELETON = str(Path(__file__).resolve().parent.parent)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import config  # noqa: E402  (must follow the path fix above)
import store  # noqa: E402
from scripts import run_detached  # noqa: E402

# How stale `last_at` may be before a `running` flag is presumed orphaned.
# Deliberately the same 600s as routes/observatory._RUNNING_STALE_SEC and
# run_dispatcher's STALE_SEC. If those move, move this.
STALE_SEC = 600

INDEX = "bot_chats/index"


def live_turns(index=None, now=None):
    """Conversations genuinely mid-turn, newest heartbeat first.

    Returns a list of {"id", "last_at", "age_sec"}. A malformed entry is
    skipped rather than raising: this gates a deploy, and it must never be the
    reason a deploy can't happen.
    """
    if index is None:
        index = store.read(INDEX, {})
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


def service_data_dir(runner=subprocess.run):
    """The EXOCORTEX_DATA_DIR the web service runs with, or None.

    Read from systemd (`systemctl show <service> -p Environment`), which needs
    no sudo. Any failure — no systemd, no such unit, no such variable — is
    None, and the caller refuses rather than guesses."""
    try:
        result = runner(["systemctl", "show", config.SERVICE_NAME,
                         "-p", "Environment", "--value"],
                        capture_output=True, text=True, timeout=10)
        pairs = shlex.split(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    for pair in pairs:
        name, _, value = pair.partition("=")
        if name == "EXOCORTEX_DATA_DIR" and value:
            return Path(value)
    return None


def locate_data(runner=subprocess.run):
    """Point `store` at the real data folder; False if it can't be found.

    Only steps in when store is on its fallback (the variable unset, so the
    folder inside the code checkout) — an explicit setting, including every
    test's, is left alone."""
    fallback = store.BUILD_DIR / "data"
    if not os.environ.get("EXOCORTEX_DATA_DIR") and store.DATA_DIR == fallback:
        found = service_data_dir(runner)
        if found is not None:
            store.DATA_DIR = found
    return store._path(INDEX).exists()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--json", action="store_true", help="machine-readable")
    ap.add_argument("--turns-only", action="store_true",
                    help="ignore detached jobs (a reload doesn't touch them)")
    args = ap.parse_args(argv)

    # Refuse when the index can't be found: "nothing running" would be a guess.
    if not locate_data():
        message = (f"can't find the turn index ({store._path(INDEX)}) — set "
                   "EXOCORTEX_DATA_DIR to the live data folder; refusing to say "
                   "nothing is running")
        print(json.dumps({"error": message}) if args.json else message)
        return 2

    turns = live_turns()
    jobs = [] if args.turns_only else run_detached.running_jobs()
    if args.json:
        print(json.dumps({"live": turns, "jobs": jobs}, indent=2))
    else:
        if turns:
            print(f"{len(turns)} turn(s) running right now:")
            for t in turns:
                print(f"  {t['id']}  last spoke {t['age_sec']}s ago")
        if jobs:
            print(f"{len(jobs)} detached job(s) running right now:")
            for j in jobs:
                print(f"  {j['id']}  {j['label']}  (for {j['conv_id']}, "
                      f"{j['age_sec']}s so far)")
        if not turns and not jobs:
            print("no turns running" if args.turns_only
                  else "no turns or detached jobs running")
    return 1 if turns or jobs else 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
