"""The fairy's wall — run a command so it can read the machine but write only
in one folder.

**What this does, in plain English.** It builds the command line that starts a
program inside a wall made by the operating system (bubblewrap, the `bwrap`
program). Inside the wall:

  - the whole disk is there to read, but read-only: a write anywhere fails
    with "Read-only file system", whatever tool or script tried it;
  - one folder, the room, is writable. That is the sandbox;
  - the home folder is an empty stand-in, except the agent program itself
    and the one folder where the agent keeps this room's conversations. So
    the login, the SSH key and every other session's transcript are not
    there to read, and anything written there is gone when the command ends;
  - the paths in `default_hidden()` are empty too: the app's chat logs, the
    vault's git history and the capture hook's state (all three can hold a
    turn the owner sent off the record, word for word), and the secret files
    in the data folder.

This is enforcement, not instruction. The hooks in tools/ (act_ask_gate.py,
helper_gate.py) read a tool call and refuse it; a command they misread gets
through. Here nothing is read: the kernel refuses the write.

**What the wall does not do.** It does not block the network: the agent has to
reach the model, and bubblewrap alone can't allow one address and refuse the
rest. And it can't hide part of a file: exo.db is readable whole.

**Nothing uses this yet.** No room starts its turns through it. It is a tested
part, waiting on the owner's answers about the room that will. A walled agent
can't use the shared login (the home folder is hidden), so it needs a token of
its own, handed over in the environment by whoever calls this.

Touches: `store.py` (where the data folder and the vault are). Tests:
`tests/test_fairywall.py`, which run real commands against the real wall.

Prompt: "I want to put it in a sandbox where it can see the rest of the
exocortex but can't write into anything without my permission."
"""
import os
import re
import shutil
from pathlib import Path

import store

# The secret files in the data folder: keys and salts, never an agent's to read.
SECRET_FILES = ("linear_api_key", "push_vapid.pem", "push_hook_secret",
                "terrain_mirror_secret", "terrain_anon_salt")


def available():
    """True when bubblewrap is installed. With no wall there is no walled
    room: a caller must refuse to start rather than run without it."""
    return shutil.which("bwrap") is not None


def default_hidden():
    """The paths outside the home folder that are hidden inside the wall.

    Chat logs, the vault's git history (which carries those logs) and the
    capture hook's state can each hold an off-the-record turn. The secret
    files are keys. `EXOCORTEX_FAIRY_HIDE` adds more, separated by colons."""
    vault = store.CONTENT_DIR.parent
    hidden = [store.DATA_DIR / "bot_chats", vault / ".git", store.CONTENT_DIR / ".keeper"]
    hidden += [store.DATA_DIR / name for name in SECRET_FILES]
    hidden += [Path(extra) for extra in os.environ.get("EXOCORTEX_FAIRY_HIDE", "").split(":")
               if extra.strip()]
    return hidden


def transcripts_dir(room, home):
    """Where the agent keeps one folder's conversations: a folder under
    `~/.claude/projects` named after the room's path, every character that
    is not a letter or a digit turned into a dash."""
    return Path(home) / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(room))


def command(inner, room, home=None, program=None, hidden=None):
    """The command line that runs `inner` (a list) inside the wall.

    `room` is the one writable folder, and where the command starts. `home`
    is the home folder to empty (the current user's by default). `program`
    is the agent program, which usually lives in the home folder and has to
    be put back; None when the command needs nothing from there. `hidden`
    replaces `default_hidden()`.

    The order of the arguments is the order the wall is built in, and it
    matters: empty a folder first, then put back what belongs inside it."""
    room = Path(room).resolve()
    home = Path(home or Path.home()).resolve()
    hidden = default_hidden() if hidden is None else hidden
    wall = ["bwrap", "--die-with-parent",
            # The whole disk, read-only, with fresh device and process
            # folders and an empty /tmp of its own.
            "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    # Empty the home folder.
    wall += ["--tmpfs", str(home)]
    # Empty the hidden paths: a folder becomes an empty folder, and a file
    # becomes one that can't be opened. A path that doesn't exist needs no
    # hiding.
    for path in hidden:
        path = Path(path)
        if path.is_dir():
            wall += ["--tmpfs", str(path)]
        elif path.exists():
            wall += ["--ro-bind", "/dev/null", str(path)]
    # Put back the agent program, read-only, at its real path.
    if program:
        real = Path(shutil.which(str(program)) or program).resolve()
        wall += ["--ro-bind", str(real), str(real)]
        inner = [str(real)] + list(inner[1:])
    # Open the two writable places: the room, and the room's own conversations.
    transcripts = transcripts_dir(room, home)
    transcripts.mkdir(parents=True, exist_ok=True)
    wall += ["--bind", str(room), str(room), "--bind", str(transcripts), str(transcripts)]
    return wall + ["--chdir", str(room), "--"] + list(inner)
