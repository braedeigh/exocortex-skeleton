"""The desktop app's journal: the folder it lives in, and waking the Keeper.

**What this does, in plain English.** The journal is a folder of the person's
own words (the content folder, inside the data folder) and an agent that
keeps it — the Keeper, a session in the Personal room that records what they
say and remembers by reading. On the live site that folder was set up by hand
over months. Here a stranger starts from nothing, so this file does the
setting up:

  - `prepare()` — makes the journal's folders, puts the seed Keeper manifest
    (`CLAUDE.md`) there if there isn't one, and writes small launchers for
    the card engine so the app and the Keeper both find it at the path they
    expect. Run every time the app starts; it never overwrites anything the
    person or their Keeper wrote.
  - `wake()` — opens the Keeper: the one pinned journaling session. The first
    time, its wake command carries a setup section, so the Keeper's first act
    is to ask who it is keeping for and write that down.
  - `status()` — what the page shows about it.

Capture needs no hook here: every message sent in a journaling session is
recorded by the server itself, before the model sees it
(`routes/observatory.py` begin_turn).

Touches: `content-scaffold/` (the seed manifest), `claude-commands/` (the
wake and close commands), `tools/stream/` (the card engine the launchers
run), `routes/observatory.py` (the session and its first turn),
`standalone_app.py` (registers the doors), `docs/standalone.md`.

Prompt that produced this file: asked what the journal should cover in the
desktop app — "The whole keeper with a first prompt for setup."
"""
from datetime import datetime
from pathlib import Path
import shutil
import sys

import store
from routes import observatory

ROOT = Path(__file__).resolve().parent
SCAFFOLD = ROOT / "content-scaffold"
COMMANDS = ROOT / "claude-commands"
ENGINE = ROOT / "tools" / "stream"

# The card engine's three programs. The app and the Keeper run them at
# `<content>/_system/<name>`; the real code stays with the app.
ENGINE_PROGRAMS = ("stream.py", "keeper_capture.py", "reconcile_transcripts.py")

# The commands the Keeper's folder carries: wake and close.
KEEPER_COMMANDS = ("journalstart.md", "endsession.md")

# The heading the seed manifest ships with. While it is still there, nobody
# has told the Keeper who it is keeping for.
UNFILLED_HEADING = "## Who you're keeping for — fill this in"

# Added to the wake command until setup is done.
SETUP_SECTION = """

---

## First session: setup (this section goes away once it's done)

This is a brand-new install. Nobody has told you who you are keeping for, and
the person in front of you may never have used anything like this. Before any
journaling, set things up together — as a short conversation, not a form:

1. Say, in two or three plain sentences, what you are (a journal companion
   that remembers by reading what was written down) and that what they type
   in this chat is saved to their journal, on their own computer.
2. Ask what to call them. Then, one question at a time and only as far as
   they want to go: what they'd like out of being witnessed, and what is
   going on in their life right now that you should know.
3. Write it down, in the same turn you learn it:
   - replace the section headed "Who you're keeping for — fill this in" in
     `CLAUDE.md` with who they are and why this exists for them (change the
     heading to "Who you're keeping for");
   - create `context/about.md` with what is current in their life.
4. Tell them the two things worth knowing: every message here is recorded as
   they send it, and `/endsession` closes the day.

Then carry on as the manifest describes. Don't rush the setup to get to the
journaling — this conversation is the first entry.
"""

LAUNCHER = '''#!{python}
"""Launcher — the journal's card engine lives with the app.
Real code: {real}
Written by the desktop app each time it starts (standalone_journal.py), so it
always points at the app as it is now. Don't edit; it is replaced."""
import os
import sys

os.environ.setdefault("TULKU_STREAM_ROOT", {content!r})
python = {python!r} if os.path.exists({python!r}) else sys.executable
os.execv(python, [python, {real!r}] + sys.argv[1:])
'''


def content_dir():
    return Path(store.CONTENT_DIR)


def prepare():
    """Make the journal's folder ready. Safe on every start: folders are made
    if missing, the manifest is only ever put there when there is none, and
    the launchers — which belong to the app, not the person — are rewritten
    so they follow the app when it moves or updates."""
    content = content_dir()
    for folder in ("Journal/Daily", "Journal/Weekly", "keeper-diary", "context",
                   "_system/data/cards", ".claude/commands"):
        (content / folder).mkdir(parents=True, exist_ok=True)
    # The seed manifest and the engine's own write-up: copied once, never
    # over a file that is already there.
    for name in ("CLAUDE.md", "_system/STREAM.md"):
        if (SCAFFOLD / name).is_file() and not (content / name).exists():
            shutil.copyfile(SCAFFOLD / name, content / name)
    # The launchers.
    for program in ENGINE_PROGRAMS:
        launcher = content / "_system" / program
        launcher.write_text(LAUNCHER.format(
            python=sys.executable, real=str(ENGINE / program), content=str(content)))
        launcher.chmod(0o755)
    _write_commands()


def setup_done():
    """Has the Keeper been told who it is keeping for? True once the seed
    manifest's fill-this-in heading is gone (or the manifest was replaced)."""
    try:
        return UNFILLED_HEADING not in (content_dir() / "CLAUDE.md").read_text()
    except OSError:
        return False


def _write_commands():
    """Put the wake and close commands in the Keeper's folder, where Claude
    Code looks for them. The wake command carries the setup section until
    setup is done. Rewritten on every start and every wake — they are the
    app's text, and that is how the setup section comes off."""
    folder = content_dir() / ".claude" / "commands"
    folder.mkdir(parents=True, exist_ok=True)
    for name in KEEPER_COMMANDS:
        try:
            text = (COMMANDS / name).read_text()
        except OSError:
            continue
        if name == "journalstart.md" and not setup_done():
            text = text.rstrip("\n") + SETUP_SECTION
        (folder / name).write_text(text)


def keeper():
    """The open Keeper session's id, or None: the pinned, journaling session
    that hasn't been closed."""
    index = store.read("bot_chats/index", {})
    open_keepers = [conv_id for conv_id, entry in (index or {}).items()
                    if isinstance(entry, dict) and entry.get("journal") is True
                    and entry.get("pinned") and not entry.get("archived")]
    return max(open_keepers) if open_keepers else None


def wake():
    """Open the Keeper and start its wake turn. Returns {id, created}.

    If one is already open, that one is returned and nothing is sent. A new
    one stands in the journal's folder, journals every message, is pinned to
    the top of the Personal room, and is sent `/journalstart` — which, until
    setup is done, begins with the setup conversation."""
    existing = keeper()
    if existing:
        return {"id": existing, "created": False}
    prepare()
    profile = observatory._lane_profile("personal")
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        conv_id = observatory._new_conv_id(index)
        index[conv_id] = {
            "bot": "keeper",
            "origin": "standalone",
            "lane": "personal",
            "started": observatory._now(),
            "last_at": observatory._now(),
            "claude_session_id": None,
            "title": f"Keeper — {datetime.now():%a %b %-d}",
            "cost_usd": 0.0,
            "journal": True,
            "pinned": True,
            "cwd": profile["cwd"],
            "act_gate": profile["act_gate"],
            "guard_docs": profile["guard_docs"],
        }
    started = observatory.begin_turn(conv_id, "/journalstart")
    if not started.get("ok"):
        raise RuntimeError((started.get("body") or {}).get("error") or "the Keeper's turn didn't start")
    return {"id": conv_id, "created": True}


def status():
    """What the page shows about the journal: {folder, setup_done, keeper}."""
    return {"folder": str(content_dir()), "setup_done": setup_done(), "keeper": keeper()}

