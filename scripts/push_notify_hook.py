#!/usr/bin/env python3
"""Claude Code Stop/Notification hook -> POST /api/push/notify.

Wired into a session's hooks config (Stop + Notification events), this reads
the hook event JSON Claude Code puts on stdin and, for a Stop or a
Notification, tells the exocortex server to push a web notification to any
subscribed phone. stdlib only -- it runs on every stop/notification of every
session, so it must never become a reason to `pip install` anything.

Two guards keep it from being noise:

  - TMUX unset -> exit immediately. Headless `claude -p` runs (dispatchers,
    workers, cricket swarms) have no tmux session to name and nobody staring
    at a phone waiting on them -- a push from one of those is just spam.
  - Every failure path -- bad/missing stdin, no secret file, tmux not
    resolvable, a network error, a non-200 -- exits 0 with no output. A
    notification hook must never block Claude Code or put an error in the
    transcript; the worst outcome of this script misbehaving should be a
    push that silently didn't happen.

Usage (in a session's settings hooks):
    push_notify_hook.py --secret-file /path/to/push_hook_secret
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

DEFAULT_URL = "http://127.0.0.1:5000/api/push/notify"

# hook_event_name -> the "event" push.py expects. Anything else (PreToolUse,
# SessionStart, ...) is simply not a notification-worthy moment.
_EVENT_MAP = {"Stop": "stop", "Notification": "notification"}


def _tmux_session_name() -> str:
    """This pane's tmux session name, or "terminal" if that can't be
    resolved (no TMUX_PANE, tmux not on PATH, pane already gone, ...)."""
    pane = os.environ.get("TMUX_PANE")
    if not pane:
        return "terminal"
    try:
        out = subprocess.run(
            ["tmux", "display-message", "-t", pane, "-p", "#S"],
            capture_output=True, text=True, timeout=3,
        )
        name = out.stdout.strip()
        return name if out.returncode == 0 and name else "terminal"
    except Exception:
        return "terminal"


def main() -> int:
    if not os.environ.get("TMUX"):
        return 0  # headless run -- no one to notify

    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--secret-file", required=True)
    args = parser.parse_args()

    try:
        hook_data = json.load(sys.stdin)
    except Exception:
        return 0

    event = _EVENT_MAP.get(hook_data.get("hook_event_name"))
    if event is None:
        return 0

    try:
        with open(args.secret_file) as f:
            secret = f.read().strip()
    except OSError:
        return 0
    if not secret:
        return 0

    body = {
        "secret": secret,
        "event": event,
        "session": _tmux_session_name(),
    }
    if event == "notification":
        body["body"] = hook_data.get("message") or ""

    try:
        req = urllib.request.Request(
            args.url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import sys as _sys, pathlib as _pathlib
    _sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parents[1]))
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
