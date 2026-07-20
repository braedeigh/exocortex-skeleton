#!/bin/bash
# Origin: personal vault scripts/ttyd_connect.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Wait until xterm.js has reported a real terminal size before attaching to
# tmux (ttyd starts at 2x1 before the browser sends dimensions).
set -u

# PLUG-IN(TMUX_SOCKET): must match the socket exocortex-tmux.service (or
# whatever owns your tmux server) creates.
TMUX_SOCK="${EXOCORTEX_TMUX_SOCKET:-/tmp/exocortex-tmux/default}"
SKELETON="${EXOCORTEX_SKELETON_DIR:-/opt/exocortex/skeleton}"

for i in $(seq 1 20); do
    COLS=$(tput cols 2>/dev/null || echo 0)
    [ "$COLS" -ge 20 ] && break
    sleep 0.25
done
# If we never got a real size, bail out instead of attaching a tiny client
COLS=$(tput cols 2>/dev/null || echo 0)
if [ "$COLS" -lt 20 ]; then
    echo "Terminal too small ($COLS cols), not attaching."
    exit 1
fi
# Session name from ttyd URL arg, default to "chat"
# (Auth lives in nginx: /terminal/ has `auth_request /api/auth-check;`,
# so only a logged-in session can reach ttyd at all.)
SESSION="${1:-chat}"
# Only allow alphanumeric, hyphens, underscores (prevent tmux injection)
if ! echo "$SESSION" | grep -qE '^[a-zA-Z0-9_-]{1,30}$'; then
    SESSION="chat"
fi
# PLUG-IN(WORKER_SESSION_PREFIX): if you run a dispatcher that mints
# machine-managed worker tmux sessions, list its name prefix here so a stray
# ttyd attach can't accidentally create a squatter session under that name
# (the dispatcher would then count the squatter as a live worker).
WORKER_PREFIX="${EXOCORTEX_WORKER_SESSION_PREFIX:-rw-}"
if [[ "$SESSION" == "$WORKER_PREFIX"* ]]; then
    # '=' forces an exact tmux session match; without it tmux prefix-matches,
    # and e.g. "rw-x-1" would grab "rw-x-10".
    if ! tmux -S "$TMUX_SOCK" has-session -t "=$SESSION" 2>/dev/null; then
        echo "Worker '$SESSION' isn't running (finished or not started yet)."
        exit 0
    fi
    exec tmux -S "$TMUX_SOCK" attach-session -t "=$SESSION"
fi
exec tmux -S "$TMUX_SOCK" new-session -A -s "$SESSION" -c "$SKELETON"
