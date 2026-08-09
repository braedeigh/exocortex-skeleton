"""Terminal, sessions, and notes-dump API routes.

The legacy /notes scratchpad page and /phone mobile-terminal page were retired
2026-07-09 — both are native SPA routes now (/scratchpad and the Chat tab's
PhoneTerminal; see frontend/MIGRATION_NOTES.md). Their APIs below are unchanged.
"""
from flask import request, jsonify, Response
from pathlib import Path
from datetime import datetime
from data_helpers import DATA_DIR, UPLOAD_DIR, sweep_uploads
from routes.cards import _run_stream
import fcntl
import hashlib
import json
import subprocess
import re
import time
import store
import features
import recap_summary

TMUX_SESSION = "chat"
# Protected sessions: no × button in the UI, DELETE refused. Only chat — it's
# where the Keeper lives. dev/other are ordinary closable sessions (2026-07-14).
DEFAULT_SESSIONS = ["chat"]
# Sessions where she's actually talking to the Keeper. A send into any other
# tmux session (dev tooling, a scratch shell) is operator noise, not a diary
# entry -- only these get server-side journal capture below.
KEEPER_CAPTURE_SESSIONS = {"chat"}
# Second capture door, added 2026-07-20: a thread terminal (spawned by
# /api/thread/talk in routes/threads.py, tmux session named `thread-<slug>`,
# possibly with a `-2`/`-3` retry suffix) is also a real journal conversation --
# her turns there get minted as B cards born tagged with the thread's slug, so
# they land in both the daily journal and that thread's own inbox. Membership
# here is name-shaped, not a fixed set like KEEPER_CAPTURE_SESSIONS, since new
# thread sessions spawn dynamically -- see _is_thread_session/_thread_tag_for_session.
_THREAD_SESSION_RE = re.compile(r'^thread-(.+)$')
# _talk_session_name (routes/threads.py) appends -2/-3/... when the base
# `thread-<slug>` tmux name is already taken -- strip it off to recover the slug.
_THREAD_RETRY_SUFFIX_RE = re.compile(r'-\d+$')
# How long a ui_captured.jsonl dedup entry stays worth checking against. The
# vault hook only needs it long enough to cover the lag between a server-side
# mint and the hook seeing the same prompt on a still-live tmux process; past
# that it's just dead weight in the file.
UI_CAPTURED_MAX_AGE_SEC = 3600
# How long an off_record.jsonl suppression entry stays honored. Much longer than
# the ui_captured window because it guards two doors with very different
# clocks: the hook fires within seconds, but the reconciler is a cron tail that
# only sees the line whenever it next runs -- if cron were paused for an
# afternoon, a short window would let a suppressed prompt through the moment it
# resumed. A day is long enough that no plausible outage outlives it.
OFF_RECORD_MAX_AGE_SEC = 24 * 3600
# sessions.json and notes_dump.md are USER DATA — they must live in the data
# layer (DATA_DIR), not next to the code (BUILD_DIR). Putting them in the code
# dir means every code migration/redeploy orphans or deletes them.
SESSIONS_PATH = DATA_DIR / "sessions.json"
TMUX_SOCKET = "/tmp/tmux-1000/default"
NOTES_PATH = DATA_DIR / "notes_dump.md"

_VALID_SESSION_RE = re.compile(r'^[a-zA-Z0-9_-]{1,30}$')

# --- Session recaps (/api/terminal/recaps) -----------------------------------
# Card data for the /sessions full-page switcher: each tmux session's "latest
# recap" is pulled from the Claude Code transcript of whatever claude process
# is running inside that pane. As of the recap_summary.py module, the card
# prefers a real 1-2 sentence Haiku-generated summary (cached, refreshed in
# the background as the transcript grows) and falls back to the raw
# last-assistant-output recap below when no summary is available yet. Two
# Claude-owned files are involved, and BOTH are undocumented internals that
# can change shape between Claude Code releases — which is why every parse
# failure below degrades to an `error` string the card displays, never a
# silent blank:
#   ~/.claude/sessions/<pid>.json   live-process registry (pid, sessionId,
#                                   cwd, status) — maps a pane to a transcript
#   ~/.claude/projects/<cwd-flattened>/<sessionId>.jsonl   the transcript
CLAUDE_HOME = Path.home() / ".claude"
RECAP_MAX_CHARS = 280
# Compaction recaps are huge; the tail window just has to be big enough that
# the last assistant message or compact summary is inside it.
_TRANSCRIPT_TAIL_BYTES = 512 * 1024
_COMPACT_PREFIX = "This session is being continued from a previous conversation"
_ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]')
_RECAP_FORMAT_ERROR = ("Claude is running but no recap could be read from its "
                      "transcript — Claude Code's file format may have changed.")


def _proc_ancestors(pid):
    """pid plus all its ancestors, via /proc — used to answer 'is this claude
    process running inside that tmux pane'."""
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
    """Entries from Claude Code's live-process registry whose pid is still
    alive. Unreadable/stale entries are skipped, but a missing or empty
    registry dir is fine (no claude running anywhere)."""
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


def _transcript_path(cwd, session_id):
    flat = re.sub(r'[^A-Za-z0-9]', '-', cwd or '')
    return CLAUDE_HOME / "projects" / flat / f"{session_id}.jsonl"


def _extract_recap(lines):
    """The freshest recap in a transcript tail: the LAST of either an
    assistant text message or a compaction summary ("This session is being
    continued…" user message) — whichever appears later in the file wins,
    so a compact recap is only shown until the assistant next speaks.
    Returns (text, source) with source 'assistant' | 'compact', or (None, None)."""
    last_text, source = None, None
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
        content = msg.get("content")
        if msg.get("role") == "assistant" and isinstance(content, list):
            texts = [c.get("text", "") for c in content
                     if isinstance(c, dict) and c.get("type") == "text"]
            text = "\n".join(t for t in texts if t).strip()
            if text:
                last_text, source = text, "assistant"
        elif msg.get("role") == "user":
            text = content if isinstance(content, str) else next(
                (c.get("text", "") for c in content
                 if isinstance(c, dict) and c.get("type") == "text"),
                "") if isinstance(content, list) else ""
            if isinstance(text, str) and text.startswith(_COMPACT_PREFIX):
                last_text, source = text, "compact"
    return last_text, source


def _clean_recap(text, source):
    """One-line card description: drop the compact recap's boilerplate
    preamble, collapse whitespace, truncate."""
    if source == "compact":
        idx = text.find("Summary:")
        if idx != -1:
            text = text[idx + len("Summary:"):]
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) > RECAP_MAX_CHARS:
        text = text[:RECAP_MAX_CHARS - 1].rstrip() + "…"
    return text


# Parsed-recap cache, keyed by transcript path: only re-read + re-parse a
# transcript whose (mtime, size) changed since last poll — the recaps
# endpoint polls every few seconds and workers multiply the session count,
# so unchanged transcripts must be free.
_recap_cache = {}
_RECAP_CACHE_MAX = 64


def _transcript_recap(path):
    """(text, source, mtime_epoch) for a transcript, via the cache above."""
    st = path.stat()
    key = (st.st_mtime_ns, st.st_size)
    cached = _recap_cache.get(str(path))
    if cached and cached[0] == key:
        return cached[1], cached[2], int(st.st_mtime)
    with open(path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - _TRANSCRIPT_TAIL_BYTES))
        tail_text = f.read().decode("utf-8", "replace")
    text, source = _extract_recap(tail_text.splitlines())
    if len(_recap_cache) >= _RECAP_CACHE_MAX:
        _recap_cache.clear()   # dumb but bounded; refills on the next poll
    _recap_cache[str(path)] = (key, text, source)
    return text, source, int(st.st_mtime)


def _session_recap(sess, live, worker=False):
    """Card entry for one tmux session. Never raises: anything unexpected
    lands in `error` so the card can say the recap degraded instead of
    silently showing nothing."""
    entry = {"recap": None, "source": None, "status": None, "error": None,
             "updatedAt": None, "needsInput": False, "worker": worker}
    try:
        panes = _tmux(f"list-panes -t {sess} -F '#{{pane_pid}}'").stdout.strip()
        if not panes:
            # Listed in sessions.json but never attached — ttyd only creates
            # the tmux session on first open. Not an error, just not started.
            entry["status"] = "not-running"
            return entry
        pane_pid = int(panes.splitlines()[0])

        # Same waiting-on-you heuristic as /api/terminal/needs-input, folded
        # in here so the /sessions page needs only this one poller.
        pane_tail = _tmux(f"capture-pane -t {sess} -p -S -15").stdout
        entry["needsInput"] = any(p.lower() in pane_tail.lower() for p in _PROMPT_PATTERNS)

        claude = None
        for info in live:
            if pane_pid in _proc_ancestors(info["pid"]):
                if claude is None or info.get("updatedAt", 0) > claude.get("updatedAt", 0):
                    claude = info
        if claude is None:
            # Plain shell (no claude inside): last non-blank pane lines.
            tail = [ln for ln in (_ANSI_RE.sub('', l).strip() for l in pane_tail.splitlines()) if ln]
            entry["recap"] = _clean_recap(" · ".join(tail[-3:]), "pane") if tail else None
            entry["source"] = "pane"
            return entry

        entry["status"] = claude.get("status")
        path = _transcript_path(claude.get("cwd"), claude.get("sessionId"))
        if not path.exists():
            entry["error"] = _RECAP_FORMAT_ERROR
            return entry
        text, source, mtime = _transcript_recap(path)
        if not text:
            entry["error"] = _RECAP_FORMAT_ERROR
            return entry
        entry["recap"] = _clean_recap(text, source)
        entry["source"] = source
        entry["updatedAt"] = mtime
        # Prefer the Haiku-generated summary when one's cached; this also
        # kicks off a background refresh if the transcript has grown. Falls
        # back to the last-output recap above (updatedAt is set either way).
        summary = recap_summary.get_summary(claude.get("sessionId"), path)
        if summary:
            entry["recap"] = summary
            entry["source"] = "summary"
        return entry
    except Exception as e:
        entry["error"] = f"Recap unavailable: {e}"
        return entry


# Machine-managed worker sessions (rw-*): the dispatcher creates them running
# claude and they self-destruct when done (see ttyd_connect.sh, which only
# ever attaches to them). They're not in sessions.json — listed straight from
# tmux, behind a tiny TTL cache because the SSE stream polls every second.
_WORKERS_TTL_SEC = 2.0
_workers_cache = {"at": 0.0, "names": []}


def _live_workers():
    now = time.monotonic()
    if now - _workers_cache["at"] > _WORKERS_TTL_SEC:
        out = _tmux("list-sessions -F '#{session_name}'").stdout
        _workers_cache["names"] = sorted(n for n in out.split() if n.startswith("rw-"))
        _workers_cache["at"] = now
    return _workers_cache["names"]


def _load_titles():
    """User-set display titles per session (session_titles.json via store.py);
    cards fall back to the capitalized session name when unset."""
    titles = store.read("session_titles", {})
    return titles if isinstance(titles, dict) else {}


# How often the sessions SSE loop wakes, and how long it may stay silent before
# writing a comment frame just to prove the socket is still there. See
# sessions_stream() below for what each one is fixing.
_STREAM_TICK_SEC = 1.0
_STREAM_HEARTBEAT_SEC = 20.0


def _mtime(path):
    """A file's mtime, or 0.0 when it isn't there. A missing file is a stable
    state, not an error — it has to compare equal to itself tick after tick."""
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _sessions_signature():
    """Has anything the sessions payload shows actually changed?

    Two stat() calls and the already-TTL-cached worker list. What matters is
    what this does NOT do: it never opens or parses either file. The SSE loop
    runs it once a second for every connected client, and *building the payload
    to find out whether it changed* is what turned an idle stream into millions
    of disk reads a day.

    Deliberately mtime rather than content: a rewrite with identical bytes now
    re-emits one redundant frame, which costs nothing, and in exchange the
    check never has to read the file it's checking.
    """
    return (_mtime(SESSIONS_PATH), _mtime(store.file_path("session_titles")),
            tuple(_live_workers()))

# Shared with terminal_send()'s "accept the confirmation prompt before typing"
# logic below, and with /api/terminal/needs-input (which tints a background
# session's tab so it's not silently waiting forever off-screen).
_PROMPT_PATTERNS = [
    "? (y/n)", "(Y)es", "(N)o", "Allow?", "Allow ",
    "1: Bad", "2: Fine", "3: Good", "(optional)",
    "? for shortcuts", "(y)es, (n)o", "(a)lways",
]

# --- Scheduled prompts ("timers for starting code in the terminal") ---------
# Jobs live in scheduled_prompts.json (via store.py, so writes are atomic and
# concurrency-safe). A standalone script, scripts/prompt_dispatcher.py, is
# meant to be cron'd every minute to actually fire due jobs — these routes
# only manage the queue (add/list/cancel).
_SCHEDULE_SESSION_RE = re.compile(r'^[a-z0-9-]{1,30}$')
_SCHEDULE_AT_FORMAT = "%Y-%m-%d %H:%M"


def _new_schedule_id(jobs):
    """Legible timestamp id (mirrors routes/research.py's _new_entry_id):
    'YYYY-MM-DD.HHMM', with a '-2', '-3', ... suffix on same-minute collisions."""
    base = datetime.now().strftime("%Y-%m-%d.%H%M")
    taken = {j["id"] for j in jobs if isinstance(j, dict) and j.get("id")}
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


def _load_sessions():
    try:
        return json.loads(SESSIONS_PATH.read_text())
    except Exception:
        return list(DEFAULT_SESSIONS)


def _save_sessions(sessions):
    SESSIONS_PATH.write_text(json.dumps(sessions, indent=2) + "\n")


def _get_session(data=None):
    sessions = _load_sessions()
    if data and isinstance(data, dict) and data.get("session") in sessions:
        return data["session"]
    qs = request.args.get("session")
    if qs in sessions:
        return qs
    return TMUX_SESSION


def _tmux(cmd_str):
    cmd = f"tmux -S {TMUX_SOCKET} {cmd_str}"
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=5)


def _pane_owns_mouse(sess):
    """True if the foreground app has mouse tracking on (full-screen TUI like
    Claude, vim, less). Such apps keep their own scrollback and respond to wheel
    events; tmux copy-mode can't scroll them (alt-screen panes hold no tmux
    history). A plain shell returns False -> use copy-mode scrollback instead."""
    return _tmux(f"display-message -t {sess} -p '#{{mouse_any_flag}}'").stdout.strip() == "1"


def _wheel_hex(up, count, col=2, row=2):
    """Hex bytes for `count` SGR mouse-wheel events, for `send-keys -H`.
    SGR encoding: ESC [ < 64 ; col ; row M = wheel up, 65 = wheel down."""
    btn = 64 if up else 65
    seq = f"\033[<{btn};{col};{row}M" * count
    return " ".join(f"{b:02x}" for b in seq.encode())


# Jump-to-end batches: how many wheel events per burst, and how many bursts
# before giving up. 12 * 200 = 2400 events max — the cap only matters when the
# pane keeps repainting on its own (e.g. Claude mid-generation).
_WHEEL_END_BURST = 200
_WHEEL_END_MAX_BURSTS = 12


def _scroll_wheel(sess, direction, mode, data):
    """Scroll a full-screen TUI by feeding it mouse-wheel events."""
    up = direction == "up"
    if mode == "lines":
        count = min(data.get("lines", 3), 50)
    elif mode == "end":
        # "Jump to end" must actually land at the end, not step partway: a
        # fixed burst count undershoots deep scrollback ("the bottom button
        # just jumps down bit by bit", dev note f5c7f249). The app owns its
        # scrollback and tmux can't ask it "are you at the bottom?", so feed
        # bursts and watch the pane: when a burst no longer changes what's
        # painted, we've hit the edge.
        prev = None
        for _ in range(_WHEEL_END_MAX_BURSTS):
            _tmux(f"send-keys -t {sess} -H {_wheel_hex(up, _WHEEL_END_BURST)}")
            time.sleep(0.05)
            painted = _tmux(f"capture-pane -t {sess} -p").stdout
            if painted == prev:
                break
            prev = painted
        return
    else:  # page
        count = 12
    _tmux(f"send-keys -t {sess} -H {_wheel_hex(up, count)}")


def _scroll_copy_mode(sess, direction, mode, data):
    """Scroll a plain shell through tmux copy-mode scrollback."""
    # "Jump to bottom" = get back to the LIVE tail: cancel copy-mode outright
    # (history-bottom would park at the end but stay frozen in copy-mode).
    if mode == "end" and direction == "down":
        _tmux(f"send-keys -t {sess} -X cancel")
        return
    # Scrolling must use copy-mode *commands* (`-X scroll-up`/`page-up`), NOT raw
    # keys: a raw Up/PageUp only moves the copy cursor and won't touch scrollback
    # until it reaches the top row. Enter with `-e` so scrolling back down to the
    # bottom auto-exits copy-mode and returns to the live view.
    _tmux(f"copy-mode -e -t {sess}")
    if mode == "end":  # up = top of history
        _tmux(f"send-keys -t {sess} -X history-top")
    elif mode == "lines":
        lines = min(data.get("lines", 5), 50)
        cmd = "scroll-up" if direction == "up" else "scroll-down"
        _tmux(f"send-keys -t {sess} -X -N {lines} {cmd}")
    else:
        cmd = "page-up" if direction == "up" else "page-down"
        _tmux(f"send-keys -t {sess} -X {cmd}")


def _keeper_state_dir():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are
    # honored (same rationale as routes/cards.py's _content_dir()).
    return store.CONTENT_DIR / ".keeper"


def _note_ui_capture(typed):
    """Leave a breadcrumb that the server already minted this exact prompt, so
    the vault's UserPromptSubmit hook -- which may still fire on the same text
    if its tmux process happens to be alive -- can dedup against it instead of
    double-minting. Hashes the STRIPPED string because that's what the hook
    receives (Claude Code strips the prompt before the hook ever sees it).

    Best-effort only: this is an optimization, not the capture itself (that
    already succeeded by the time this runs), so any OSError here is
    swallowed rather than surfaced.
    """
    _note_hash(typed, "ui_captured.jsonl", UI_CAPTURED_MAX_AGE_SEC)


def _note_off_record(typed):
    """Leave a breadcrumb that this exact prompt was sent OFF THE RECORD, so
    the two fallback capture doors -- the vault's UserPromptSubmit hook and the
    cron'd transcript reconciler -- refuse to mint it.

    Why this file has to exist: the off-record switch only ever silenced the
    server's own mint. But the model still receives the text, so it lands in
    Claude Code's transcript like any other prompt, and both fallback doors read
    that transcript in a journaling session and mint whatever the pool is
    missing. They were doing exactly their job -- restoring a card the server
    "lost" -- which is why off-the-record turns kept reappearing in the journal.
    A skipped mint and a failed mint look identical from those doors; this file
    is what tells them apart.

    Unlike the ui_captured breadcrumb, entries here are NOT consumed on a hit:
    both doors have to be able to refuse the same prompt independently, and
    whichever ran first would otherwise eat the other one's answer. Age is what
    retires an entry instead (OFF_RECORD_MAX_AGE_SEC).
    """
    _note_hash(typed, "off_record.jsonl", OFF_RECORD_MAX_AGE_SEC)


def _note_hash(typed, filename, max_age_sec):
    """Append {ts, sha256} to a `.keeper/` sidecar, pruning entries older than
    max_age_sec on the way through. Hashes the STRIPPED string because that's
    what the readers see (Claude Code strips a prompt before the hook gets it,
    and the reconciler strips the transcript's copy).

    Best-effort: every caller here is annotating something that already
    happened, so an OSError is swallowed rather than surfaced.
    """
    state_dir = _keeper_state_dir()
    path = state_dir / filename
    cutoff = time.time() - max_age_sec
    entry = {"ts": time.time(), "sha256": hashlib.sha256(typed.strip().encode()).hexdigest()}
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        # flock against the readers (keeper_capture.py holds the same lock):
        # ui_captured is read-modify-written on both sides, and an unlocked
        # interleaving can drop an entry (worst case: one duplicate card).
        with open(path.with_suffix(".lock"), "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            kept = []
            if path.exists():
                for line in path.read_text().splitlines():
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue  # unparseable line -- drop it rather than carry it forward
                    if rec.get("ts", 0) >= cutoff:
                        kept.append(rec)
            kept.append(entry)
            path.write_text("".join(json.dumps(r) + "\n" for r in kept))
    except OSError:
        pass


def _log_capture_failure(body, error):
    """A capture failure must never vanish silently -- append to the same
    durable sidecar the vault hook writes to (capture-failures.jsonl), so a
    lost journal turn always leaves a trace even when nothing was watching.
    Best-effort: logging the failure must never itself raise and take down
    the request that's already failing to journal.
    """
    try:
        state_dir = _keeper_state_dir()
        state_dir.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "error": error,
            "prompt": body,
            "source": "terminal_send",
        }
        with (state_dir / "capture-failures.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _is_thread_session(sess):
    return bool(_THREAD_SESSION_RE.match(sess))


def _thread_file_exists(slug):
    return (store.CONTENT_DIR / "Threads" / f"{slug}.md").exists()


def _thread_tag_for_session(sess):
    """The tag to mint a thread session's B cards with, or None if it can't be
    resolved -- capture never depends on this resolving; the caller mints
    untagged rather than losing the turn (capture-first).

    Try the tmux name's remainder (after `thread-`) as the slug first -- the
    common case, no retry suffix. If Threads/<remainder>.md doesn't exist,
    strip a trailing `-<digit>` retry suffix (_talk_session_name appends one
    when the base name's tmux session was already taken) and try again. A hand-
    typed alias or a truncated name that resolves neither way mints untagged."""
    m = _THREAD_SESSION_RE.match(sess)
    if not m:
        return None
    remainder = m.group(1)
    if _thread_file_exists(remainder):
        return remainder
    stripped = _THREAD_RETRY_SUFFIX_RE.sub('', remainder)
    if stripped != remainder and _thread_file_exists(stripped):
        return stripped
    return None


def _capture_journal(body, typed, tags=None, who="B", session=None, reply_to=None):
    """Mint a card for one journal turn, at the server, before the text is
    ever typed into tmux -- capture must not depend on a terminal process
    staying alive to see it (the whole reason this exists: the hook's
    process-launch snapshot goes stale and silently stops seeing prompts).

    `who` is the card's speaker: "B" (hers, the default) or "K" (the keeper's
    voice -- the bot surface's tap-a-reply-into-the-journal door).

    `tags`, when given, is a single thread slug (from _thread_tag_for_session)
    passed through as `--tags <slug>` so the card is born tagged -- mirroring
    keeper_capture.py/reconcile_transcripts.py's thread-mode minting, at the
    server door instead of the hook/reconciler ones.

    `session` stamps the card with the observatory conversation it was pulled
    out of, and `reply_to` hangs it under another card. Both are for the
    highlight-a-span door in observatory.py: the quote card carries the session,
    and her annotation is a B card replying to the quote.

    RETURNS THE MINTED CARD ID (a truthy string) or None -- the highlight door
    needs the id to hang her annotation off the quote card. Truthiness is the
    same as the old True/False, so `if not _capture_journal(...)` still reads
    correctly -- but ANY CALLER THAT PASSES THE RESULT ON must wrap it in
    bool(): the terminal send route and the observatory send route both put a
    `journaled` field on the wire, and that contract is a yes/no, not an id.

    Only records the ui_captured dedup hash on SUCCESS. If the mint failed
    here, a live hook minting the same text later is the fallback we want --
    marking it "already captured" would make that fallback dedup itself away.
    """
    args = ["record", "--who", who]
    if tags:
        args += ["--tags", tags]
    if session:
        args += ["--session", session]
    if reply_to:
        args += ["--reply-to", reply_to]
    try:
        result = _run_stream(*args, stdin=body)
    except subprocess.TimeoutExpired as e:
        _log_capture_failure(body, repr(e))
        return None
    except Exception as e:
        _log_capture_failure(body, repr(e))
        return None
    if result.returncode != 0:
        _log_capture_failure(body, (result.stderr or "").strip() or "stream.py record failed")
        return None
    if who == "B":
        # The hook-dedup hash is keyed to her typed prompts; a keeper card
        # has no hook fallback to dedup against.
        _note_ui_capture(typed)
    # stream.py echoes the new id as its last stdout line -- same contract
    # routes/cards.py reads. A mint that somehow printed nothing still counts
    # as captured, so fall back to a truthy sentinel rather than reporting
    # failure for a card that exists.
    lines = [ln.strip() for ln in (result.stdout or "").splitlines() if ln.strip()]
    return lines[-1] if lines else "?"


def _pending_accumulate(sess, typed_now, body_now):
    """Stash text sent with enter:false onto a session's pending entry. The
    Chat tab pre-types photo-path text this way before the caption send
    submits the whole pane -- persisted through the atomic store layer
    (not a module global) because gunicorn runs multiple workers, and
    concatenated with no separator so it mirrors exactly what lands in the
    pane."""
    with store.mutate("terminal_pending.json", {}) as data:
        entry = data.setdefault(sess, {"typed": "", "body": ""})
        entry["typed"] += typed_now
        entry["body"] += body_now


def _pending_pop(sess):
    """Pop and clear a session's accumulated pending text. Called the moment
    the pane actually submits (an Enter, from either the text or key send
    path) -- the pending entry is cleared either way, since the pane content
    was submitted regardless of whether it ends up minted."""
    with store.mutate("terminal_pending.json", {}) as data:
        entry = data.pop(sess, None) or {"typed": "", "body": ""}
    return entry.get("typed", ""), entry.get("body", "")


def register(app):
    # web_terminal feature flag (features.py): when off, the remote-shell API
    # below is inert — one 404 gate instead of code removal, so a deployment
    # can run without a browser-reachable shell while the code stays stock.
    # Everything else in this module (sessions, schedule, notes, recaps,
    # upload, needs-input) stays available either way.
    _SHELL_PREFIXES = ("/api/terminal/send", "/api/terminal/capture",
                       "/api/terminal/scroll", "/api/terminal/refresh",
                       "/api/terminal/session")

    @app.before_request
    def _web_terminal_gate():
        from flask import request as _rq
        if _rq.path.startswith(_SHELL_PREFIXES) and not features.enabled("web_terminal"):
            return jsonify({"error": "web terminal disabled on this install"}), 404

    @app.route("/api/notes", methods=["GET"])
    def get_notes():
        content = NOTES_PATH.read_text() if NOTES_PATH.exists() else ""
        return jsonify({"content": content})

    @app.route("/api/notes", methods=["POST"])
    def save_notes():
        data = request.json or {}
        NOTES_PATH.write_text(data.get("content", ""))
        return jsonify({"ok": True})

    @app.route("/api/terminal/send", methods=["POST"])
    def terminal_send():
        data = request.json or {}
        sess = _get_session(data)
        mode = _tmux(f"display-message -t {sess} -p '#{{pane_in_mode}}'")
        if mode.stdout.strip() == "1":
            _tmux(f"send-keys -t {sess} q")
        if "text" in data:
            text = data["text"]
            enter = bool(data.get("enter"))

            # Hoisted above any tmux call: doesn't depend on the pane, and the
            # journal capture below needs typed_now/body_now either way.
            saved_to = None
            if len(text) > 500:
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                dest = UPLOAD_DIR / f"{ts}_paste.txt"
                dest.write_text(text)
                saved_to = str(dest)
                # What actually lands in the pane is just the ref, not the full
                # paste -- but the journal card should carry her full text.
                typed_now = f"[uploaded: {dest}]"
                body_now = text
            else:
                typed_now = body_now = text

            # Capture BEFORE anything is typed into tmux: the card is minted
            # here, at the server, so the journal turn can never be lost to a
            # dead/stale terminal process (see module docstring background).
            journaled = False
            is_thread = _is_thread_session(sess)
            if sess in KEEPER_CAPTURE_SESSIONS or is_thread:
                if not enter:
                    # Pre-typed text (e.g. a photo-path ref) waiting on the
                    # caption send that will actually submit the pane.
                    _pending_accumulate(sess, typed_now, body_now)
                else:
                    pending_typed, pending_body = _pending_pop(sess)
                    full_typed = pending_typed + typed_now
                    full_body = pending_body + body_now
                    # Slash commands are operator control, not journal content;
                    # an empty body is nothing to mint.
                    if full_body.strip() and not full_typed.lstrip().startswith("/"):
                        tag = _thread_tag_for_session(sess) if is_thread else None
                        # bool(), because _capture_journal answers with the card
                        # id it minted (the highlight door needs it) and this
                        # value goes out over the wire as `journaled` — a
                        # yes/no, not an id.
                        journaled = bool(_capture_journal(full_body, full_typed, tags=tag))

            last_lines = _tmux(f"capture-pane -t {sess} -p -S -15").stdout.strip()
            if any(p.lower() in last_lines.lower() for p in _PROMPT_PATTERNS):
                _tmux(f"send-keys -t {sess} Enter")
                time.sleep(0.3)
            safe = typed_now.replace("'", "'\\''")
            _tmux(f"send-keys -t {sess} -l '{safe}'")
            if enter:
                _tmux(f"send-keys -t {sess} Enter")
            if saved_to is not None:
                return jsonify({"ok": True, "saved_to": saved_to, "journaled": journaled})
            return jsonify({"ok": True, "journaled": journaled})
        elif "key" in data:
            # Allowlist: tmux key names only (Enter, Escape, C-c, M-Up, F5, DC…).
            # This string is interpolated into a shell=True command — anything
            # outside [A-Za-z0-9_-] would be a command-injection vector.
            key = str(data["key"])
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,20}", key):
                return jsonify({"error": "invalid key"}), 400
            journaled = False
            is_thread = _is_thread_session(sess)
            if key == "Enter" and (sess in KEEPER_CAPTURE_SESSIONS or is_thread):
                # A bare Enter key submits whatever was already pre-typed into
                # the pane (e.g. via the photo-path enter:false send) -- mint
                # it before the Enter reaches tmux, same rationale as above.
                pending_typed, pending_body = _pending_pop(sess)
                if pending_body.strip() and not pending_typed.lstrip().startswith("/"):
                    tag = _thread_tag_for_session(sess) if is_thread else None
                    journaled = bool(_capture_journal(pending_body, pending_typed, tags=tag))
            _tmux(f"send-keys -t {sess} {key}")
            return jsonify({"ok": True, "journaled": journaled})
        return jsonify({"ok": True})

    @app.route("/api/terminal/capture")
    def terminal_capture():
        sess = _get_session()
        # `start` is a tmux scrollback line offset (default -5000). It's
        # interpolated into a shell=True command, so — like `key` above — it
        # must be allowlisted: an optional leading '-' and digits only, or
        # anything outside that is a command-injection vector.
        start = request.args.get("start", "-5000")
        if not re.fullmatch(r"-?\d{1,7}", start):
            return jsonify({"error": "invalid start"}), 400
        result = _tmux(f"capture-pane -t {sess} -p -S {start}")
        return jsonify({"text": result.stdout})

    @app.route("/api/terminal/scroll", methods=["POST"])
    def terminal_scroll():
        data = request.json or {}
        sess = _get_session(data)
        direction = data.get("direction", "up")
        mode = data.get("mode", "page")
        # Full-screen TUIs (Claude, vim, less) own the mouse and their own
        # scrollback — feed them wheel events. Plain shells scroll via tmux
        # copy-mode. Picking the wrong one is why scroll looked broken: every
        # session here runs Claude, so copy-mode had nothing to scroll.
        if _pane_owns_mouse(sess):
            _scroll_wheel(sess, direction, mode, data)
        else:
            _scroll_copy_mode(sess, direction, mode, data)
        return jsonify({"ok": True})

    @app.route("/api/terminal/refresh", methods=["POST"])
    def terminal_refresh():
        data = request.json or {}
        sess = _get_session(data)
        _tmux(f"refresh-client -t {sess}")
        return jsonify({"ok": True})

    @app.route("/api/terminal/schedule")
    def terminal_schedule_list():
        data = store.read("scheduled_prompts.json", {"jobs": []})
        jobs = sorted(
            (j for j in data.get("jobs", []) if isinstance(j, dict)),
            key=lambda j: j.get("id", ""),
            reverse=True,
        )
        return jsonify({"jobs": jobs})

    @app.route("/api/terminal/schedule/add", methods=["POST"])
    def terminal_schedule_add():
        body = request.json or {}
        session = str(body.get("session", "")).strip().lower()
        prompt = str(body.get("prompt", "")).strip()
        at_raw = str(body.get("at", "")).strip()
        if not _SCHEDULE_SESSION_RE.match(session):
            return jsonify({"error": "Invalid session name. Use lowercase letters, numbers, hyphens (max 30 chars)."}), 400
        if not prompt:
            return jsonify({"error": "Prompt cannot be empty."}), 400
        try:
            at_dt = datetime.strptime(at_raw, _SCHEDULE_AT_FORMAT)
        except ValueError:
            return jsonify({"error": "Invalid date/time. Use YYYY-MM-DD HH:MM."}), 400
        if at_dt <= datetime.now():
            return jsonify({"error": "Scheduled time must be in the future."}), 400
        with store.mutate("scheduled_prompts.json", {"jobs": []}) as data:
            jobs = data.setdefault("jobs", [])
            job = {
                "id": _new_schedule_id(jobs),
                "session": session,
                "prompt": prompt,
                "at": at_dt.strftime(_SCHEDULE_AT_FORMAT),
                "status": "pending",
                "created": datetime.now().strftime(_SCHEDULE_AT_FORMAT),
                "sent_at": None,
            }
            jobs.append(job)
        return jsonify({"ok": True, "job": job})

    @app.route("/api/terminal/schedule/cancel", methods=["POST"])
    def terminal_schedule_cancel():
        body = request.json or {}
        jid = body.get("id")
        with store.mutate("scheduled_prompts.json", {"jobs": []}) as data:
            job = next((j for j in data.get("jobs", []) if j.get("id") == jid), None)
            if not job:
                return jsonify({"error": "not found"}), 404
            if job.get("status") != "pending":
                return jsonify({"error": "job is not pending"}), 400
            job["status"] = "cancelled"
        return jsonify({"ok": True, "job": job})

    @app.route("/api/terminal/session", methods=["POST"])
    def terminal_session():
        global TMUX_SESSION
        data = request.json or {}
        session_name = data.get("session", "chat")
        sessions = _load_sessions()
        if session_name in sessions:
            TMUX_SESSION = session_name
        return jsonify({"ok": True, "session": TMUX_SESSION})

    @app.route("/api/terminal/session")
    def terminal_session_get():
        return jsonify({"session": TMUX_SESSION})

    def _sessions_payload():
        return {"sessions": _load_sessions(), "defaults": DEFAULT_SESSIONS,
                "workers": _live_workers(), "titles": _load_titles()}

    @app.route("/api/sessions")
    def sessions_list():
        return jsonify(_sessions_payload())

    @app.route("/api/sessions", methods=["POST"])
    def sessions_add():
        data = request.json or {}
        name = data.get("name", "").strip().lower()
        if not name or not _VALID_SESSION_RE.match(name):
            return jsonify({"error": "Invalid name. Use letters, numbers, hyphens, underscores (max 30 chars)."}), 400
        if name.startswith("rw-"):
            # Reserved for dispatcher workers — a user session squatting an
            # rw-* name is exactly the failure ttyd_connect.sh guards against.
            return jsonify({"error": "Names starting with rw- are reserved for workers."}), 400
        sessions = _load_sessions()
        if name in sessions:
            return jsonify({"error": "Session already exists."}), 409
        sessions.append(name)
        _save_sessions(sessions)
        return jsonify({"ok": True, "sessions": sessions})

    @app.route("/api/sessions", methods=["DELETE"])
    def sessions_remove():
        data = request.json or {}
        name = data.get("name", "").strip().lower()
        if name in DEFAULT_SESSIONS:
            return jsonify({"error": "Cannot delete default session."}), 400
        sessions = _load_sessions()
        if name not in sessions:
            return jsonify({"error": "Session not found."}), 404
        sessions.remove(name)
        _save_sessions(sessions)
        titles = _load_titles()
        if name in titles:
            del titles[name]
            store.write("session_titles", titles)
        _tmux(f"kill-session -t {name}")
        return jsonify({"ok": True, "sessions": sessions})

    @app.route("/api/sessions/title", methods=["POST"])
    def sessions_set_title():
        """Set (or clear, with an empty title) a session's display title —
        shown on the /sessions cards and the mobile Chat tab instead of the
        raw tmux name."""
        data = request.json or {}
        name = (data.get("name") or "").strip().lower()
        title = (data.get("title") or "").strip()[:40]
        if name not in _load_sessions() and name not in _live_workers():
            return jsonify({"error": "Session not found."}), 404
        titles = _load_titles()
        if title:
            titles[name] = title
        else:
            titles.pop(name, None)
        store.write("session_titles", titles)
        return jsonify({"ok": True, "titles": titles})

    @app.route("/api/sessions/stream")
    def sessions_stream():
        """Push the session list to the UI, and cost almost nothing while idle.

        Two faults used to compound here, and together they made this the
        single largest source of traffic through the data layer:

        1. THE PAYLOAD WAS REBUILT EVERY TICK just to decide whether anything
           had changed — including a full read-and-parse of session_titles.json
           through the store — and then thrown away, because it usually hadn't.
           The old loop even stat()'d the sessions file and then read it anyway;
           the mtime only ever landed in the comparison, never gated the work.
           The decision now comes from _sessions_signature() (two stat calls),
           and the payload is built only when it genuinely changed.

        2. THE LOOP COULD NEVER NOTICE ITS CLIENT WAS GONE. SSE discovers a
           closed socket only by WRITING to it, and this generator wrote only
           on a change — so a closed browser tab left it spinning forever, at a
           disk read per second, reaped only when gunicorn recycled the worker.
           The heartbeat is a comment frame: EventSource ignores it entirely
           (onmessage never fires, see shell/useSessions.ts), and its whole job
           is to be a write that fails once nobody is listening.

        Prompt that produced it: "fix the leak — the sessions stream rebuilds
        its payload every second and never reaps dead clients."
        """
        def generate():
            last_sig = None
            last_write = time.monotonic()
            while True:
                sig = _sessions_signature()
                if sig != last_sig:
                    last_sig = sig
                    last_write = time.monotonic()
                    yield f"data: {json.dumps(_sessions_payload())}\n\n"
                elif time.monotonic() - last_write >= _STREAM_HEARTBEAT_SEC:
                    last_write = time.monotonic()
                    yield ": ping\n\n"
                time.sleep(_STREAM_TICK_SEC)
        return Response(generate(), mimetype='text/event-stream',
                        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    @app.route("/api/terminal/needs-input")
    def terminal_needs_input():
        """Per-session 'is something waiting on you' flag, for tinting a
        background session's tab. Reuses the same _PROMPT_PATTERNS heuristic
        terminal_send() already checks before typing into a session — cheap
        (just a capture-pane), no new tmux state to maintain, and it clears
        itself on the next poll once the prompt scrolls off (e.g. because
        terminal_send() auto-accepted it when a message was sent)."""
        sessions = _load_sessions()
        result = {}
        for s in sessions:
            text = _tmux(f"capture-pane -t {s} -p -S -15").stdout.lower()
            result[s] = any(p.lower() in text for p in _PROMPT_PATTERNS)
        return jsonify({"sessions": result})

    @app.route("/api/terminal/recaps")
    def terminal_recaps():
        """Per-session card data for the /sessions page: latest recap (from
        the pane's Claude Code transcript, or the pane itself for plain
        shells), the claude process's busy/idle status, transcript freshness,
        the needs-input flag, and an error string when the transcript
        couldn't be parsed (see the recap helpers above). Live rw-* worker
        sessions are included alongside the sessions.json ones, flagged
        worker: true (read-only cards — attach-only, no × / no create)."""
        live = _live_claude_sessions()
        out = {s: _session_recap(s, live) for s in _load_sessions()}
        for w in _live_workers():
            if w not in out:
                out[w] = _session_recap(w, live, worker=True)
        return jsonify({"sessions": out})

    @app.route("/api/terminal/upload", methods=["POST"])
    def terminal_upload():
        sweep_uploads()   # uploads are transient: anything older than 24h goes
        files = [f for f in request.files.getlist("photo") if f and f.filename]
        if not files:
            return jsonify({"error": "no file"}), 400
        paths = []
        for f in files:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            original = Path(f.filename)
            ext = original.suffix or ""
            safe_stem = original.stem.replace(" ", "_").replace("/", "_")[:60]
            dest = UPLOAD_DIR / f"{ts}_{safe_stem}{ext}"
            f.save(dest)
            paths.append(str(dest))
        # `path` kept for the split.html uploader, which reads the single-file key.
        return jsonify({"paths": paths, "path": paths[0]})
