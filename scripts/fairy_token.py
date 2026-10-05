#!/usr/bin/env python3
"""Give the Fairy room its own login — run by the owner, in a terminal.

**What this does, in plain English.** A session in the Fairy room runs behind
a wall that hides the home folder (fairywall.py), so it can't use the login
every other session shares. It needs a token of its own. `claude setup-token`
makes one and prints it; this script asks for it without showing it on the
screen and saves it as one line in the data folder (`fairywall.token_path()`),
readable by the owner alone.

    claude setup-token                      # prints a long-lived token
    ./venv/bin/python3 scripts/fairy_token.py          # paste it here
    ./venv/bin/python3 scripts/fairy_token.py --remove # turn the room off

The token is typed here, never into a chat: a chat is saved. Removing the
file is the room's off switch: with no token, no turn there can start.

Touches: `fairywall.py` (where the token lives and who reads it).

Prompt: "wall yourself off in there so I can let you run"
"""
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fairywall  # noqa: E402


def main():
    path = fairywall.token_path()
    if "--remove" in sys.argv[1:]:
        try:
            path.unlink()
            print(f"Removed {path}. The Fairy room can't start a turn now.")
        except FileNotFoundError:
            print("There was no token.")
        return 0
    login_token = getpass.getpass("Paste the token from `claude setup-token` (it won't show): ").strip()
    if not login_token:
        print("Nothing pasted; nothing saved.")
        return 1
    # Create the file readable by the owner alone, then write the token.
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(login_token + "\n")
    os.chmod(path, 0o600)
    print(f"Saved to {path}. The Fairy room can start now.")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
