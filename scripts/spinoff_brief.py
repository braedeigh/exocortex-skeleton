#!/usr/bin/env python3
"""spinoff_brief.py — the agents' door for saving a spinoff brief.

Plain English: a brief says what a new session is asked to do. Briefs are kept
in the database (briefstore.py), so an agent no longer writes a BRIEF.md file.
It hands the brief's text to this script on standard input, under the job's
name (its slug):

    ./venv/bin/python3 scripts/spinoff_brief.py <slug> [--room coding|personal] <<'BRIEF'
    # Spinoff: <one-line title>
    ...
    BRIEF

    spinoff_brief.py <slug> --show     print the brief saved under <slug>

Saving again under the same slug replaces the brief, until a session has been
started on it. Nothing starts here: scripts/spinoff_offer.py puts up the Go
button and scripts/spinoff_open.py starts the session, both reading the brief
saved here.

The brief's "Where to look" list is checked as it is saved, against the folder
the new session would work in (the sender's room, or --room). A path that
doesn't exist comes back under `missing`, and the brief is saved all the same,
so it can be fixed and sent again; starting the session is where a missing path
is refused.

The text comes in on standard input and never on the command line: a brief is
long, written by an agent, and full of backticks and quotes that a shell would
try to run. Prints one JSON line; exits non-zero on refusal (bad slug, empty
brief, nothing saved under the slug).

Touches: briefstore.py (the table), routes/spinoff.py (the slug rule, the
Where-to-look check), tools/helper_gate.py (which lets a helper run exactly
this), claude-commands/spinoff.md (the skill that calls it).
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import briefstore  # noqa: E402
import store  # noqa: E402
from routes import spinoff  # noqa: E402

USAGE = ("usage: spinoff_brief.py <slug> [--room personal|coding] < brief.md"
         "   |   spinoff_brief.py <slug> --show")


def main(argv=None, stdin=None):
    args = list(sys.argv[1:] if argv is None else argv)
    show = "--show" in args
    args = [a for a in args if a != "--show"]
    # Pull the room flag out wherever it sits; what is left is the slug.
    room = None
    for flag in ("--room", "--lane"):
        if flag in args:
            i = args.index(flag)
            if i + 1 >= len(args):
                print(json.dumps({"error": USAGE}))
                return 2
            room = args[i + 1]
            args = args[:i] + args[i + 2:]
    if len(args) != 1:
        print(json.dumps({"error": USAGE}))
        return 2
    slug = args[0]
    if not spinoff.SLUG_RE.match(slug):
        print(json.dumps({"error": f"bad slug {slug!r}: a few lowercase words joined by hyphens"}))
        return 1
    if room is not None and room not in spinoff._LANES:
        print(json.dumps({"error": f"unknown room {room!r}"}))
        return 1

    if show:
        kept = briefstore.latest(slug)
        if kept is None:
            print(json.dumps({"error": f"no brief saved for {slug!r}"}))
            return 1
        sys.stdout.write(kept["body"])
        return 0

    stream = sys.stdin if stdin is None else stdin
    if stdin is None and stream.isatty():
        print(json.dumps({"error": USAGE}))
        return 2
    body = stream.read()
    if not body.strip():
        print(json.dumps({"error": "the brief is empty — send its text on standard input"}))
        return 1

    sender = os.environ.get("EXOCORTEX_CONV_ID") or None
    brief_id = briefstore.save(slug, body.rstrip("\n") + "\n", written_by=sender)
    reply = {"ok": True, "slug": slug, "brief": brief_id, "chars": len(body)}
    # Check the file list against the folder the new session would work in.
    # A warning, not a refusal: the room can still be named differently when
    # the session is started, and that is where a missing path is refused.
    index = store.read("bot_chats/index", {})
    cwd = spinoff._lane_profile(room or spinoff._inherit_lane(index))["cwd"]
    _, missing = spinoff._where_to_look(body, cwd)
    if missing:
        reply["missing"] = missing
        reply["warning"] = ("Where to look names files that don't exist (checked from "
                            f"{cwd}); the session won't start until they do")
    print(json.dumps(reply))
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
