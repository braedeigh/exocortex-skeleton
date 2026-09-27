#!/usr/bin/env python3
"""sudo_request.py — how an agent asks the owner to run a root command for it.

Plain English: an agent can't type the sudo password, and shouldn't be handed
it. Instead it runs this, naming one of the actions in config.SUDO_ACTIONS (by
default just `reload` — reload the web server after a Python edit). The
request appears on the owner's page with a password box; when she approves or
declines, this session is woken with the result. So: file it, say so, and end
the turn — don't poll.

    ./venv/bin/python3 scripts/sudo_request.py reload --reason "routes/foo.py changed"
    ./venv/bin/python3 scripts/sudo_request.py --list

Touches: sudo_requests.py (the queue), config.py (the allowed actions).
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import config  # noqa: E402
import sudo_requests  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Ask the owner to run a listed command with sudo; you're woken with the result.")
    parser.add_argument("action", nargs="?", help="one of the actions from --list")
    parser.add_argument("--reason", default="", help="one line she'll read: why you need it")
    parser.add_argument("--list", action="store_true", help="show the actions you can ask for")
    args = parser.parse_args(argv)

    # List the allowed actions — the only things a request can ever run.
    if args.list or not args.action:
        for key in sorted(config.SUDO_ACTIONS):
            print(f"{key:12} {config.SUDO_ACTIONS[key]['label']}  ({sudo_requests.action_command(key)})")
        return 0 if args.list else 2

    conv = os.environ.get("EXOCORTEX_CONV_ID", "")
    try:
        req = sudo_requests.file_request(args.action, conv, args.reason)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    how = "joined the open request" if req["joined"] else "filed"
    print(f"{how} ({req['id']}): {sudo_requests.action_command(args.action)}")
    if conv:
        print("It's on the owner's page with a password box. End your turn now — "
              "this session is woken with the result when she answers.")
    else:
        print("EXOCORTEX_CONV_ID isn't set, so nothing will be woken when she answers.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
