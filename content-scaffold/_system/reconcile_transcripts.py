#!/usr/bin/env python3
"""
reconcile_transcripts.py — the safety net under keeper_capture.py's instant capture.

Capture-at-source has two doors already: an app can mint Chat-tab sends at the SERVER
(before text ever reaches a terminal), and keeper_capture.py — the UserPromptSubmit
hook — mints direct terminal typing the instant it's sent. Both are fast. Neither is
guaranteed. Hooks snapshot at claude-process launch: a tmux pane left open across a
hook change (or a stale process for any reason) has a dead hook and silently drops
everything typed into it. Interrupts and rapid-fire sends can also slip past a live
hook. There is no notification when a hook dies; the first anyone knows is a gap in
the pool.

Claude Code doesn't know any of this happened, and doesn't need to: every session,
armed or not, hook alive or not, gets its own transcript at
`~/.claude/projects/<munged-cwd>/<session-id>.jsonl`, one JSON object per line,
appended to unconditionally by the harness itself. That file is ground truth for what
was actually typed, independent of whether our hook was there to see it. This module
is a cron'd tail of that ground truth: walk the armed keeper transcripts, mint
whatever prompt text isn't already in the pool, and get out. It turns "capture usually
works" into "capture cannot be lost, at worst about a cron-interval late." The hook
stays the instant path; this is the guarantee underneath it, not a replacement for it.

ARMING. A transcript must not be journaled just because it lives at the keeper root —
dev sessions open there too. So this module re-derives the same one-way latch
keeper_capture.py uses: a session arms the moment the `/journalstart` expansion's
`<!-- KEEPER_SESSION_ACTIVE` sentinel shows up as a real operator turn (`user`-type,
plain text block, non-synthetic — never a tool_result echoing a file that merely
*mentions* the token, never a task-notification quoting it back). Unarmed transcripts
are read but never minted from. keeper_capture.SENTINEL and SYNTHETIC_PREFIXES are
imported rather than redefined — one fence, not two that can drift apart.

BOOTSTRAP. A pool's history can predate this reconciler, with cards hand-minted through
every outage that preceded it. On its very first run — detected by the absence of a
state file, not a flag — this module arms every transcript it finds exactly as if it
had been watching all along, records each file's *current* size as its starting
offset, and mints nothing. Backfilling months of old sessions on install would flood
old days with cards nobody asked for. From that moment on, only new bytes count.

DEDUP. A body-for-body check against the pool (the prompt's local date plus its two
neighbors, since a message near local midnight can land a card on the adjacent day) is
the second line of defense — the same words may already be sitting in the pool because
the hook actually did fire. This also has to eat one deliberate non-match: a composer's
large-paste path can replace the pane text with a bare `[uploaded: ..._paste.txt]`
marker while the real text is minted server-side under a different body entirely — a
body-match can never catch that substitution, so it's skipped by pattern instead.

Cron-safe: a non-blocking flock means an overlapping run exits instantly rather than
racing the one already in flight. A mint failure is caught per-line, logged to the
same failure sidecar keeper_capture.py uses, and never aborts the rest of the file.
Stdlib only.
"""
import fcntl
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Self-locating, same trick as keeper_capture.py: this file lives at
# <content_dir>/_system/reconcile_transcripts.py, so CONTENT_ROOT is the journal's
# content root regardless of where the repo is mounted.
CONTENT_ROOT = Path(__file__).resolve().parent.parent
STATE_PATH = CONTENT_ROOT / ".keeper" / "reconciler_state.json"
LOCK_PATH = CONTENT_ROOT / ".keeper" / "reconciler.lock"
FAILURE_LOG = CONTENT_ROOT / ".keeper" / "capture-failures.jsonl"

sys.path.insert(0, str(Path(__file__).resolve().parent))
import keeper_capture  # noqa: E402 — reuse SENTINEL, SYNTHETIC_PREFIXES, and the
import stream          # noqa: E402   whole-file sentinel scan for bootstrap.

# Harness-injected caveat, not operator text — surfaced when a prior turn was
# interrupted mid-stream. keeper_capture.py doesn't need this one (it only ever sees
# live prompts, and an interrupt caveat never arrives as a fresh UserPromptSubmit); a
# transcript tail does see it, so it's local to this module rather than imported.
INTERRUPTED_PREFIX = "[Request interrupted"

# What a web terminal can type into the pane in place of a long composer paste — the
# real text was already minted server-side under a different body, so dedup by body
# can't catch this one; it has to be recognized and skipped outright.
_UPLOAD_PASTE_RE = re.compile(r"\[uploaded: \S+_paste\.txt\]")


def _default_project_dirs() -> List[Path]:
    """Every project directory Claude Code has ever written a transcript into.

    A fresh install could be checked out anywhere, so there's no single fixed cwd to
    hardcode here (unlike a one-off personal vault, which always knows its own path).
    Scanning everything under ~/.claude/projects/ is cheap — this only runs on a cron
    interval — and safe: a transcript is only ever minted from once it actually arms
    (the /journalstart sentinel), so a broader scan costs a bit of local I/O, never a
    false capture. Narrow it with STREAM_RECONCILER_PROJECT_DIRS if that's ever worth
    doing (e.g. a shared machine with many unrelated Claude Code projects)."""
    base = Path.home() / ".claude" / "projects"
    if not base.exists():
        return []
    return sorted(p for p in base.iterdir() if p.is_dir())


def project_dirs() -> List[Path]:
    """Lazy on purpose, like stream.py's stream_root() — read the env var on every
    call (never cached at import time) so tests can point this at a tempdir without
    reimporting the module. STREAM_RECONCILER_PROJECT_DIRS is os.pathsep-separated."""
    env = os.environ.get("STREAM_RECONCILER_PROJECT_DIRS")
    if env:
        return [Path(p) for p in env.split(os.pathsep) if p]
    return _default_project_dirs()


# --------------------------------------------------------------------------------
# main / locking
# --------------------------------------------------------------------------------

def main() -> int:
    """Cron entry point. Always exits 0 — a reconciler that can crash cron is worse
    than a reconciler that occasionally does nothing."""
    try:
        LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        lock_fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_RDWR)
    except OSError:
        return 0
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(lock_fd)   # another run already holds it — cron runs can overlap,
        return 0             # this one just steps aside silently.
    try:
        _run()
    except Exception as e:
        _log_failure("", f"top-level reconciler failure: {e!r}")
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)
    return 0


def _list_transcripts() -> List[Path]:
    paths: List[Path] = []
    for d in project_dirs():
        if d.exists():
            paths.extend(sorted(d.glob("*.jsonl")))   # top level only — no recursion
    return paths


def _run() -> None:
    if not STATE_PATH.exists():
        _bootstrap()
        return
    state = _load_state()
    for path in _list_transcripts():
        key = str(path)
        entry = state.get(key) or {"offset": 0, "armed": False}
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size < entry.get("offset", 0):
            entry["offset"] = 0   # rotation/truncation shouldn't happen; dedup makes
                                   # a full re-scan idempotent rather than dangerous.
        state[key] = _process_file(path, entry)
        _save_state(state)         # persisted after every file — a crash mid-run
                                    # loses at most the file in flight, never earlier work.


def _bootstrap() -> None:
    """First-ever run: arm every transcript currently on disk as if we'd been
    watching all along, and mint nothing. See the module docstring's BOOTSTRAP
    section for why — the pool's own history already covers this ground."""
    state: Dict[str, dict] = {}
    for path in _list_transcripts():
        armed = keeper_capture._transcript_has_sentinel(str(path))
        state[str(path)] = {"offset": path.stat().st_size, "armed": armed}
    _save_state(state)


# --------------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------------

def _load_state() -> Dict[str, dict]:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_state(state: Dict[str, dict]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_name(STATE_PATH.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, STATE_PATH)


# --------------------------------------------------------------------------------
# per-file processing
# --------------------------------------------------------------------------------

def _process_file(path: Path, entry: dict) -> dict:
    offset = entry.get("offset", 0)
    armed = entry.get("armed", False)
    try:
        with path.open("rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return {"offset": offset, "armed": armed}   # try again next run
    if not data:
        return {"offset": offset, "armed": armed}

    # Only complete lines: a writer mid-append can leave a trailing partial line —
    # leave it at the front of next run's read rather than parsing a truncated JSON
    # object as garbage (which would just get skipped, but also silently drop the
    # tail of a real prompt this run didn't wait for).
    if data.endswith(b"\n"):
        consumed = len(data)
    else:
        last_nl = data.rfind(b"\n")
        if last_nl == -1:
            return {"offset": offset, "armed": armed}   # no complete line yet
        consumed = last_nl + 1
    chunk = data[:consumed]

    for raw_line in chunk.split(b"\n"):
        if not raw_line.strip():
            continue
        try:
            obj = json.loads(raw_line.decode("utf-8"))
        except Exception:
            continue   # unparseable line — skip it, offset still advances past it
        if not armed and _entry_arms_session(obj):
            armed = True
        if armed:
            _maybe_mint(obj, path)

    return {"offset": offset + consumed, "armed": armed}


def _entry_arms_session(entry: dict) -> bool:
    """Per-entry version of keeper_capture._transcript_has_sentinel's three fences,
    for a line the tail loop has already parsed: `user`-type, sentinel in a plain
    text block (never a tool_result — file contents flow through those), and that
    block isn't harness-synthetic. Same rules, same source of truth for the token."""
    if entry.get("type") != "user":
        return False
    content = (entry.get("message") or {}).get("content")
    blocks = ([{"type": "text", "text": content}] if isinstance(content, str)
              else (content or []))
    needle = "<!-- " + keeper_capture.SENTINEL
    for b in blocks:
        if not isinstance(b, dict) or b.get("type") != "text":
            continue
        text = b.get("text") or ""
        if text.lstrip().startswith(keeper_capture.SYNTHETIC_PREFIXES):
            continue
        if needle in text:
            return True
    return False


# --------------------------------------------------------------------------------
# candidate prompt extraction + minting
# --------------------------------------------------------------------------------

def _prompt_text(entry: dict) -> Optional[str]:
    """The operator's text for a `user` transcript entry, or None if this entry
    isn't a candidate turn at all (wrong type, a sidechain sub-agent turn, or a
    harness-injected meta caveat) — distinct from an empty string, which IS a
    candidate that the skip rules will discard for being blank."""
    if entry.get("type") != "user":
        return None
    if entry.get("isSidechain"):
        return None
    if entry.get("isMeta"):
        return None
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [b.get("text", "") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(texts) if texts else ""
    return ""


def _maybe_mint(entry: dict, path: Path) -> None:
    text = _prompt_text(entry)
    if text is None:
        return
    prompt = text.strip()
    if not prompt:
        return
    if prompt.startswith(keeper_capture.SYNTHETIC_PREFIXES):
        return
    if prompt.startswith(INTERRUPTED_PREFIX):
        return
    if prompt.startswith("/"):          # slash commands — not a journaled utterance
        return
    if _UPLOAD_PASTE_RE.fullmatch(prompt):
        return

    ts_local = _to_local(entry.get("timestamp"))
    if ts_local is None:
        _log_failure(prompt, "unparseable or missing transcript timestamp")
        return
    if _already_captured(prompt, ts_local):
        return

    try:
        cid = stream.record(who="B", body=prompt, ts=ts_local)
    except Exception as e:
        _log_failure(prompt, repr(e))   # never abort the file over one bad line
        return
    now = datetime.now().isoformat(timespec="seconds")
    print(f"{now} {path.stem} {cid} {prompt[:60]!r}")


def _to_local(ts_str: Optional[str]) -> Optional[datetime]:
    """Transcript timestamps are UTC ISO-8601 with a trailing 'Z' and fractional
    seconds — fromisoformat doesn't accept 'Z' directly, so it's swapped for an
    explicit offset first. Converted to local time because that's what every other
    card's `ts` is stamped in (stream.record's default is datetime.now(), local)."""
    if not ts_str:
        return None
    try:
        s = ts_str[:-1] + "+00:00" if ts_str.endswith("Z") else ts_str
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone()
    except ValueError:
        return None


# --------------------------------------------------------------------------------
# dedup — direct, minimal card-file reads (not stream.parse_card_file, which
# enforces every required field; a dedup scan should be forgiving of anything in
# the pool, not raise on it).
# --------------------------------------------------------------------------------

def _read_card_light(path: Path) -> Tuple[Optional[str], str]:
    """(who, body) for a card file, parsed by splitting on the frontmatter's second
    '---' line — same shape stream.py uses, without stream's strict field checks."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None, ""
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None, ""
    front, body = parts[1], parts[2]
    if body.startswith("\n"):
        body = body[1:]
    who = None
    for line in front.strip("\n").split("\n"):
        if line.startswith("who:"):
            who = line.split(":", 1)[1].strip()
            break
    return who, body


def _already_captured(prompt: str, ts_local: datetime) -> bool:
    """True iff this exact body already exists as a `B` card on the prompt's local
    date or either adjacent date (a message near local midnight can land its card on
    the neighboring day depending on exactly when it was minted)."""
    pool = stream.pool_dir()
    if not pool.exists():
        return False
    target = prompt.strip()
    dates = {(ts_local + timedelta(days=d)).strftime("%Y-%m-%d") for d in (-1, 0, 1)}
    for date in dates:
        for card_file in pool.glob(f"{date}.*.md"):
            who, body = _read_card_light(card_file)
            if who == "B" and body.strip() == target:
                return True
    return False


# --------------------------------------------------------------------------------
# failure sidecar — same shape as keeper_capture._log_failure, tagged with source
# so the two producers of this file stay distinguishable.
# --------------------------------------------------------------------------------

def _log_failure(prompt: str, error: str) -> None:
    try:
        FAILURE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with FAILURE_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": datetime.now().isoformat(timespec="seconds"),
                "error": error,
                "prompt": prompt,
                "source": "reconciler",
            }, ensure_ascii=False) + "\n")
    except Exception:
        pass   # last resort — still never let a logging failure cascade


if __name__ == "__main__":
    sys.exit(main())
