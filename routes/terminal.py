"""Terminal, sessions, notes, and phone routes."""
from flask import request, jsonify, render_template, Response
from pathlib import Path
from datetime import datetime
from data_helpers import DATA_DIR, UPLOAD_DIR, sweep_uploads
import json
import subprocess
import re
import time

TMUX_SESSION = "chat"
DEFAULT_SESSIONS = ["chat", "dev", "other"]
# sessions.json and notes_dump.md are USER DATA — they must live in the data
# layer (DATA_DIR), not next to the code (BUILD_DIR). Putting them in the code
# dir means every code migration/redeploy orphans or deletes them.
SESSIONS_PATH = DATA_DIR / "sessions.json"
TMUX_SOCKET = "/tmp/tmux-1000/default"
NOTES_PATH = DATA_DIR / "notes_dump.md"

_VALID_SESSION_RE = re.compile(r'^[a-zA-Z0-9_-]{1,30}$')


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
    @app.route("/notes")
    def notes_page():
        return render_template("notes.html")

    @app.route("/api/notes", methods=["GET"])
    def get_notes():
        content = NOTES_PATH.read_text() if NOTES_PATH.exists() else ""
        return jsonify({"content": content})

    @app.route("/api/notes", methods=["POST"])
    def save_notes():
        data = request.json or {}
        NOTES_PATH.write_text(data.get("content", ""))
        return jsonify({"ok": True})

    @app.route("/phone")
    def phone():
        resp = app.make_response(render_template("phone.html"))
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp

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
            prompt_patterns = [
                "? (y/n)", "(Y)es", "(N)o", "Allow?", "Allow ",
                "1: Bad", "2: Fine", "3: Good", "(optional)",
                "? for shortcuts", "(y)es, (n)o", "(a)lways",
            ]
            if any(p.lower() in last_lines.lower() for p in prompt_patterns):
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
