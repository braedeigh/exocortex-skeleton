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
actually exists on disk. Bash and everything else are ignored for v1 — no
path to harvest reliably.

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
    main()
