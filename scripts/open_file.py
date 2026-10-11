#!/usr/bin/env python3
"""open_file.py — how an agent asks the owner to open a file and edit it herself.

Plain English: when something has to be typed in by her (an API key on one
line of a settings file, a value only she knows), don't ask for it in chat and
don't hand her a shell command. Run this, naming the file. An orange card
appears on her page with a button that opens the file in the app's editor;
when she saves, or turns the request down, this session is woken with the
result. The wake-up never carries the file's text. So: file it, tell her in a
line what to put where, and end the turn — don't poll.

    ./venv/bin/python3 scripts/open_file.py /path/to/project/.env --reason "paste the key after RESEND_API_KEY="

The file must already exist and sit inside the app code, the vault, or a
folder on her builds list (Terrain's Builds room); anything else is refused
with the reason. After she saves, check your setting is there without printing
it: test for presence or length, never the value.

Touches: file_edits.py (the queue and the path checks).

Prompt that produced it: "i want for the LLM to be able to pop out a file for
me to edit in the browser"
"""
import argparse
import os
import sys
from urllib.parse import urlencode

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import file_edits  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Ask the owner to open a file in the app's editor; you're woken when she saves.")
    parser.add_argument("path", help="the file, absolute or relative to where you are")
    parser.add_argument("--reason", default="",
                        help="one line she'll read on the card: what to change or fill in")
    args = parser.parse_args(argv)

    conv = os.environ.get("EXOCORTEX_CONV_ID", "")
    try:
        req = file_edits.file_request(os.path.abspath(args.path), conv, args.reason)
    except file_edits.Refused as refusal:
        print(str(refusal), file=sys.stderr)
        return 1
    how = "joined the open request" if req["joined"] else "filed"
    address = "/code?" + urlencode({"repo": req["repo"], "path": req["path"], "edit": "1"})
    print(f"{how} ({req['id']}): {req['repo']}:{req['path']} — opens at {address}")
    if conv:
        print("It's on the owner's page as an orange card. End your turn now — "
              "this session is woken when she saves or turns it down.")
    else:
        print("EXOCORTEX_CONV_ID isn't set, so nothing will be woken when she saves.")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
