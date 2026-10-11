#!/usr/bin/env python3
"""Footprint extractor for Terrain (docs/terrain design — the force-directed
file-tree heatmap of where work has happened).

Parses every `bot_chats/<conv>.jsonl` — the NDJSON event log of a
`claude -p --output-format stream-json` conversation (see
routes/observatory.py) — and harvests which files each conversation
touched, via the tool_use blocks in its assistant events:

    {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Edit", "input": {"file_path": "...", ...}},
        ...
    ]}}

Write-class tools (Edit, Write, NotebookEdit) count as writes; read-class
tools (Read, Grep, Glob) count as reads. Grep/Glob's `path` input may point
at a directory (or nothing at all — a bare pattern search) rather than a
concrete file, so those are only recorded when they resolve to a file that
actually exists on disk.

Bash is harvested too, from the COMMAND text only (never from its output):
a session run under the harness's auto permission mode does nearly all its
work through the shell — `sed -i`, `cat`, Python heredocs — and left no
footprint at all before this. Each command is split into its pieces and
only pieces whose program means the file was opened, changed, or run count;
searches and listings (grep, find, ls, git …) contribute nothing, however
many files they name. See `bash_touches` for the exact rules and what they
can't see. Everything else (WebFetch, Task, …) is still ignored.

A file the session CREATED fresh (a Write to a path that didn't exist) is
also counted, in its own `creates` tally. The tool_use can't tell a new file
from an overwrite, but the Write tool_RESULT can: it answers a new file with
"File created successfully at: <path>" and an overwrite/edit with "The file
<path> has been updated" — so that one result line is the reliable "created,
not just modified" signal. A created file always shows up in `writes` too;
`creates` just flags the novelty (Terrain rings it green while its agent is
active).

A conversation's own JSONL doesn't timestamp every event: only the human
turn-starter (`{"type": "user", "ts": ...}`, local time) and claude's own
tool-result/task envelopes (`{"type": "user", "timestamp": ...}`, UTC "Z")
carry a clock reading — a tool_use itself doesn't. So each touch is stamped
with the NEAREST timestamped event in the log (by line position, forward or
back) — close enough for a heatmap's "last touched" without needing to
thread tool_use_id -> tool_result pairs through nested subagent calls.

Output is a derived sidecar, `bot_chats/footprints.json`, written via
`store.mutate()` (its own `.lock`, independent of `index.json`'s). It is a
FULL REBUILD every run — idempotent, safe to cron or re-run by hand:

    {"<conv_id>": {"files": {"<abs_path>": {"writes": n, "reads": n,
                                             "creates": n, "last": "<iso ts>"}}, ...},
                    "extracted_at": "<iso ts>"}, ...}

Usage:
    scripts/extract_footprints.py             # rebuild footprints.json for real
    scripts/extract_footprints.py --dry-run   # print per-conv counts, write nothing
"""
import argparse
import bisect
import json
import os
import re
import shlex
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store                                       # noqa: E402

WRITE_TOOLS = frozenset(("Edit", "Write", "NotebookEdit"))
READ_TOOLS = frozenset(("Read", "Grep", "Glob"))

# The Write tool's result line for a brand-new file (vs. "The file ... has been
# updated" for an overwrite) — the one place in the log that distinguishes a
# creation from a modification.
_CREATED_MARKER = "File created successfully at: "

# Sidecars/locks that live alongside the conversation logs in bot_chats/ —
# never conversation transcripts themselves.
_NON_CONV_STEMS = frozenset(("index", "gists", "footprints"))


def _classify_tool(name):
    if name in WRITE_TOOLS:
        return "write"
    if name in READ_TOOLS:
        return "read"
    return None


def _tool_path(name, inp):
    """The path a tool_use's input claims to touch, per tool shape."""
    if not isinstance(inp, dict):
        return None
    if name in ("Edit", "Write"):
        return inp.get("file_path")
    if name == "NotebookEdit":
        return inp.get("notebook_path")
    if name in ("Grep", "Glob"):
        return inp.get("path")
    return None


def _result_text(content):
    """A tool_result's text, whether it arrived as a bare string or as a list
    of content blocks (both shapes show up across CC versions)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                return block["text"]
    return None


def _created_path(content):
    """The absolute path a Write tool_result reports creating fresh, or None.
    Matches the '<marker><path>' line; the path is followed by a
    ' (file state ...)' note in current CC, which is trimmed off."""
    text = _result_text(content)
    if not text:
        return None
    text = text.lstrip()
    if not text.startswith(_CREATED_MARKER):
        return None
    rest = text[len(_CREATED_MARKER):]
    cut = rest.find(" (file state")
    if cut != -1:
        rest = rest[:cut]
    rest = rest.strip()
    return rest or None


def _normalize_path(path, conv_cwd):
    """Absolute + normalized, resolving a relative path against the
    conversation's own cwd (bot_chats/index.json's per-conv `cwd`) when one
    isn't already absolute. Returns None if it can't be resolved at all."""
    if not isinstance(path, str) or not path.strip():
        return None
    p = path.strip()
    if not os.path.isabs(p):
        if not conv_cwd:
            return None
        p = os.path.join(conv_cwd, p)
    return os.path.normpath(p)


# --- Bash: which files a shell command actually opened, changed, or ran ------
#
# Plain English: the transcript records a Bash call as one string of shell
# text plus whatever it printed. The printed half is useless for attribution
# (an edit prints nothing; a search prints file names it merely LOOKED
# THROUGH), so this reads the command and nothing else. A command is split
# into its pieces at &&, ||, |, ; and newlines — quote-aware, so a sed
# pattern like 's|a|b|' stays whole — and each piece is judged by the
# program it starts with:
#
#   read     cat head tail less more wc diff, and sed WITHOUT -i
#   write    sed -i, tee, cp/mv (the target), and any `>` / `>>` redirect
#   run      python/python3, pytest, bash/sh, node, or a script invoked by
#            path — counted as a READ of the file that ran, since the map's
#            footprint has two counters and "the agent used this file" is
#            what a read means there
#   ignored  everything else: grep, rg, find, ls, git, echo, npm, curl …
#
# A path that appears only in an ignored piece never counts. That is the
# owner's rule, verbatim from the prompt that produced this: "i just don't
# want like random searches to show up … just stuff that it actually read
# and executed on".
#
# Two shapes the coding sessions lean on get special handling. A simple
# variable set earlier in the same command (`f=routes/x.py && sed -i … $f`)
# is substituted back, so the path isn't lost behind `$f`. A Python heredoc
# (`python3 - <<'PY' … PY`) is scanned for the quoted paths its source opens:
# a write if the source calls write_text / open(…, "w") / .write(, a read
# otherwise. Heredocs fed to anything other than python are file CONTENT, not
# commands, and are skipped.
#
# What this can't see, honestly: a file reached through a glob, a `find`, or
# a variable assembled from pieces; a file the command deleted (the existence
# check drops it); whether the command actually succeeded; and any program
# not in the tables above (add it and its files start counting). Scratch
# under /tmp, /dev and /proc is dropped — it is never the work.

_BASH_READ_PROGS = frozenset(("cat", "head", "tail", "less", "more", "wc", "diff", "sed"))
_BASH_WRITE_PROGS = frozenset(("tee", "cp", "mv"))
_BASH_RUN_PROGS = frozenset(("python", "python3", "pytest", "bash", "sh", "node"))
_BASH_SKIP_PREFIXES = ("/tmp/", "/dev/", "/proc/", "/var/tmp/")
_BASH_SEPARATORS = frozenset(("&&", "||", "|", ";", "(", ")", "&"))
_BASH_HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n(.*?)^\s*\2\s*$", re.S | re.M)
_BASH_ASSIGN_RE = re.compile(r"^([A-Za-z_]\w*)=(.*)$")
_BASH_VAR_RE = re.compile(r"\$\{?([A-Za-z_]\w*)\}?")
_BASH_PY_STRING_RE = re.compile(r"""['"]([^'"\n]+)['"]""")
_BASH_PY_WRITE_RE = re.compile(r"write_text\(|write_bytes\(|\.write\(|open\([^)]*['\"][wa]")


def _bash_file(token, cwd):
    """A token that names a real file (resolved against `cwd`), or None.
    Flags, numbers, globs, directories and scratch paths all fall out here."""
    if not token or token.startswith("-"):
        return None
    if any(ch in token for ch in "*?[\n"):
        return None
    abspath = _normalize_path(token, cwd)
    if abspath is None or abspath.startswith(_BASH_SKIP_PREFIXES):
        return None
    return abspath if os.path.isfile(abspath) else None


def _bash_heredocs(command):
    """Strip heredoc bodies out of the command, returning (command_without_
    bodies, [body, ...]) — the bodies are scanned separately if python ate
    them, and must not be parsed as shell."""
    bodies = []

    def _take(m):
        bodies.append(m.group(3))
        return "<<" + m.group(2) + "\n"

    return _BASH_HEREDOC_RE.sub(_take, command), bodies


def _bash_segments(command):
    """The command's pieces as token lists, split quote-aware at the shell
    separators. A command shlex can't tokenize (an unbalanced quote) falls
    back to a crude whitespace split of the whole thing as one piece."""
    text = command.replace("\\\n", " ").replace("\n", " ; ")
    try:
        lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        tokens = text.split()
    segments, current = [], []
    for tok in tokens:
        if tok in _BASH_SEPARATORS:
            if current:
                segments.append(current)
            current = []
        else:
            current.append(tok)
    if current:
        segments.append(current)
    return segments


def _bash_python_body(body, cwd):
    """(kind, abspath) for every real file a Python heredoc names in a string
    literal; the whole body is a write if it contains a write call."""
    kind = "write" if _BASH_PY_WRITE_RE.search(body) else "read"
    out = []
    for lit in _BASH_PY_STRING_RE.findall(body):
        abspath = _bash_file(lit, cwd)
        if abspath is not None:
            out.append((kind, abspath))
    return out


def bash_touches(command, conv_cwd):
    """[(kind, abspath), ...] — the files one Bash command actually opened,
    changed, or ran, per the rules in the block comment above. `kind` is
    "read" or "write". Order follows the command; a file can repeat."""
    if not isinstance(command, str) or not command.strip():
        return []
    stripped, bodies = _bash_heredocs(command)
    cwd = conv_cwd
    env = {}
    out = []
    body_iter = iter(bodies)
    for seg in _bash_segments(stripped):
        # Substitute the simple variables set earlier in this same command.
        seg = [_BASH_VAR_RE.sub(lambda m: env.get(m.group(1), m.group(0)), t) for t in seg]
        # Leading NAME=value assignments: remember them, then step past.
        i = 0
        while i < len(seg):
            m = _BASH_ASSIGN_RE.match(seg[i])
            if not m:
                break
            env[m.group(1)] = m.group(2)
            i += 1
        seg = seg[i:]
        if seg and seg[0] == "sudo":
            seg = seg[1:]
        if not seg:
            continue
        # A heredoc marker in this piece: its body belongs to this program.
        heredoc_body = None
        if "<<" in seg:
            j = seg.index("<<")
            heredoc_body = next(body_iter, None)
            seg = seg[:j] + seg[j + 2:]
            if not seg:
                continue
        prog = os.path.basename(seg[0])
        args = seg[1:]
        if prog == "cd":
            target = args[0] if args else None
            if target:
                moved = _normalize_path(target, cwd)
                if moved is not None:
                    cwd = moved
            continue
        # Redirect targets are writes whatever the program is.
        redirect_targets = set()
        plain = []
        k = 0
        while k < len(args):
            tok = args[k]
            if tok in (">", ">>"):
                if k + 1 < len(args):
                    redirect_targets.add(args[k + 1])
                k += 2
                continue
            if tok in ("<", ">&", "<&", "&>", "2>", "2>>"):
                k += 2
                continue
            plain.append(tok)
            k += 1
        for tok in redirect_targets:
            abspath = _bash_file(tok, cwd)
            if abspath is not None:
                out.append(("write", abspath))
        if prog in _BASH_RUN_PROGS and heredoc_body is not None and prog.startswith("python"):
            out.extend(_bash_python_body(heredoc_body, cwd))
        if prog in _BASH_READ_PROGS:
            in_place = prog == "sed" and any(
                a == "-i" or a.startswith("-i.") or a == "--in-place" or a.startswith("--in-place=")
                or (a.startswith("-") and not a.startswith("--") and "i" in a[1:] and "n" not in a[1:])
                for a in plain)
            kind = "write" if in_place else "read"
            for tok in plain:
                abspath = _bash_file(tok, cwd)
                if abspath is not None:
                    out.append((kind, abspath))
        elif prog in _BASH_WRITE_PROGS:
            files = [tok for tok in plain if _bash_file(tok, cwd) is not None]
            if prog == "tee":
                for tok in files:
                    out.append(("write", _bash_file(tok, cwd)))
            elif files:
                # cp/mv: the last path is the target (a write); a cp source
                # is a read; a mv source no longer exists and drops out.
                if prog == "cp":
                    for tok in files[:-1]:
                        out.append(("read", _bash_file(tok, cwd)))
                out.append(("write", _bash_file(files[-1], cwd)))
        elif prog in _BASH_RUN_PROGS or _bash_file(seg[0], cwd) is not None:
            # Running a file is using it: the interpreter's script, the test
            # file handed to pytest, or a script invoked straight by path.
            candidates = plain if prog in _BASH_RUN_PROGS else [seg[0]] + plain
            for tok in candidates:
                abspath = _bash_file(tok, cwd)
                if abspath is not None:
                    out.append(("read", abspath))
        # anything else: a search, a listing, git, echo … contributes nothing.
    return out


def _parse_ts(raw):
    """Epoch seconds for an iso-ish timestamp string, local-naive or
    'Z'-suffixed UTC (both shapes appear in these logs) — or None if it
    doesn't parse."""
    if not isinstance(raw, str) or not raw:
        return None
    s = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def _nearest_ts(ts_index, ts_line_nums, line_idx):
    """The (epoch, raw_str) of whichever timestamped event is closest (by
    line position) to `line_idx` — a tool_use itself carries no clock
    reading, so this is our best-effort stand-in for "when this touch
    happened". `ts_index` is a list of (line_idx, epoch, raw) sorted by
    line_idx; `ts_line_nums` is the parallel list of just the line indices,
    kept separate for bisect."""
    if not ts_index:
        return None, None
    pos = bisect.bisect_left(ts_line_nums, line_idx)
    candidates = []
    if pos < len(ts_index):
        candidates.append(ts_index[pos])
    if pos > 0:
        candidates.append(ts_index[pos - 1])
    best = min(candidates, key=lambda t: abs(t[0] - line_idx))
    return best[1], best[2]


def _extract_touches(events, conv_cwd):
    """(ts_index, touches, creates) for one conversation's event list.

    ts_index: [(line_idx, epoch, raw_str), ...] sorted by line_idx.
    touches:  [(line_idx, "write"|"read", abs_path), ...] in log order.
    creates:  [(line_idx, abs_path), ...] — files a Write tool_result reported
              creating fresh. Harvested from the RESULT (a user event), not the
              tool_use, since only the result distinguishes new from overwrite.
    """
    ts_index = []
    touches = []
    creates = []
    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            continue
        raw_ts = ev.get("ts") or ev.get("timestamp")
        epoch = _parse_ts(raw_ts)
        if epoch is not None:
            ts_index.append((i, epoch, raw_ts))
        # tool_use lives in assistant events, tool_result in user events — scan
        # any message.content list and dispatch on the item type, so both are
        # covered in one pass.
        msg = ev.get("message")
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            itype = item.get("type")
            if itype == "tool_use":
                if item.get("name") == "Bash":
                    # Shell work: several files per call, judged by program
                    # (see bash_touches). The output is never consulted.
                    inp = item.get("input")
                    cmd = inp.get("command") if isinstance(inp, dict) else None
                    for kind, abspath in bash_touches(cmd, conv_cwd):
                        touches.append((i, kind, abspath))
                    continue
                kind = _classify_tool(item.get("name"))
                if kind is None:
                    continue
                raw_path = _tool_path(item.get("name"), item.get("input"))
                abspath = _normalize_path(raw_path, conv_cwd)
                if abspath is None:
                    continue
                if kind == "read" and not os.path.isfile(abspath):
                    continue  # Grep/Glob at a dir (or a since-vanished path) — skip
                touches.append((i, kind, abspath))
            elif itype == "tool_result":
                created = _created_path(item.get("content"))
                if created is None:
                    continue
                abspath = _normalize_path(created, conv_cwd)
                if abspath is not None:
                    creates.append((i, abspath))
    return ts_index, touches, creates


def _aggregate(touches, creates, ts_index, fallback_last):
    """Per-conv touches -> {abs_path: {"writes", "reads", "creates", "last"}}."""
    ts_line_nums = [t[0] for t in ts_index]
    files = {}

    def _entry(abspath):
        return files.setdefault(abspath, {"writes": 0, "reads": 0, "creates": 0,
                                          "_last_epoch": None, "last": fallback_last})

    def _stamp(entry, line_idx):
        epoch, raw = _nearest_ts(ts_index, ts_line_nums, line_idx)
        if epoch is not None and (entry["_last_epoch"] is None or epoch > entry["_last_epoch"]):
            entry["_last_epoch"] = epoch
            entry["last"] = raw

    for line_idx, kind, abspath in touches:
        entry = _entry(abspath)
        entry["writes" if kind == "write" else "reads"] += 1
        _stamp(entry, line_idx)
    for line_idx, abspath in creates:
        entry = _entry(abspath)
        entry["creates"] += 1
        _stamp(entry, line_idx)
    for entry in files.values():
        del entry["_last_epoch"]
    return files


def harvest_conversation(path, conv_cwd, fallback_last=None):
    """One conversation's jsonl -> {abs_path: {"writes": n, "reads": n,
    "creates": n, "last": iso}} — the same harvest the batch run does, exposed
    as an importable seam so routes/observatory.py can re-parse a RUNNING
    conversation live (the batch sidecar is stale the moment a turn is
    mid-flight) without duplicating any of the parsing logic."""
    events = _load_events(Path(path))
    ts_index, touches, creates = _extract_touches(events, conv_cwd)
    return _aggregate(touches, creates, ts_index, fallback_last)


# The written text per tool shape — what the flow lane shows as "the lines
# being written". Edit carries its replacement text, Write the whole file
# body, NotebookEdit the new cell source.
_SNIPPET_KEYS = {"Edit": "new_string", "Write": "content", "NotebookEdit": "new_source"}


def harvest_flow_events(path, conv_cwd):
    """One conversation's jsonl -> its write events IN ORDER, each carrying the
    text that was written — the event-level sibling of harvest_conversation's
    per-file tallies, for the live "code being written" lane
    (routes/terrain.py's /api/observatory/flow):

        [{"line": i, "tool": "Edit"|"Write"|"NotebookEdit", "path": abs,
          "snippet": str|None, "created": bool, "epoch": float|None,
          "ts": iso|None}, ...]

    Timestamps are the same best-effort nearest-timestamped-event stand-in the
    footprint harvest uses. `created` comes from the Write tool_result's "File
    created successfully" line; the result lands after its tool_use, so it
    flips the latest still-unflagged event for that path. List position is
    stable across re-parses (the log is append-only), so callers may use it as
    an event id.

    Prompt that produced it: "another additional visual where I see what code
    is being written in real time"."""
    events = _load_events(Path(path))
    ts_index = []
    out = []
    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            continue
        raw_ts = ev.get("ts") or ev.get("timestamp")
        epoch = _parse_ts(raw_ts)
        if epoch is not None:
            ts_index.append((i, epoch, raw_ts))
        msg = ev.get("message")
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            itype = item.get("type")
            if itype == "tool_use" and item.get("name") in WRITE_TOOLS:
                name = item.get("name")
                inp = item.get("input")
                abspath = _normalize_path(_tool_path(name, inp), conv_cwd)
                if abspath is None:
                    continue
                snippet = inp.get(_SNIPPET_KEYS[name]) if isinstance(inp, dict) else None
                if not isinstance(snippet, str) or not snippet.strip():
                    snippet = None
                out.append({"line": i, "tool": name, "path": abspath,
                            "snippet": snippet, "created": False})
            elif itype == "tool_result":
                created = _normalize_path(_created_path(item.get("content")), conv_cwd)
                if created is None:
                    continue
                for evd in reversed(out):
                    if evd["path"] == created and not evd["created"]:
                        evd["created"] = True
                        break
    ts_line_nums = [t[0] for t in ts_index]
    for evd in out:
        epoch, raw = _nearest_ts(ts_index, ts_line_nums, evd["line"])
        evd["epoch"] = epoch
        evd["ts"] = raw
    return out


def _load_events(path):
    events = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except ValueError:
                continue  # a torn line (crash mid-append) shouldn't hide the rest
    return events


def _conv_files():
    chats_dir = store.DATA_DIR / "bot_chats"
    if not chats_dir.exists():
        return []
    return sorted(p for p in chats_dir.glob("*.jsonl") if p.stem not in _NON_CONV_STEMS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="print per-conversation file counts; write nothing")
    args = parser.parse_args()

    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        index = {}
    conv_paths = _conv_files()
    extracted_at = datetime.now().isoformat(timespec="seconds")

    result = {}
    total_writes = total_reads = total_creates = total_touches = total_files = 0
    for path in conv_paths:
        conv_id = path.stem
        meta = index.get(conv_id) if isinstance(index.get(conv_id), dict) else {}
        files = harvest_conversation(path, meta.get("cwd"),
                                     meta.get("last_at") or meta.get("started"))
        writes = sum(f["writes"] for f in files.values())
        reads = sum(f["reads"] for f in files.values())
        creates = sum(f["creates"] for f in files.values())
        total_writes += writes
        total_reads += reads
        total_creates += creates
        total_touches += writes + reads   # every touch lands in exactly one counter
        total_files += len(files)
        if args.dry_run:
            print(f"{conv_id}: {len(files)} files ({writes} writes, {reads} reads, "
                  f"{creates} created)")
        else:
            result[conv_id] = {"files": files, "extracted_at": extracted_at}

    if args.dry_run:
        print(f"\nTOTAL: {len(conv_paths)} conversations, {total_files} file entries, "
              f"{total_touches} touches ({total_writes} writes, {total_reads} reads, "
              f"{total_creates} created) — dry run, nothing written")
        return

    with store.mutate("bot_chats/footprints", {}) as data:
        data.clear()
        data.update(result)

    files_attributed = sum(len(c["files"]) for c in result.values())
    print(f"extract_footprints: {len(conv_paths)} conversations processed, "
          f"{files_attributed} file entries attributed, {total_touches} touches "
          f"({total_writes} writes, {total_reads} reads) -> "
          f"{store.DATA_DIR / 'bot_chats' / 'footprints.json'}")


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    main()
