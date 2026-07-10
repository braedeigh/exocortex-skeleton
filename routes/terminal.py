"""Terminal, sessions, and notes-dump API routes.

The legacy /notes scratchpad page and /phone mobile-terminal page were retired
2026-07-09 — both are native SPA routes now (/scratchpad and the Chat tab's
PhoneTerminal; see frontend/MIGRATION_NOTES.md). Their APIs below are unchanged.
"""
from flask import request, jsonify, Response
from pathlib import Path
from datetime import datetime
from data_helpers import DATA_DIR, UPLOAD_DIR, sweep_uploads
import json
import subprocess
import re
import time
import store

TMUX_SESSION = "chat"
DEFAULT_SESSIONS = ["chat", "dev", "other"]
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
            last_lines = _tmux(f"capture-pane -t {sess} -p -S -15").stdout.strip()
            if any(p.lower() in last_lines.lower() for p in _PROMPT_PATTERNS):
                _tmux(f"send-keys -t {sess} Enter")
                time.sleep(0.3)
            if len(text) > 500:
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                dest = UPLOAD_DIR / f"{ts}_paste.txt"
                dest.write_text(text)
                ref = f"[uploaded: {dest}]"
                safe = ref.replace("'", "'\\''")
                _tmux(f"send-keys -t {sess} -l '{safe}'")
                if data.get("enter"):
                    _tmux(f"send-keys -t {sess} Enter")
                return jsonify({"ok": True, "saved_to": str(dest)})
            text = text.replace("'", "'\\''")
            _tmux(f"send-keys -t {sess} -l '{text}'")
            if data.get("enter"):
                _tmux(f"send-keys -t {sess} Enter")
        elif "key" in data:
            # Allowlist: tmux key names only (Enter, Escape, C-c, M-Up, F5, DC…).
            # This string is interpolated into a shell=True command — anything
            # outside [A-Za-z0-9_-] would be a command-injection vector.
            key = str(data["key"])
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,20}", key):
                return jsonify({"error": "invalid key"}), 400
            _tmux(f"send-keys -t {sess} {key}")
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
