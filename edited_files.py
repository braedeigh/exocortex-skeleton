"""Which files every open session is editing — one section of the room
helper's starting document, `# Files being edited now`.

**What this is, in plain English.** The room helper decides who should work
together, but everything else it's handed is summaries, and a summary rarely
says "I'm in room_helper.py". So two sessions could be editing the same file
and it would only notice by chance. This file lists, for every open session
in a room (in a swarm or working alone): the files it changed in the last
config.ROOM_HELPER_FILES_HOURS, and when it last touched each. Any file two
or more open sessions touched is flagged at the top with their names, and a
short list names the files git shows as changed that no open session claims.

Where it comes from: the `tool_calls` table (toolcallstore.py). A running
Observatory turn folds its own tool calls into it every few seconds, so this
is seconds behind for Observatory sessions; a session outside the Observatory
(tmux, a plain terminal) only shows up after the hourly ingest.

What it catches, and what it doesn't:
  - Edit / Write / MultiEdit / NotebookEdit calls: always — the file is in the call.
  - Bash calls: only when the command NAMES a file that git shows as changed
    (or committed within the window) in the app checkout, and WRITES to it —
    a `>`/`>>` or `tee` into it, `sed -i`/`perl -i`, `mv`/`cp`/`rm`/`touch`/
    `patch` on it, or a script that opens something for writing (`open(…,
    'w')`, `write_text`) and names it. So a heredoc that edits a file is
    caught; one that reads the file and writes somewhere else is counted too
    (a false alarm), and an edit through a path the command doesn't spell out
    (a variable, a glob, a `cd` into a subfolder first) is missed. Bash edits
    outside the app checkout (the vault, say) are missed; Edit/Write there
    are kept. Scratch files (temp dirs, ~/.claude) are left out.
  - A session and its continuations are one line of work: files the handed-on
    session touched are listed under the one carrying the work now.

Touches: toolcallstore.py (the table), swarms.py (who is retired, lines of
work, swarm membership), lanes.py (which room), config.py
(ROOM_HELPER_FILES_HOURS), and its two readers — room_helper.run (a run's
input) and helper_chat.seed_text (the room helper's chat). Test:
tests/test_edited_files.py. Design: docs/swarms.md.

Prompt that produced this: "i want part of the context to be all of the
files being edited by any agent that's open in any open session and swarm so
that you can direct agents better ... it would inject into the context
separately from the rest of the input that you recieve from the summaries."
"""
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import config
import lanes
import sqlstore
import store
import swarms

# The app checkout: its git status is what Bash commands are matched against,
# and paths inside it are shown relative to it.
_REPO = Path(__file__).resolve().parent

_EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
# Caps that keep the section to a couple of KB however busy the room gets.
_FILES_PER_SESSION = 10
_UNCLAIMED_SHOWN = 15


# --- Reading git --------------------------------------------------------------------

def _git(repo, *args):
    try:
        done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
                              text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def changed_in_git(repo, since):
    """Files the checkout's git shows as touched: (uncommitted, committed
    since `since`), each a set of absolute paths. Empty when it isn't a repo."""
    top = (_git(repo, "rev-parse", "--show-toplevel") or "").strip()
    if not top:
        return set(), set()
    # Uncommitted: the porcelain list, NUL-separated so odd names survive; a
    # rename's second entry is its old name, skipped.
    uncommitted, entries = set(), (_git(repo, "status", "--porcelain", "-z") or "").split("\0")
    skip = False
    for item in entries:
        if skip or len(item) < 4:
            skip = False
            continue
        uncommitted.add(str(Path(top) / item[3:]))
        skip = item[0] in "RC"
    log = _git(repo, "log", f"--since={since}", "--name-only", "--pretty=format:") or ""
    committed = {str(Path(top) / line) for line in log.splitlines() if line.strip()}
    return uncommitted, committed


# --- Which files a tool call wrote ----------------------------------------------------

_SCRATCH = tuple(str(p) + os.sep for p in {Path(tempfile.gettempdir()), Path("/tmp"),
                                             Path("/var/tmp"), Path.home() / ".claude"})
# A script that opens something to write: Python's open(…, 'w'/'a'/'x') or pathlib's writers.
_SCRIPT_WRITES = re.compile(r"""open\([^)]*['"][wax]b?\+?['"]|\.write_(text|bytes)\(""")
# Shell verbs that change the file they name.
_SHELL_VERBS = re.compile(r"(^|[\s;&|(])(sed\s+(-\S+\s+)*-i|perl\s+-\w*i|mv|cp|rm|touch|patch"
                          r"|git\s+(mv|rm)|tee)\b")


def _names(path, repo, unique_basenames):
    """The ways a command can spell this file: absolute, relative to the
    checkout, and its bare name when no other changed file shares it (a
    command run after `cd`-ing into its folder)."""
    names = {path}
    try:
        names.add(str(Path(path).relative_to(repo)))
    except ValueError:
        pass
    if Path(path).name in unique_basenames:
        names.add(Path(path).name)
    return names


def _script_targets(body, names):
    """Does this script pick the file as what it works on? Only a line that
    names it AND opens it (`open(`, `Path(`) or assigns it (`p = 'x.py'`)
    counts — a script's replacement text mentioning a file isn't an edit of it."""
    return any(_mentions(line, names) and re.search(
        r"open\(|Path\(|\w\s*=\s*[rfb]?['\"]", line) for line in body.splitlines())


def _mentions(text, names):
    """Does this text name the file? The name must stand whole — `room_helper.py`
    doesn't match inside `tests/test_room_helper.py`."""
    return any(re.search(r"(?<![\w./-])" + re.escape(n) + r"(?![\w/-]|\.\w)", text)
               for n in names)


# A heredoc: `<<'EOF'` … `EOF`, the body a script is usually fed through.
_HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n(.*?)\n\s*\1\b", re.S)


def bash_writes(command, candidates, repo):
    """The candidate files (absolute paths) this Bash command writes to — the
    heuristic the top of the file describes."""
    # Judge each piece on its own, so `grep f.py; python3 - <<EOF …writes g.py…`
    # isn't an edit of f.py: each heredoc body is a piece, and the shell around
    # them is split into its steps.
    bodies = [m.group(2) for m in _HEREDOC.finditer(command)]
    shell = _HEREDOC.sub("<<heredoc\n", command)
    steps = re.split(r"&&|\|\||[;\n]", shell)
    counts = {}
    for path in candidates:
        counts[Path(path).name] = counts.get(Path(path).name, 0) + 1
    unique = {name for name, n in counts.items() if n == 1}
    found = set()
    for path in candidates:
        names = _names(path, repo, unique)
        if not _mentions(command, names):
            continue
        # A script (a heredoc body, or a `python3 -c` step) that writes and targets it.
        scripted = any(_SCRIPT_WRITES.search(piece) and _script_targets(piece, names)
                       for piece in bodies + steps)
        # A shell step that changes it: a verb on it, or a redirect into it.
        shelled = any(_mentions(step, names) and (_SHELL_VERBS.search(step) or any(
            re.search(r">>?\s*['\"]?" + re.escape(n) + r"(?![\w/.-])", step) for n in names))
            for step in steps)
        if scripted or shelled:
            found.add(path)
    return found


def _edited_path(target, cwd, repo):
    """An Edit/Write call's file as an absolute path, or None for scratch files."""
    if not target:
        return None
    path = Path(target)
    if not path.is_absolute():
        path = Path(cwd or repo) / path
    path = os.path.normpath(str(path))
    # Scratch is a temp file outside the checkout; a checkout that lives in a temp dir still counts.
    inside = path.startswith(str(repo) + os.sep)
    return None if path.startswith(_SCRATCH) and not inside else path


def _shown(path, repo):
    """A path as the section shows it: relative to the checkout, else to its parent."""
    for base in (repo, repo.parent):
        try:
            return str(Path(path).relative_to(base))
        except ValueError:
            continue
    return path


def _when(at, today):
    return at[11:16] if at[:10] == today else f"{at[5:10]} {at[11:16]}"


def _by_folder(shown_paths):
    """Bullet lines with each folder written once: `- folder/ a.py, b.py`.
    Keeps the order given (a folder sits where its first file was)."""
    folders = {}
    for shown in shown_paths:
        folder, _, name = shown.rpartition("/")
        folders.setdefault(folder, []).append(name)
    return [f"- {folder + '/ ' if folder else ''}{', '.join(names)}"
            for folder, names in folders.items()]


# --- The section ----------------------------------------------------------------------

def open_lines(room, index):
    """The open lines of work in this room: {the session carrying it now:
    every session in the line}. Open means not retired (done, archived,
    handed on) and not a helper."""
    helpers = {c for c, e in index.items()
               if isinstance(e, dict) and e.get("role") in swarms.HELPER_ROLES}
    lines = {}
    for conv, entry in index.items():
        if (not isinstance(entry, dict) or conv in helpers or swarms.member_retired(entry)
                or lanes.derive_lane(entry) != room):
            continue
        line = frozenset(swarms.line_of_work(conv, index))
        lines.setdefault(line, []).append(conv)
    # Two open sessions in one line (rare): the latest active one carries it.
    return {max(openers, key=lambda c: index[c].get("last_at") or ""): set(line)
            for line, openers in lines.items()}


def edits(lines, since, repo, candidates):
    """{session carrying the line: {absolute path: last touched}} over the
    window. `candidates` are the files a Bash command is matched against."""
    owner = {c: face for face, line in lines.items() for c in line}
    if not owner:
        return {}
    conn = sqlstore.open_db()
    try:
        marks = ",".join("?" * len(owner))
        rows = conn.execute(
            f"SELECT conv, name, target, input, cwd, at FROM tool_calls"
            f" WHERE at >= ? AND conv IN ({marks}) AND name IN"
            f" ({','.join('?' * (len(_EDIT_TOOLS) + 1))})",
            (since, *owner, *_EDIT_TOOLS, "Bash")).fetchall()
    finally:
        conn.close()
    found = {face: {} for face in lines}
    for conv, name, target, raw, cwd, at in rows:
        if name == "Bash":
            try:
                command = (json.loads(raw) or {}).get("command") or target or ""
            except (ValueError, TypeError, AttributeError):
                command = target or ""
            paths = bash_writes(command, candidates, repo)
        else:
            paths = {_edited_path(target, cwd, repo)} - {None}
        touched = found[owner[conv]]
        for path in paths:
            touched[path] = max(touched.get(path, ""), at)
    return found


def section(room, index=None, repo=None, now=None):
    """The `# Files being edited now` section for this room, as markdown.
    Lists are grouped by folder, so a deep folder's path is written once —
    that's what keeps a busy room to about 2 KB."""
    index = store.read("bot_chats/index", {}) if index is None else index
    index = index if isinstance(index, dict) else {}
    repo = Path(repo or _REPO)
    now = now or datetime.now()
    hours = config.ROOM_HELPER_FILES_HOURS
    since = (now - timedelta(hours=hours)).isoformat(timespec="seconds")
    today = now.date().isoformat()
    lines = open_lines(room, index)
    uncommitted, committed = changed_in_git(repo, since)
    found = edits(lines, since, repo, uncommitted | committed)
    swarm_of = {m["conv"]: card["id"] for card in swarms.overview()
                if not card.get("closed") for m in card["members"]}

    out = ["# Files being edited now", "",
           f"Every open session in the {room} room and the files it changed in the last "
           f"{hours:g}h, with when it last touched each (read from the tool-call log, seconds "
           "behind). A Bash edit is caught only when the command names a file git shows as "
           "changed and writes to it, so an edit can be missed or, rarely, miscounted.", ""]
    # Flag the files more than one open session touched: the likely collisions.
    by_file = {}
    for face, touched in found.items():
        for path, at in touched.items():
            by_file.setdefault(path, []).append((at, face))
    shared = sorted(((p, sorted(w, reverse=True)) for p, w in by_file.items() if len(w) > 1),
                    key=lambda item: item[1][0], reverse=True)
    out += ["## Touched by more than one open session", ""]
    out += [f"- `{_shown(p, repo)}` — " + ", ".join(f"`{face}` ({_when(at, today)})"
                                                    for at, face in who) for p, who in shared]
    out += ["(none)"] if not shared else []
    out += ["", "## By session", ""]
    # One block per session that changed something, newest first.
    busy = sorted((f for f in found if found[f]), key=lambda f: max(found[f].values()),
                  reverse=True)
    for face in busy:
        entry = index.get(face) or {}
        where = f"swarm {swarm_of[face]}" if face in swarm_of else "working alone"
        saved = ", saved for later" if entry.get("saved_at") else ""
        out.append(f"### `{face}` {entry.get('title') or face} — {where}{saved}")
        touched = sorted(found[face].items(), key=lambda item: item[1], reverse=True)
        out += _by_folder(f"{_shown(p, repo)} {_when(at, today)}"
                          for p, at in touched[:_FILES_PER_SESSION])
        if len(touched) > _FILES_PER_SESSION:
            out.append(f"- (+{len(touched) - _FILES_PER_SESSION} more)")
    quiet = len(lines) - len(busy)
    if not busy:
        out.append("(no open session changed a file in the window)")
    elif quiet:
        out.append(f"({quiet} other open sessions changed no files in the window.)")
    # Name what git shows changed that nobody open is claiming — work left behind.
    claimed = set(by_file)
    unclaimed = sorted(_shown(p, repo) for p in uncommitted - claimed)
    if unclaimed:
        more = len(unclaimed) - _UNCLAIMED_SHOWN
        out += ["", "## Uncommitted in the app checkout, claimed by no open session", ""]
        out += _by_folder(unclaimed[:_UNCLAIMED_SHOWN])
        out += [f"- (+{more} more)"] if more > 0 else []
    return "\n".join(out) + "\n"
