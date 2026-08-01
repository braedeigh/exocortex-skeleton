"""Re-authenticate the box's Claude Code login from the PWA.

WHAT THIS IS FOR, in plain English: everything on this box that talks to
Claude — the Observatory's headless turns, the keeper rollover cron, any
terminal session — shares ONE login, the OAuth token in
`~/.claude/.credentials.json`. That token's refresh half expires about every
60 days, and when it does, all of it stops at once, silently. Re-logging in
normally means sitting at the machine: `/login` is an interactive flow that
wants to pop a browser. This box has no browser and the owner is usually on
her phone.

So this module runs that interactive flow FOR her, in a throwaway tmux pane,
and hands the two human-only steps to the PWA:

    1. POST /api/claude-auth/start   — spawn `claude` in a hidden pane, drive
                                       it to the login screen, scrape the
                                       OAuth URL out of the pane
    2. GET  /api/claude-auth/status  — poll; once `state` is "awaiting_code"
                                       the payload carries that `url`
       (she taps the url, authorizes on claude.com, copies the code back)
    3. POST /api/claude-auth/code    — type the code into the pane, press
                                       Enter, confirm the credentials file
                                       actually moved
    4. POST /api/claude-auth/cancel  — kill the pane, forget the attempt

WHY A TMUX PANE AND NOT A PIPE: `/login` is a full-screen TUI. It needs a real
terminal to render into, and it reads single keypresses (the login-method
menu) rather than lines on stdin. A pane is the cheapest real terminal we
have, and routes/terminal.py already owns a tmux socket to borrow.

THE ONE NON-OBVIOUS THING — PANE WIDTH. The OAuth URL is ~450 characters. In a
normal-width pane it soft-wraps, and `capture-pane -J` does NOT reliably
rejoin it, so a naive scrape returns a URL truncated mid-query-string. That
fails authorization later with a useless error. The pane is therefore spawned
at _PANE_COLS (900) so the URL lands on one line and comes out whole. Verified
against the live CLI (v2.1.220) before this file was written; if the URL ever
starts coming back cut short, this constant is the first thing to check.

STATE LIVES IN THE PANE, NOT IN THIS PROCESS. gunicorn runs more than one
worker, so a module-level dict would be invisible to whichever worker answers
the next poll. `_read_state()` derives everything from what the pane is
currently showing, which every worker can see. The only in-process piece is
the short-lived thread /start uses to drive the pane to the URL.

Touches: routes/terminal.py (borrows TMUX_SOCKET), store.py (BUILD_DIR as the
pane's cwd), server.py (registration).
"""
from datetime import datetime
from pathlib import Path
import json
import os
import re
import subprocess
import threading
import time

from flask import jsonify, request

import store
from routes.terminal import TMUX_SOCKET

# The pane this flow owns. Dedicated and disposable: /start always kills any
# previous one, so a half-finished attempt can never be resumed by accident
# into a confusing half-state.
_SESSION = "claude-login"

# Wide enough that the ~450-char OAuth URL never wraps. See the module note.
_PANE_COLS = 900
_PANE_ROWS = 50

# Overridable for tests and for installs where claude isn't on gunicorn's PATH
# — same escape hatch, same env var, as routes/observatory.py's CLAUDE_BIN.
CLAUDE_BIN = os.environ.get("EXOCORTEX_CLAUDE_BIN", "claude")

# Both hostnames are matched because the CLI has moved this endpoint before
# (claude.ai -> claude.com) and a released binary on this box may be either.
# Stopping at whitespace is what makes the wide pane load-bearing: on a wrapped
# URL this would silently return only the first line.
_URL_RE = re.compile(r"https://claude\.(?:com|ai)/[^\s]*oauth/authorize\?[^\s]+")

# Pane markers, matched as plain substrings against the captured text.
_MARK_MENU = "Select login method"
_MARK_PASTE = "Paste code here"
_MARK_SUCCESS = "Login successful"

# What we'll accept as an authorization code. Deliberately loose about the
# alphabet (the CLI's code is opaque and its shape is not ours to assume) and
# strict about what makes typing it into a terminal dangerous — no whitespace,
# no quotes, no control characters.
_CODE_RE = re.compile(r"^[A-Za-z0-9_\-#.=]{10,600}$")

# How long the driver thread will wait for each step before giving up. The
# first launch is the slow one (node startup + the CLI's own update check).
_WAIT_LAUNCH_SEC = 45
_WAIT_URL_SEC = 45
_POLL_SEC = 0.5

# How long /code waits for the credentials file to actually move after the
# code is submitted.
_WAIT_LOGIN_SEC = 60


def _tmux(*args, timeout=10):
    """Run one tmux command against the shared socket. List form, never a
    shell string: an authorization code goes through here and must not be
    parsed by a shell on its way to the pane."""
    return subprocess.run(
        ["tmux", "-S", TMUX_SOCKET, *args],
        capture_output=True, text=True, timeout=timeout,
    )


def _pane_exists():
    return _tmux("has-session", "-t", _SESSION).returncode == 0


def _capture():
    """What the pane is showing right now, wrapped lines joined (-J). Empty
    string when there's no pane."""
    proc = _tmux("capture-pane", "-t", _SESSION, "-p", "-J")
    return proc.stdout if proc.returncode == 0 else ""


def _kill():
    _tmux("kill-session", "-t", _SESSION)


def _credentials_path():
    """The credentials file this box actually uses — CLAUDE_CONFIG_DIR when
    set (that's how the flow was tested without touching the real one),
    otherwise ~/.claude."""
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    root = Path(base) if base else Path.home() / ".claude"
    return root / ".credentials.json"


def _refresh_expiry():
    """When the refresh token dies, as a unix timestamp — or None if the file
    is missing/unreadable//shaped differently than expected. This is the number
    that matters: the access token beside it rotates on its own, but once THIS
    passes, every Claude call on the box fails until someone logs in again.

    Never raises. A missing credentials file is a legitimate state here (a
    fresh install, or an expired login already cleaned up), not an error."""
    try:
        raw = json.loads(_credentials_path().read_text())
    except (OSError, ValueError):
        return None
    oauth = raw.get("claudeAiOauth") if isinstance(raw, dict) else None
    if not isinstance(oauth, dict):
        return None
    ts = oauth.get("refreshTokenExpiresAt")
    if not isinstance(ts, (int, float)):
        return None
    return ts / 1000.0        # the CLI stores milliseconds


def _expiry_payload():
    """The 'how much runway is left' half of every status response."""
    expiry = _refresh_expiry()
    if expiry is None:
        return {"expires_at": None, "days_left": None}
    return {
        "expires_at": datetime.fromtimestamp(expiry).isoformat(timespec="seconds"),
        "days_left": round((expiry - time.time()) / 86400, 1),
    }


def _read_state():
    """Derive the flow's state from the pane alone, so any gunicorn worker
    gives the same answer. Returns (state, url).

    Order matters: the paste prompt and the URL coexist on screen once the
    flow is ready, and a finished login leaves the success line behind, so the
    most-advanced marker is checked first."""
    if not _pane_exists():
        return "idle", None
    text = _capture()
    if _MARK_SUCCESS in text:
        return "done", None
    match = _URL_RE.search(text)
    if match and _MARK_PASTE in text:
        return "awaiting_code", match.group(0)
    if match:
        return "awaiting_code", match.group(0)
    if _MARK_MENU in text:
        return "starting", None
    return "starting", None


def _wait_for(predicate, limit):
    """Poll the pane until `predicate(text)` is true or `limit` seconds pass.
    Returns the matching text, or None on timeout."""
    deadline = time.time() + limit
    while time.time() < deadline:
        text = _capture()
        if predicate(text):
            return text
        time.sleep(_POLL_SEC)
    return None


def _drive():
    """Walk a freshly-spawned pane from launch to the printed OAuth URL.

    Two branches, because the starting screen depends on whether the existing
    token is merely stale or fully gone: an expired login drops straight into
    the login-method menu, while a still-valid one comes up at the normal
    prompt and needs `/login` typed. Sending `/login` at the menu would type
    junk into a keypress-driven UI, so the menu is checked for first.

    Runs in a thread so /start can answer immediately; the browser learns how
    it went by polling /status. Every step is best-effort — a timeout just
    leaves the pane where it stalled, which /status reports honestly rather
    than pretending."""
    ready = _wait_for(
        lambda t: _MARK_MENU in t or "│" in t or ">" in t, _WAIT_LAUNCH_SEC)
    if ready is None:
        return
    if _MARK_MENU not in ready:
        _tmux("send-keys", "-t", _SESSION, "-l", "/login")
        _tmux("send-keys", "-t", _SESSION, "Enter")
        if _wait_for(lambda t: _MARK_MENU in t, _WAIT_URL_SEC) is None:
            return
    # Option 1 (subscription account) is where the cursor already sits, so the
    # menu takes a bare Enter. An install that bills through Console would
    # need a different keypress — out of scope until someone runs one.
    _tmux("send-keys", "-t", _SESSION, "Enter")
    _wait_for(lambda t: _URL_RE.search(t), _WAIT_URL_SEC)


def register(app):

    @app.route("/api/claude-auth/status")
    def claude_auth_status():
        """Where the flow stands, plus how much runway the current token has.

        Safe to poll: it only reads the pane and the credentials file, and
        never advances the flow or touches the login."""
        state, url = _read_state()
        return jsonify({"state": state, "url": url, **_expiry_payload()})

    @app.route("/api/claude-auth/start", methods=["POST"])
    def claude_auth_start():
        """Begin a login. Kills any previous attempt first — two of these
        panes racing would both hold half a flow and neither would finish.

        Returns as soon as the pane is up; the URL arrives via /status a few
        seconds later, because the CLI's own startup dominates the wait."""
        _kill()
        cwd = str(store.BUILD_DIR)
        proc = _tmux(
            "new-session", "-d", "-s", _SESSION,
            "-x", str(_PANE_COLS), "-y", str(_PANE_ROWS),
            "-c", cwd, CLAUDE_BIN,
        )
        if proc.returncode != 0:
            return jsonify({"error": (proc.stderr or "could not start tmux").strip()}), 500
        threading.Thread(target=_drive, daemon=True).start()
        return jsonify({"ok": True, "state": "starting"})

    @app.route("/api/claude-auth/code", methods=["POST"])
    def claude_auth_code():
        """Submit the authorization code she copied from claude.com.

        Success is confirmed against the CREDENTIALS FILE, not against
        anything the pane prints: the file moving forward is the only evidence
        that the box can actually make a Claude call again. The code itself is
        never logged, echoed back, or written anywhere."""
        if not _pane_exists():
            return jsonify({"error": "no login in progress"}), 409
        code = (request.get_json(silent=True) or {}).get("code", "")
        code = str(code).strip()
        if not _CODE_RE.match(code):
            return jsonify({"error": "that doesn't look like an authorization code"}), 400

        before = _refresh_expiry()
        _tmux("send-keys", "-t", _SESSION, "-l", code)
        _tmux("send-keys", "-t", _SESSION, "Enter")

        deadline = time.time() + _WAIT_LOGIN_SEC
        while time.time() < deadline:
            after = _refresh_expiry()
            if after is not None and (before is None or after > before):
                _kill()          # the pane has done its job
                return jsonify({"ok": True, "state": "done", **_expiry_payload()})
            time.sleep(_POLL_SEC)

        # Nothing moved. The pane is deliberately LEFT ALIVE so she can retry
        # the paste (a mistyped code is the common case) instead of starting
        # the whole flow over for a typo.
        return jsonify({
            "error": "the code didn't take — check you copied all of it, then try again",
            "state": "awaiting_code",
        }), 400

    @app.route("/api/claude-auth/cancel", methods=["POST"])
    def claude_auth_cancel():
        """Abandon the attempt and drop the pane. Nothing to roll back — the
        login isn't written until the code is exchanged."""
        _kill()
        return jsonify({"ok": True, "state": "idle"})
