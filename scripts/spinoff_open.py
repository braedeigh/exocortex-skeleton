#!/usr/bin/env python3
"""spinoff_open.py — the agents' door into the spinoff spawner.

The /spinoff skill (claude-commands/spinoff.md) writes a brief to
SPINOFF_DIR/<slug>/BRIEF.md and then shells out to this script; the app's own
UI hits POST /api/spinoff/open instead. Both wrap routes.spinoff.open_spinoff.
Same narrow-door doctrine as stage_change.py: agents never write session state
directly — one validated entry point, loud precise failures.

    spinoff_open.py <slug> [--room personal|coding|orchestra] [--no-worktree]

No tmux, no long-lived process needed: open_spinoff() mints (or rejoins) an
Observatory conversation carrying the kickoff, and the session appears in the
Observatory the moment this returns. The kickoff rides in `draft` but is marked
`autostart`, so the session sends it ITSELF the first time she opens the
conversation — nobody hits send.

An Orchestra spinoff also gets its own git worktree to work in, so it can't
edit the same files as anything else that's running; the reply carries the
`worktree` path and the `branch` its work will land on. `--no-worktree` keeps
it in the shared checkout — for the rare task that has to see itself in the
running site, and knowing it can then collide with whatever else is live.

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


USAGE = ("usage: spinoff_open.py <slug> [--room personal|coding|orchestra] "
         "[--model <name>] [--branch agent/<name>] [--no-worktree]")


def main():
    # Hand-parsed rather than argparse: a couple of forms, and a refusal here
    # has to print the same one-JSON-line shape as open_spinoff's, not
    # argparse's stderr essay — the caller is an agent reading stdout.
    args = sys.argv[1:]
    room, worktree, model, branch = None, None, None, None
    if "--no-worktree" in args:
        args = [a for a in args if a != "--no-worktree"]
        worktree = False
    # Flag-value pairs pulled out wherever they sit; the server validates the
    # values (room against _LANES, model against _MODEL_CHOICES, branch as an
    # agent/* name) so a bad one comes back as the same one-JSON-line refusal
    # every caller already reads. --branch adopts an EXISTING branch instead
    # of minting a new one (the steward / escalation mode).
    for flag in ("--room", "--lane", "--model", "--branch"):
        if flag in args:
            i = args.index(flag)
            if i + 1 >= len(args):
                print(json.dumps({"error": USAGE}))
                return 2
            value = args[i + 1]
            args = args[:i] + args[i + 2:]
            if flag == "--model":
                model = value
            elif flag == "--branch":
                branch = value
            else:
                room = value
    if len(args) != 1:
        print(json.dumps({"error": USAGE}))
        return 2
    payload, status = open_spinoff(args[0], lane=room, worktree=worktree,
                                   model=model, branch=branch)
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
