#!/usr/bin/env python3
"""Pure helpers for resolving Claude Code transcripts and summing token usage.

Two topologies feed a token-usage receipt (see dev_todo.md's research-runner
work):
  - `rw-<id>` worker sessions: clean 1:1 — own process, own JSONL. A
    whole-file token sum is correct as-is.
  - `research-runner` / `research-deep`: ONE reused process + ONE growing
    JSONL across many runs. Per-run tokens must be time-sliced by JSONL
    line `timestamp`, via `sum_tokens(..., since=, until=)`.

Kept import-light and Flask-free ON PURPOSE: this needs to be callable from
a CLI/cron context, not just inside the running app. routes/terminal.py
already has equivalent logic (`_proc_ancestors`, `_live_claude_sessions`,
`_transcript_path`) but importing that module drags in `routes.cards` ->
the full Flask/store chain. So the small pure pieces are re-implemented
here, standalone, rather than imported — keep the two in sync by eye if
Claude Code's on-disk formats ever change shape.

Confirmed against a real transcript under ~/.claude/projects/ (2026-07-17):
timestamps are ISO 8601 UTC with a trailing "Z" (e.g.
"2026-07-06T19:12:04.238Z"), and each assistant line's `message.usage` has
(at least) `input_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `output_tokens` — matches the brief exactly, no
correction needed. (Real usage objects also carry extra fields like
`cache_creation`, `iterations`, `service_tier` — ignored here, we only sum
the four counters above.)
"""
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

CLAUDE_HOME = Path.home() / ".claude"
# Same tmux socket routes/terminal.py drives (TMUX_SOCKET there) — hardcoded
# there too, so mirroring rather than importing is consistent with the
# no-Flask-import rule above.
TMUX_SOCKET = "/tmp/tmux-1000/default"

_ZERO_TOTALS = {"input": 0, "cache_creation": 0, "cache_read": 0, "output": 0, "total": 0}


def _tmux(cmd_str, timeout=5):
    cmd = f"tmux -S {TMUX_SOCKET} {cmd_str}"
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)


def _proc_ancestors(pid):
    """pid plus all its ancestors, via /proc. Mirrors
    routes/terminal.py's `_proc_ancestors` exactly — used to tell whether a
    tmux pane's foreground process is an ancestor of a given claude pid."""
    chain = []
    while pid and pid > 1 and pid not in chain:
        chain.append(pid)
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
            # ppid is the 2nd field after the parenthesised comm (which can
            # itself contain spaces/parens, hence rsplit on the last ')').
            pid = int(stat.rsplit(')', 1)[1].split()[1])
        except Exception:
            break
    return chain


def _live_claude_sessions():
    """Entries from Claude Code's live-process registry
    (~/.claude/sessions/<pid>.json) whose pid is still alive. Mirrors
    routes/terminal.py's `_live_claude_sessions`. Unreadable/stale entries
    are skipped; a missing or empty registry dir just yields []."""
    out = []
    for f in (CLAUDE_HOME / "sessions").glob("*.json"):
        try:
            info = json.loads(f.read_text())
            pid = int(info["pid"])
        except Exception:
            continue
        if Path(f"/proc/{pid}").exists():
            info["pid"] = pid
            out.append(info)
    return out


def sessionid_for_tmux(tmux_name):
    """Resolve a tmux session name to the Claude Code session running
    inside it: tmux pane pid -> live registry entry whose process-ancestry
    chain includes that pane pid (same match `routes/terminal.py`'s
    `_session_recap` does for the /sessions card).

    Returns (session_id, cwd) for the most-recently-updated matching
    registry entry, or None on any miss — dead/unknown tmux session, no
    claude running inside it, a registry entry that raced away, whatever.
    Never raises.
    """
    try:
        result = _tmux(f"list-panes -t {tmux_name} -F '#{{pane_pid}}'")
    except Exception:
        return None
    if result.returncode != 0:
        return None
    panes = (result.stdout or "").strip()
    if not panes:
        return None
    try:
        pane_pid = int(panes.splitlines()[0])
    except ValueError:
        return None

    best = None
    for info in _live_claude_sessions():
        if pane_pid in _proc_ancestors(info["pid"]):
            if best is None or info.get("updatedAt", 0) > best.get("updatedAt", 0):
                best = info
    if best is None:
        return None

    session_id = best.get("sessionId")
    if not session_id:
        return None
    return session_id, best.get("cwd")


def transcript_path(session_id, cwd):
    """Confirmed flatten: every non-alphanumeric char in cwd becomes '-'.
    Doesn't assume the path exists — callers check that themselves."""
    flat = re.sub(r'[^A-Za-z0-9]', '-', cwd or '')
    return CLAUDE_HOME / "projects" / flat / f"{session_id}.jsonl"


def _parse_timestamp(value):
    """Robust ISO 8601 parse, tolerant of the trailing 'Z' Claude Code
    writes (datetime.fromisoformat only accepts '+00:00' pre-3.11). Returns
    a tz-aware datetime, or None if value isn't a parseable string."""
    if not isinstance(value, str) or not value:
        return None
    text = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _coerce_dt(value):
    """Accept either a datetime or an ISO string for since/until; normalize
    to a tz-aware datetime (naive datetimes are assumed UTC, matching the
    transcript's own timestamps)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return _parse_timestamp(value)


def sum_tokens(session_id, cwd, since=None, until=None):
    """Stream the transcript JSONL and sum `message.usage.*` across
    assistant lines, optionally restricted to lines whose `timestamp` falls
    in [since, until] (inclusive) — the time-slice the shared
    research-runner/research-deep process needs, since one growing JSONL
    covers many runs there.

    Returns {"input", "cache_creation", "cache_read", "output", "total"}
    (total = sum of the other four). Missing file, unparseable lines, or a
    line with an unparseable timestamp when a window is given -> that line
    contributes zero, silently. Never raises.
    """
    totals = dict(_ZERO_TOTALS)
    path = transcript_path(session_id, cwd)
    if not path.exists():
        return totals

    since_dt = _coerce_dt(since)
    until_dt = _coerce_dt(until)
    windowed = since_dt is not None or until_dt is not None

    try:
        fh = path.open('r', encoding='utf-8', errors='replace')
    except OSError:
        return totals

    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(obj, dict):
                continue

            message = obj.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            usage = message.get("usage")
            if not isinstance(usage, dict):
                continue

            if windowed:
                ts = _parse_timestamp(obj.get("timestamp"))
                if ts is None:
                    continue
                if since_dt is not None and ts < since_dt:
                    continue
                if until_dt is not None and ts > until_dt:
                    continue

            try:
                inp = int(usage.get("input_tokens") or 0)
                cache_creation = int(usage.get("cache_creation_input_tokens") or 0)
                cache_read = int(usage.get("cache_read_input_tokens") or 0)
                out = int(usage.get("output_tokens") or 0)
            except (TypeError, ValueError):
                continue

            totals["input"] += inp
            totals["cache_creation"] += cache_creation
            totals["cache_read"] += cache_read
            totals["output"] += out

    totals["total"] = totals["input"] + totals["cache_creation"] + totals["cache_read"] + totals["output"]
    return totals


def session_receipt(session, now=None):
    """Compute a token+duration receipt for a research session record, for
    the close path (scripts/research_ctl.py's `close`, worker_apply_result's
    `apply_result`). Needs `claude_session` + `claude_cwd` on the record
    (stamped by the sessionId-capture step at spawn time — see
    research_ctl.capture_session_id) and `created` ('YYYY-MM-DD HH:MM',
    local system time, ~1min precision — same format the rest of the code
    reads/writes). Returns {"tokens": int, "duration_sec": float} on
    success, or {} if anything's missing/unparseable — callers just do
    `session.update(session_receipt(session))` and get the "no tokens
    field" degrade for free. Never raises.

    `created` is local system time but the transcript's own timestamps are
    UTC (see module docstring) — datetime.astimezone() on a naive datetime
    is presumed-local-then-converted per the stdlib, which is exactly the
    local -> UTC conversion the window needs, so `since`/`until` are built
    that way rather than passed straight through as naive.
    """
    claude_session = session.get("claude_session")
    claude_cwd = session.get("claude_cwd")
    created_raw = session.get("created")
    if not claude_session or not claude_cwd or not created_raw:
        return {}
    try:
        created_local = datetime.strptime(created_raw, "%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return {}
    now_local = now if now is not None else datetime.now()
    try:
        since_utc = created_local.astimezone(timezone.utc)
        until_utc = now_local.astimezone(timezone.utc)
        totals = sum_tokens(claude_session, claude_cwd, since=since_utc, until=until_utc)
        duration_sec = (now_local - created_local).total_seconds()
    except Exception:
        return {}
    return {"tokens": totals["total"], "duration_sec": duration_sec}
