"""Background Haiku-powered session summaries for the /sessions page.

routes/terminal.py's `_session_recap()` normally shows the last assistant
message from a Claude Code transcript as the card's "recap" -- literally the
last output, not a summary. This module upgrades that: `get_summary()` looks
up a cached one-to-two-sentence summary (produced by `claude -p --model
claude-haiku-4-5`) and, if the transcript has grown since the summary was
made, kicks off a background refresh -- but always returns immediately with
whatever's cached (or None). The caller never blocks on the CLI and this
module never raises.

No Flask imports here on purpose (like proxy_auth.py) -- pure logic, callable
from tests and terminal.py alike without dragging in server.py's startup.

Cache lives in the `recap_summaries` store collection (via store.py), keyed
by Claude sessionId:

    {"<sessionId>": {"summary": str,
                      "key": [mtime_ns, size],   # transcript stat when made
                      "at": epoch_int}}           # when it was generated

capped at _CACHE_MAX entries, oldest-`at` dropped first.
"""
from pathlib import Path
import json
import re
import subprocess
import threading
import time

import store

CLAUDE_BIN = str(Path.home() / ".local/bin/claude")
SUMMARY_MODEL = "claude-haiku-4-5"

COLLECTION = "recap_summaries"
_CACHE_MAX = 64

# Tail window read from the transcript before building the dialogue -- same
# idea as routes/terminal.py's _TRANSCRIPT_TAIL_BYTES, kept as our own
# constant so this module has no import-time dependency on routes/.
_TAIL_BYTES = 512 * 1024

_COMPACT_PREFIX = "This session is being continued from a previous conversation"
_MAX_MESSAGE_CHARS = 500
_MAX_MESSAGES = 30

# Don't re-summarize an unchanged-enough transcript more than once a minute --
# the recaps endpoint is polled every few seconds and workers multiply the
# session count, so a naive "summarize on every growth" would spawn a CLI
# process near-continuously.
MIN_INTERVAL_SEC = 60
# On a CLI failure/timeout, don't retry the same session again for a while.
FAILURE_BACKOFF_SEC = 300

_PROMPT_PREAMBLE = (
    "Below is the tail of a coding-assistant terminal session. Summarize in "
    "1-2 sentences (under 220 characters total) what this session is "
    "currently working on, present tense, concrete. Reply with ONLY the "
    "summary sentence(s), no preamble."
)

# --- In-flight / failure bookkeeping (module-level, in-memory) --------------
_lock = threading.Lock()
_in_flight = set()
_MAX_CONCURRENT = 2
_last_failure = {}  # session_id -> epoch float


def _stat_key(path: Path):
    st = path.stat()
    return (st.st_mtime_ns, st.st_size)


def _cache_get(session_id):
    cache = store.read(COLLECTION, {})
    return cache.get(session_id) if isinstance(cache, dict) else None


def get_summary(session_id, transcript_path, builder=None):
    """Return the cached summary text for `session_id` (or None), triggering
    a background refresh if the transcript looks stale enough to be worth
    re-summarizing. Never raises, never blocks on the CLI.

    `builder` turns the file's tail lines into a "User:/Assistant:" dialogue —
    default is the Claude Code transcript parser; routes/observatory.py passes
    `build_bot_dialogue` for its own bot_chats/<conv>.jsonl format."""
    if not session_id:
        return None
    path = Path(transcript_path)
    entry = _cache_get(session_id)
    cached_summary = entry.get("summary") if isinstance(entry, dict) else None

    try:
        key = list(_stat_key(path))
    except OSError:
        # Missing/unreadable transcript: nothing to refresh against, just
        # hand back whatever we already had.
        return cached_summary

    now = time.time()
    stale = entry is None or (
        list(entry.get("key") or []) != key
        and now - float(entry.get("at") or 0) >= MIN_INTERVAL_SEC
    )
    if stale:
        _maybe_refresh(session_id, path, builder)

    return cached_summary


def _maybe_refresh(session_id, path, builder=None):
    last_fail = _last_failure.get(session_id)
    if last_fail is not None and time.time() - last_fail < FAILURE_BACKOFF_SEC:
        return
    with _lock:
        if session_id in _in_flight or len(_in_flight) >= _MAX_CONCURRENT:
            return
        _in_flight.add(session_id)
    _spawn(lambda: _refresh(session_id, path, builder))


def _spawn(fn):
    """Seam for tests: default spawns a daemon thread so callers never block."""
    threading.Thread(target=fn, daemon=True).start()


def _run_claude(prompt):
    """Seam for tests: real implementation shells out to `claude -p`."""
    return subprocess.run(
        [CLAUDE_BIN, "-p", "--model", SUMMARY_MODEL],
        input=prompt, capture_output=True, text=True, timeout=120,
        cwd=str(Path.home()),
    )


def _refresh(session_id, path, builder=None):
    """Runs off the request thread (see _spawn). Builds the dialogue prompt,
    shells out to Haiku, and caches the result. Never raises out of here --
    this runs unsupervised on a daemon thread."""
    try:
        try:
            key = list(_stat_key(path))  # captured BEFORE the CLI call
            lines = _read_tail_lines(path)
        except OSError:
            return
        dialogue = (builder or _build_dialogue)(lines)
        if not dialogue:
            return
        prompt = _PROMPT_PREAMBLE + "\n\n" + dialogue

        try:
            result = _run_claude(prompt)
        except Exception:
            _last_failure[session_id] = time.time()
            return

        if result.returncode != 0 or not (result.stdout or "").strip():
            _last_failure[session_id] = time.time()
            return

        summary = re.sub(r'\s+', ' ', result.stdout.strip()).strip()
        if len(summary) > 260:
            summary = summary[:259].rstrip() + "…"
        if not summary:
            _last_failure[session_id] = time.time()
            return

        _last_failure.pop(session_id, None)
        _store_summary(session_id, summary, key)
    except Exception:
        _last_failure[session_id] = time.time()
    finally:
        with _lock:
            _in_flight.discard(session_id)


def _store_summary(session_id, summary, key):
    with store.mutate(COLLECTION, {}) as cache:
        if not isinstance(cache, dict):
            cache = {}
        cache[session_id] = {"summary": summary, "key": key, "at": int(time.time())}
        if len(cache) > _CACHE_MAX:
            oldest = sorted(cache.items(), key=lambda kv: kv[1].get("at", 0) if isinstance(kv[1], dict) else 0)
            for sid, _ in oldest[: len(cache) - _CACHE_MAX]:
                cache.pop(sid, None)


def _read_tail_lines(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - _TAIL_BYTES))
        tail_text = f.read().decode("utf-8", "replace")
    return tail_text.splitlines()


def _msg_text(msg):
    """Plain text out of a transcript message's content, whether it's a bare
    string or a list of content blocks (mirrors _extract_recap's handling)."""
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [c.get("text", "") for c in content
                 if isinstance(c, dict) and c.get("type") == "text"]
        return "\n".join(t for t in texts if t).strip()
    return ""


def _truncate(text, limit=_MAX_MESSAGE_CHARS):
    text = text.strip()
    if len(text) > limit:
        return text[:limit - 1].rstrip() + "…"
    return text


def _build_dialogue(lines):
    """Parse transcript jsonl lines the same way _extract_recap does (skip
    blanks, non-dict, isSidechain), collecting user/assistant plain-text
    turns into 'User: ...' / 'Assistant: ...' lines. Compaction blobs are
    skipped (huge and redundant), messages are truncated, and only the last
    _MAX_MESSAGES survive."""
    turns = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict) or obj.get("isSidechain"):
            continue
        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        text = _msg_text(msg)
        if not text:
            continue
        if role == "user" and text.startswith(_COMPACT_PREFIX):
            continue
        label = "User" if role == "user" else "Assistant"
        turns.append(f"{label}: {_truncate(text)}")

    return "\n".join(turns[-_MAX_MESSAGES:])


def build_bot_dialogue(lines):
    """Dialogue builder for the observatory's own bot_chats/<conv>.jsonl
    (routes/observatory.py): user turns are {"type":"user","text":...}, assistant
    turns wrap an API-shaped message. Result/gap/system events are plumbing,
    not conversation -- skipped."""
    turns = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        if obj.get("type") == "user":
            text = (obj.get("text") or "").strip()
            if text:
                turns.append(f"User: {_truncate(text)}")
        elif obj.get("type") == "assistant":
            msg = obj.get("message")
            text = _msg_text(msg) if isinstance(msg, dict) else ""
            if text:
                turns.append(f"Assistant: {_truncate(text)}")
    return "\n".join(turns[-_MAX_MESSAGES:])
