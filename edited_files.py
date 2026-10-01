"""Which files every open session is editing — one section of the room
helper's starting document, `# Files being edited now`.

**What this is, in plain English.** The room helper decides who should work
together, but everything else it's handed is summaries, and a summary rarely
says "I'm in room_helper.py". So two sessions could be editing the same file
and it would only notice by chance. This file lists, for every open session
in a room (in a swarm or working alone): the files it changed in the last
config.ROOM_HELPER_FILES_HOURS, and when it last touched each. Any file two
or more open sessions touched is flagged at the top with their names, a
short list names the files git shows as changed that no open session claims,
and another lists the overlaps the app has noticed — two sessions in one
file, or one working from a copy another has since changed (file_alerts.py).

It also answers which files a session READ (`reads`), with the same shape as
`edits` — file_alerts.py uses it to spot a session working from a copy that
another has since changed.

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
    'w')`, `write_text`) and names it. A verb counts only where a command
    can start (the head of a step, after a pipe), so a message that merely
    says "touch" or "rm" near a file's name isn't one. So a heredoc that edits a file is
    caught; one that reads the file and writes somewhere else is counted too
    (a false alarm), as is a long script the log cut short (over 4,000
    characters) that opens the file — its end, where the write would be,
    isn't on record. An edit through a path the command doesn't spell out
    (a variable, a glob, a `cd` into a subfolder first) is missed. Bash edits
    outside the app checkout (the vault, say) are missed; Edit/Write there
    are kept. Scratch files (temp dirs, ~/.claude) are left out.
  - Reads: a Read call always; a Bash call only when a reading command
    (`cat`, `head`, `tail`, `sed` without -i, `grep`, `rg`, `awk`, `less`,
    `nl`, `wc`) names a file git shows as changed, or a script opens it
    without writing. A read through a path the command doesn't spell out is
    missed, like an edit.
  - A session and its continuations are one line of work: files the handed-on
    session touched are listed under the one carrying the work now.

Touches: toolcallstore.py (the table), swarms.py (who is retired, lines of
work, swarm membership), lanes.py (which room), config.py
(ROOM_HELPER_FILES_HOURS), its readers — room_helper.run (the section, as
a run's input) and helper_chat.sessions (open_lines, edits, reads,
changed_in_git, _by_folder, _shown, _when — the helper chat's seed) — and
file_alerts.py (which calls open_lines, edits and reads, and supplies the
"overlaps noticed" list). Tests: tests/test_edited_files.py,
tests/test_file_alerts.py. Design: docs/swarms.md.

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
# Where a command word can stand in a shell step: at its start, after a pipe
# or an opening bracket, or after a word that runs another command — with any
# `NAME=value` settings in front. A verb anywhere else is just a word: a
# message saying "I won't touch config.py" is not `touch config.py`.
_COMMAND_START = r"(?:^\s*|[|({]\s*|(?:\b(?:sudo|xargs|then|do|else|time|exec)|-exec)\s+)(?:\w+=\S*\s+)*"
# Shell verbs that change the file they name.
_SHELL_VERBS = re.compile(_COMMAND_START + r"(sed\s+(-\S+\s+)*-i|perl\s+-\w*i|mv|cp|rm|touch"
                          r"|patch|git\s+(mv|rm)|tee)\b")


def _names(path, repo, unique_basenames):
    """The ways a command can spell this file: absolute, relative to the
    checkout, and its bare name when no other changed file shares it (a
    command run after `cd`-ing into its folder)."""
    names = {path}
    try:
        names.add(str(Path(path).relative_to(repo)))
    except ValueError:
        pass
    if os.path.basename(path) in unique_basenames:
        names.add(os.path.basename(path))
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


def _pieces(command):
    """A Bash command cut into the pieces that are judged on their own, so
    `grep f.py; python3 - <<EOF …writes g.py…` isn't an edit of f.py: each
    heredoc body is a piece, and the shell around them is split into its
    steps. Returns (heredoc bodies, shell steps)."""
    bodies = [m.group(2) for m in _HEREDOC.finditer(command)]
    shell = _HEREDOC.sub("<<heredoc\n", command)
    # A heredoc with no end is a command the log cut short (_command): what's
    # left of its body is still a piece, marked so its missing end is known.
    cut = _HEREDOC_CUT.search(shell)
    if cut:
        bodies.append(cut.group(1) + _CUT)
        shell = shell[:cut.start()] + "<<heredoc\n"
    return bodies, re.split(r"&&|\|\||[;\n]", shell)


# A heredoc that starts and never ends, and the mark put on its body.
_HEREDOC_CUT = re.compile(r"<<-?\s*['\"]?\w+['\"]?[^\n]*\n(.*)\Z", re.S)
_CUT = "\n#…cut"


def _command(raw, target):
    """A Bash call's command, from its stored input. The log keeps at most
    4,000 characters of input (toolcallstore._INPUT_CAP), so a long script
    arrives cut off and is no longer valid JSON; then the start of the
    command is recovered from what's there rather than thrown away."""
    try:
        return (json.loads(raw) or {}).get("command") or target or ""
    except (ValueError, TypeError, AttributeError):
        pass
    # `command` is the input's first key (keys are stored sorted), so the cut
    # text is the command's start. Trim the tail until it decodes as a string.
    found = re.match(r'\{"command": "(.*)', raw or "", re.S)
    for trim in range(8) if found else ():
        try:
            return json.loads('"' + found.group(1)[:len(found.group(1)) - trim] + '"')
        except ValueError:
            continue
    return target or ""


def spellings(candidates, repo):
    """{candidate path: (its bare name, every way a command can spell it)} —
    worked out once for a whole set of commands (edits and reads do), since
    doing it per command was most of the time a long history took."""
    counts = {}
    for path in candidates:
        base = os.path.basename(path)
        counts[base] = counts.get(base, 0) + 1
    unique = {base for base, n in counts.items() if n == 1}
    return {path: (os.path.basename(path), _names(path, repo, unique)) for path in candidates}


def bash_writes(command, candidates, repo, spelled=None):
    """The candidate files (absolute paths) this Bash command writes to — the
    heuristic the top of the file describes. `spelled` is spellings() for
    these candidates, passed in by a caller with many commands to judge."""
    spelled = spellings(candidates, repo) if spelled is None else spelled
    # Skip a file the command never spells, before any pattern matching.
    named = [path for path in candidates if spelled[path][0] in command]
    if not named:
        return set()
    bodies, steps = _pieces(command)
    found = set()
    for path in named:
        names = spelled[path][1]
        if not _mentions(command, names):
            continue
        # A script (a heredoc body, or a `python3 -c` step) that writes and targets it.
        # A script the log cut short hides its end, where the write usually is;
        # one that long which opens the file is counted as writing it.
        scripted = any((_SCRIPT_WRITES.search(piece) or piece.endswith(_CUT))
                       and _script_targets(piece, names) for piece in bodies + steps)
        # A shell step that changes it: a verb on it, or a redirect into it.
        shelled = any(_mentions(step, names) and (_SHELL_VERBS.search(step) or any(
            re.search(r">>?\s*['\"]?" + re.escape(n) + r"(?![\w/.-])", step) for n in names))
            for step in steps)
        if scripted or shelled:
            found.add(path)
    return found


# Shell verbs that read the file they name (`sed -i` is a write, and is taken
# out by asking bash_writes first).
_READ_VERBS = re.compile(_COMMAND_START + r"(cat|head|tail|less|nl|wc|grep|rg|awk|sed)\b")


def bash_reads(command, candidates, repo, wanted=None, spelled=None):
    """The candidate files (absolute paths) this Bash command reads and does
    not write — a reading verb on the file, or a script that opens it without
    writing. `wanted` narrows the answer to those paths; `spelled` is
    spellings() for these candidates, as in bash_writes."""
    spelled = spellings(candidates, repo) if spelled is None else spelled
    # Skip a file the command never spells, before any pattern matching.
    named = [path for path in (candidates if wanted is None else set(candidates) & set(wanted))
             if spelled[path][0] in command]
    if not named:
        return set()
    written = bash_writes(command, candidates, repo, spelled)
    bodies, steps = _pieces(command)
    found = set()
    for path in named:
        if path in written:
            continue
        names = spelled[path][1]
        shelled = any(_READ_VERBS.search(step) and _mentions(step, names) for step in steps)
        scripted = any(_script_targets(body, names) for body in bodies)
        if shelled or scripted:
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
    spelled = spellings(candidates, repo)
    for conv, name, target, raw, cwd, at in rows:
        if name == "Bash":
            paths = bash_writes(_command(raw, target), candidates, repo, spelled)
        else:
            paths = {_edited_path(target, cwd, repo)} - {None}
        touched = found[owner[conv]]
        for path in paths:
            touched[path] = max(touched.get(path, ""), at)
    return found


def reads(lines, since, repo, candidates, wanted=None):
    """{session carrying the line: {absolute path: last read}} since `since`
    (any old stamp, or '' for a session's whole life). The same shape and
    arguments as `edits`: a Read call counts for any file, a Bash call only
    for `candidates` (bash_reads). `wanted` narrows the answer to those paths."""
    owner = {c: face for face, line in lines.items() for c in line}
    if not owner:
        return {}
    conn = sqlstore.open_db()
    try:
        marks = ",".join("?" * len(owner))
        rows = conn.execute(
            f"SELECT conv, name, target, input, cwd, at FROM tool_calls"
            f" WHERE at >= ? AND conv IN ({marks}) AND name IN ('Read', 'Bash')",
            (since or "", *owner)).fetchall()
    finally:
        conn.close()
    found = {face: {} for face in lines}
    spelled = spellings(candidates, repo)
    for conv, name, target, raw, cwd, at in rows:
        if name == "Bash":
            paths = bash_reads(_command(raw, target), candidates, repo, wanted, spelled)
        else:
            paths = {_edited_path(target, cwd, repo)} - {None}
            paths = paths if wanted is None else paths & set(wanted)
        seen = found[owner[conv]]
        for path in paths:
            seen[path] = max(seen.get(path, ""), at)
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
    # Name the overlaps the app has written down (file_alerts.py): two sessions
    # that changed one file, or one working from a copy another has changed
    # since. Nobody but the room helper is shown this, unless a line says so.
    import file_alerts
    recorded = file_alerts.recorded_lines(lines, repo, today)
    if recorded:
        out += ["", "## Overlaps the app has noticed", "",
                "Each pair and file is listed once, when first noticed. Unless a line says"
                " a session was told, the sessions don't know: whether to message them,"
                " make them a swarm or leave it is yours to decide.", ""] + recorded
    return "\n".join(out) + "\n"
