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

**Who uses it.** The Fairy room (lane `fairy`, routes/observatory.py): every
turn of a session standing in `store.FAIRY_ROOM_DIR` is started through
`command()`, with the tools in `TOOLS`, the settings from `settings()`, the
environment from `environment()` and the words from `prompt()`. A turn there
never starts without the wall: no bubblewrap, or no token, and it is refused.

**Its own login.** A walled agent can't use the shared login (the home folder
is hidden), so it has a token of its own, kept in a file in the data folder
(`token_path()`, written by scripts/fairy_token.py) and handed over in the
environment. Deleting that file stops the room.

**The charter.** The room's own CLAUDE.md is inside the room, so the fairy can
rewrite it. The owner's charter is a file outside the room (`charter_path()`),
read-only to the fairy, and added to its instructions on every turn.

Touches: `store.py` (where the data folder, the vault and the room are),
`routes/observatory.py` (the room). Tests: `tests/test_fairywall.py`, which
run real commands against the real wall.

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
                "terrain_mirror_secret", "terrain_anon_salt", "fairy_token")

# The tools a walled session carries: read, search, write files, run commands.
# No web tools and no sub-agents.
TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "Bash"]

# What every walled session is told, whatever its own files say.
PROMPT = """## The wall
You are running inside a wall made by the operating system.
- You can read almost everything on this machine: the app's code, the owner's vault, the database (read-only: `scripts/exo_query.py` in the app checkout).
- You can write in exactly one folder: the one you are standing in. It is yours: your notes, your memory, your code, your own CLAUDE.md. A write anywhere else fails with "Read-only file system". That is the wall, not a bug; don't look for a way around it.
- The home folder is empty, and so are the app's chat logs, the vault's git history and its key files. They are hidden from you on purpose.
- You have no web tools, no sub-agents and no way to message other agents. The scripts that file a question, propose a change or send a message all write outside your folder, so they fail here.
- To ask for a change outside your folder, say so to the owner in your reply, and put the exact change in a file under `outbox/` in your folder so she can read it. Nothing applies it but her.
- /tmp is yours for scratch and is emptied when the turn ends. Only your folder lasts.
"""


def token_path():
    """Where the room's own login token is kept: one line in a file in the
    data folder, or wherever `EXOCORTEX_FAIRY_TOKEN_FILE` says."""
    return Path(os.environ.get("EXOCORTEX_FAIRY_TOKEN_FILE") or store.DATA_DIR / "fairy_token")


def token():
    """The room's login token, or None when there is none yet."""
    try:
        return token_path().read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def charter_path():
    """The owner's charter for the room: a file beside the vault's other
    doctrine, or wherever `EXOCORTEX_FAIRY_CHARTER` says."""
    return Path(os.environ.get("EXOCORTEX_FAIRY_CHARTER")
                or store.CONTENT_DIR.parent / "docs" / "fairy-charter.md")


def prompt():
    """The words added to a walled session's instructions on every turn: the
    wall, then the owner's charter when she has written one."""
    try:
        charter = charter_path().read_text(encoding="utf-8").strip()
    except OSError:
        charter = ""
    return PROMPT + ("\n## The owner's charter (read-only to you)\n" + charter + "\n" if charter else "")


def settings():
    """The settings a walled session runs with: the web tools and sub-agents
    refused by name, and no hooks. The app's usual hooks all write to the
    data folder, which the wall makes read-only."""
    return {"permissions": {"deny": ["WebFetch", "WebSearch", "Task"]}}


def environment(login_token):
    """The environment a walled session starts with: the login token, where
    the data and the vault are (so the app's reading scripts work), and the
    few plain variables a program needs. Nothing else from the caller's
    environment is passed in."""
    kept = {name: os.environ[name] for name in ("PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER")
            if name in os.environ}
    kept.update({"CLAUDE_CODE_OAUTH_TOKEN": login_token,
                 "EXOCORTEX_DATA_DIR": str(store.DATA_DIR),
                 "EXOCORTEX_CONTENT_DIR": str(store.CONTENT_DIR)})
    return kept


def is_room(folder):
    """True when `folder` is the Fairy room. A session standing there is
    walled whatever room its record names."""
    try:
        return bool(folder) and Path(folder).resolve() == Path(store.FAIRY_ROOM_DIR).resolve()
    except (OSError, ValueError, RuntimeError):
        return False


class NoWall(OSError):
    """A walled turn that can't be started behind the wall. An OSError, so
    every caller that already handles "could not start the agent" reports it."""


def spawn_parts(inner, room, program):
    """Everything a walled turn is started with: (command line, environment).
    Refuse when the wall or the token is missing: a turn in this room never
    runs without both."""
    if not available():
        raise NoWall("the Fairy room needs bubblewrap (bwrap), and it is not installed")
    login_token = token()
    if not login_token:
        raise NoWall(f"the Fairy room has no login token yet ({token_path()}): "
                     "run scripts/fairy_token.py in a terminal")
    Path(room).mkdir(parents=True, exist_ok=True)
    return command(inner, room, program=program), environment(login_token)


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
