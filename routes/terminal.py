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
import hashlib
import json
import subprocess
import re
import time
import store

TMUX_SESSION = "chat"
DEFAULT_SESSIONS = ["chat", "dev", "other"]
# Sessions where she's actually talking to the Keeper. A send into any other
# tmux session (dev tooling, a scratch shell) is operator noise, not a diary
# entry -- only these get server-side journal capture below.
KEEPER_CAPTURE_SESSIONS = {"chat"}
# How long a ui_captured.jsonl dedup entry stays worth checking against. The
# vault hook only needs it long enough to cover the lag between a server-side
# mint and the hook seeing the same prompt on a still-live tmux process; past
# that it's just dead weight in the file.
UI_CAPTURED_MAX_AGE_SEC = 3600
# sessions.json and notes_dump.md are USER DATA — they must live in the data
# layer (DATA_DIR), not next to the code (BUILD_DIR). Putting them in the code
# dir means every code migration/redeploy orphans or deletes them.
SESSIONS_PATH = DATA_DIR / "sessions.json"
TMUX_SOCKET = "/tmp/tmux-1000/default"
NOTES_PATH = DATA_DIR / "notes_dump.md"

_VALID_SESSION_RE = re.compile(r'^[a-zA-Z0-9_-]{1,30}$')

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


def _scroll_wheel(sess, direction, mode, data):
    """Scroll a full-screen TUI by feeding it mouse-wheel events."""
    up = direction == "up"
    if mode == "lines":
        count = min(data.get("lines", 3), 50)
    elif mode == "end":
        count = 400  # blast to the top/bottom of the app's own scrollback
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
    state_dir = _keeper_state_dir()
    path = state_dir / "ui_captured.jsonl"
    cutoff = time.time() - UI_CAPTURED_MAX_AGE_SEC
    entry = {"ts": time.time(), "sha256": hashlib.sha256(typed.strip().encode()).hexdigest()}
    try:
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
        state_dir.mkdir(parents=True, exist_ok=True)
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


def _capture_journal(body, typed):
    """Mint a B card for one journal turn, at the server, before the text is
    ever typed into tmux -- capture must not depend on a terminal process
    staying alive to see it (the whole reason this exists: the hook's
    process-launch snapshot goes stale and silently stops seeing prompts).

    Only records the ui_captured dedup hash on SUCCESS. If the mint failed
    here, a live hook minting the same text later is the fallback we want --
    marking it "already captured" would make that fallback dedup itself away.
    """
    try:
        result = _run_stream("record", "--who", "B", stdin=body)
    except subprocess.TimeoutExpired as e:
        _log_capture_failure(body, repr(e))
        return False
    except Exception as e:
        _log_capture_failure(body, repr(e))
        return False
    if result.returncode != 0:
        _log_capture_failure(body, (result.stderr or "").strip() or "stream.py record failed")
        return False
    _note_ui_capture(typed)
    return True


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
            if sess in KEEPER_CAPTURE_SESSIONS:
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
                        journaled = _capture_journal(full_body, full_typed)

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
            if key == "Enter" and sess in KEEPER_CAPTURE_SESSIONS:
                # A bare Enter key submits whatever was already pre-typed into
                # the pane (e.g. via the photo-path enter:false send) -- mint
                # it before the Enter reaches tmux, same rationale as above.
                pending_typed, pending_body = _pending_pop(sess)
                if pending_body.strip() and not pending_typed.lstrip().startswith("/"):
                    journaled = _capture_journal(pending_body, pending_typed)
            _tmux(f"send-keys -t {sess} {key}")
            return jsonify({"ok": True, "journaled": journaled})
        return jsonify({"ok": True})

    @app.route("/api/terminal/capture")
    def terminal_capture():
        sess = _get_session()
        start = request.args.get("start", "-5000")
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

    @app.route("/api/sessions")
    def sessions_list():
        return jsonify({"sessions": _load_sessions(), "defaults": DEFAULT_SESSIONS})

    @app.route("/api/sessions", methods=["POST"])
    def sessions_add():
        data = request.json or {}
        name = data.get("name", "").strip().lower()
        if not name or not _VALID_SESSION_RE.match(name):
            return jsonify({"error": "Invalid name. Use letters, numbers, hyphens, underscores (max 30 chars)."}), 400
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
        _tmux(f"kill-session -t {name}")
        return jsonify({"ok": True, "sessions": sessions})

    @app.route("/api/sessions/stream")
    def sessions_stream():
        def generate():
            last_mtime = 0
            while True:
                try:
                    mtime = SESSIONS_PATH.stat().st_mtime
                except FileNotFoundError:
                    mtime = 0
                if mtime != last_mtime:
                    last_mtime = mtime
                    sessions = _load_sessions()
                    data = json.dumps({"sessions": sessions, "defaults": DEFAULT_SESSIONS})
                    yield f"data: {data}\n\n"
                time.sleep(1)
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
