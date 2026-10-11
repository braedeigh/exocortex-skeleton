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
  - `start_import()` — instead of starting empty, a person can bring in a
    git repository they already keep a journal in. It is COPIED (cloned)
    into the app's own journal folder; the original is never written to.
    Only while the app's journal is untouched.

Capture needs no hook here: every message sent in a journaling session is
recorded by the server itself, before the model sees it
(`routes/observatory.py` begin_turn).

Touches: `content-scaffold/` (the seed manifest), `claude-commands/` (the
wake and close commands), `tools/stream/` (the card engine the launchers
run), `routes/observatory.py` (the session and its first turn),
`standalone_app.py` (registers the doors), `docs/standalone.md`.

Prompt that produced this file: asked what the journal should cover in the
desktop app — "The whole keeper with a first prompt for setup." The import:
"On setup, a person can bring in an existing repository to BE their journal,
instead of starting an empty one."
"""
from datetime import datetime
from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import threading
import time

import store
from routes import observatory

ROOT = Path(__file__).resolve().parent
SCAFFOLD = ROOT / "content-scaffold"
COMMANDS = ROOT / "claude-commands"
ENGINE = ROOT / "tools" / "stream"

# The card engine's three programs. The app and the Keeper run them at
# `<content>/_system/<name>`; the real code stays with the app.
ENGINE_PROGRAMS = ("stream.py", "keeper_capture.py", "reconcile_transcripts.py")

# The folders a journal has. prepare() makes the missing ones.
JOURNAL_FOLDERS = ("Journal/Daily", "Journal/Weekly", "keeper-diary", "context",
                   "_system/data/cards", ".claude/commands")

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


def owns_folder():
    """Is the journal's folder one this app made — inside its own data
    folder? Everything below that writes checks this first. A content folder
    anywhere else belongs to something else (a full install's vault, reached
    through an inherited setting), and this file's launchers and commands
    must never be written over that one's."""
    try:
        return content_dir().resolve().is_relative_to(Path(store.DATA_DIR).resolve())
    except OSError:
        return False


def prepare():
    """Make the journal's folder ready. True when it did; False, touching
    nothing, when the folder isn't this app's own (owns_folder). Safe on
    every start: folders are made if missing, the manifest is only ever put
    there when there is none, and the launchers — which belong to the app,
    not the person — are rewritten so they follow the app when it moves or
    updates."""
    if not owns_folder():
        return False
    content = content_dir()
    if _linked_folder(content) is not None:
        return False
    for folder in JOURNAL_FOLDERS:
        (content / folder).mkdir(parents=True, exist_ok=True)
    # The seed manifest and the engine's own write-up: copied once, never
    # over a file that is already there.
    for name in ("CLAUDE.md", "_system/STREAM.md"):
        if (SCAFFOLD / name).is_file() and not os.path.lexists(content / name):
            shutil.copyfile(SCAFFOLD / name, content / name)
    # The launchers.
    for program in ENGINE_PROGRAMS:
        launcher = content / "_system" / program
        _drop_link(launcher)
        launcher.write_text(LAUNCHER.format(
            python=sys.executable, real=str(ENGINE / program), content=str(content)))
        launcher.chmod(0o755)
    _write_commands()
    return True


def _linked_folder(content):
    """Refuse any write that would leave the journal's folder through a link.
    Returns the first of the folders this file writes into that is (or sits
    under) a symbolic link — a journal brought in from a repository can carry
    one, and making folders or files "inside" it would really write wherever
    it points. None when every one is a real folder or not there yet."""
    for folder in JOURNAL_FOLDERS:
        path = content
        for part in Path(folder).parts:
            path = path / part
            if path.is_symlink():
                return str(path.relative_to(content))
    return None


def _drop_link(path):
    """Refuse any write that would leave the journal's folder through a link.
    The files this app writes are its own; where one is a symbolic link, the
    link is removed so a real file is written in its place, instead of
    writing through it to whatever it points at."""
    if path.is_symlink():
        path.unlink()


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
        _drop_link(folder / name)
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
    setup is done, begins with the setup conversation. After that the
    nightly rollover (below) closes each day and opens the next Keeper."""
    existing = keeper()
    if existing:
        return {"id": existing, "created": False}
    if not prepare():
        raise RuntimeError("the journal's folder is outside this app's data folder, "
                           "so the Keeper wasn't started")
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
    """What the page shows about the journal: {folder, setup_done, keeper,
    can_import, source, import}. `source` is the address or folder the
    journal was brought in from, or None; `import` is {state, detail, error}
    with state "downloading", "failed" or None."""
    return {"folder": str(content_dir()), "setup_done": setup_done(), "keeper": keeper(),
            "can_import": can_import(),
            "source": store.read(SETTINGS, {}).get("journal_source"),
            "import": dict(_import)}


# --- bringing in a journal that already exists -----------------------------------

# The import that is running or last ran, in this run of the app only:
# state is "downloading", "failed" or None.
_import = {"state": None, "detail": "", "error": ""}
# The longest a download may take before it is given up on.
IMPORT_TIMEOUT_SEC = 900
# A git address this will download from: https, ssh, or the git@host:path
# short form. Never anything starting with "-", which git would read as an
# option rather than an address.
_GIT_ADDRESS = re.compile(r"^(https://|ssh://|git@[\w.-]+:)[^\s]+$")


def can_import():
    """May a repository still be brought in as the journal? Only while the
    app's own journal is untouched: its folder is this app's, no Keeper has
    ever been opened, setup hasn't been done, no card has been written, and
    no import is running. After that an import would replace words someone
    wrote, so it is refused."""
    if not owns_folder() or _import["state"] == "downloading" or setup_done():
        return False
    index = store.read("bot_chats/index", {}) or {}
    if any(isinstance(entry, dict) and entry.get("journal") is True for entry in index.values()):
        return False
    cards = content_dir() / "_system" / "data" / "cards"
    return not (cards.is_dir() and any(cards.iterdir()))


def start_import(url=None, path=None):
    """Bring a git repository in as the journal: an address to download, or a
    folder on this computer that holds one. Raises ValueError with a sentence
    the screen can show. The copy runs on in the background; status() reports
    it under `import`.

    The repository is cloned — the copy in the app's journal folder is what
    the Keeper reads and writes, and the original is never touched."""
    if not owns_folder():
        raise ValueError("the journal's folder is outside this app's data folder, "
                         "so nothing can be brought into it")
    if _import["state"] == "downloading":
        raise ValueError("a journal is already being brought in")
    if not can_import():
        raise ValueError("this journal has already been started, and bringing one in "
                         "would replace it — an import is only for a journal nobody has used")
    if shutil.which("git") is None:
        raise ValueError("git isn't installed on this computer, so nothing can be brought in")
    if isinstance(url, str) and url.strip():
        source = url.strip()
        if not _GIT_ADDRESS.match(source):
            raise ValueError("that isn't a git address this can download — it should start "
                             "with https://, ssh:// or git@")
    elif isinstance(path, str) and path.strip():
        folder = Path(path.strip()).expanduser()
        if not folder.is_absolute() or not folder.is_dir():
            raise ValueError("that folder isn't on this computer")
        inside = subprocess.run(["git", "-C", str(folder), "rev-parse", "--show-toplevel"],
                                capture_output=True, text=True)
        if inside.returncode != 0 or Path(inside.stdout.strip()).resolve() != folder.resolve():
            raise ValueError("that folder isn't the top of a git repository")
        source = str(folder.resolve())
    else:
        raise ValueError("give a repository's address or a folder's path")
    _import.update(state="downloading", detail=source, error="")
    threading.Thread(target=_run_import, args=(source,), daemon=True,
                     name="standalone-journal-import").start()


def _run_import(source):
    """Clone `source` beside the journal's folder, then swap it in. The
    untouched folder that was there is kept beside it rather than deleted
    (`content.before-import-<time>`), in case someone had put a file in it."""
    content = content_dir()
    arriving = content.with_name(content.name + ".importing")
    shutil.rmtree(arriving, ignore_errors=True)
    try:
        # --no-local makes a full copy even from a folder on this computer,
        # sharing nothing with the original. No password prompt: a download
        # that needs one fails with git's own message instead of hanging.
        cloned = subprocess.run(
            ["git", "clone", "--quiet", "--no-local", "--", source, str(arriving)],
            capture_output=True, text=True, stdin=subprocess.DEVNULL,
            timeout=IMPORT_TIMEOUT_SEC, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if cloned.returncode != 0:
            raise RuntimeError((cloned.stderr.strip().splitlines() or ["git could not copy it"])[-1])
        linked = _linked_folder(arriving)
        if linked is not None:
            raise RuntimeError(f"its `{linked}` is a link to somewhere else, where the "
                               "journal needs a real folder")
        if content.exists():
            content.rename(content.with_name(
                f"{content.name}.before-import-{time.strftime('%Y%m%d-%H%M%S')}"))
        arriving.rename(content)
        with store.mutate(SETTINGS, {}) as settings:
            settings["journal_source"] = source
        prepare()
        outcome = {"state": None, "detail": "", "error": ""}
    except subprocess.TimeoutExpired:
        outcome = {"state": "failed", "error": "the download took too long and was stopped"}
    except (RuntimeError, OSError) as problem:
        outcome = {"state": "failed", "error": str(problem)}
    # Clear the half-made copy away BEFORE saying it is over, so the page
    # never sees "finished" with leftovers still on disk.
    shutil.rmtree(arriving, ignore_errors=True)
    _import.update(outcome)



# --- the nightly rollover -------------------------------------------------------

# The hour (this computer's clock) after which yesterday's Keeper is closed.
ROLLOVER_HOUR = 3
SETTINGS = "standalone"


def rollover_on():
    """Does the Keeper's day close by itself? On unless the person turned it
    off (POST /api/standalone/settings {"keeper_rollover": false}). It costs
    two agent turns a night, which is why it has a switch."""
    return store.read(SETTINGS, {}).get("keeper_rollover") is not False


def rollover_due(now=None):
    """Should the rollover run now? Only when all of these hold: it is
    switched on; it is past ROLLOVER_HOUR; it hasn't already run today; and
    there is an open Keeper that was opened before today and has actually
    been talked to. So an unused Keeper is never rolled, and a computer that
    was off at 3am rolls the first time the app is open afterwards."""
    now = now or datetime.now()
    today = now.strftime("%Y-%m-%d")
    if not rollover_on() or now.hour < ROLLOVER_HOUR:
        return False
    if store.read(SETTINGS, {}).get("rolled_on") == today:
        return False
    conv_id = keeper()
    if conv_id is None:
        return False
    entry = store.read("bot_chats/index", {}).get(conv_id) or {}
    return bool(entry.get("claude_session_id")) and str(entry.get("started") or "")[:10] < today


def start_rollover(now=None):
    """Start tonight's rollover if it is due: `/endsession` in the open
    Keeper, then a fresh Keeper woken with `/journalstart`
    (scripts/keeper_rollover.py — the same script the live site's cron runs).
    True when it was started.

    The day is stamped BEFORE the script starts, so a rollover that fails
    costs one night, not a retry every minute. The script runs on its own,
    in a session of its own: it takes minutes, and the heartbeat that calls
    this must not wait for it."""
    now = now or datetime.now()
    if not rollover_due(now) or not prepare():
        return False
    with store.mutate(SETTINGS, {}) as settings:
        settings["rolled_on"] = now.strftime("%Y-%m-%d")
    _launch([sys.executable, str(ROOT / "scripts" / "keeper_rollover.py"), "roll"])
    return True


def _launch(command):
    """Start a program on its own and don't wait for it. Its own function so
    a test can watch what would be started without starting it."""
    subprocess.Popen(command, cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=sys.stderr,
                     stderr=sys.stderr, start_new_session=True)
