#!/bin/bash
# Wait until xterm.js has reported a real terminal size before attaching to tmux
# (ttyd starts at 2x1 before the browser sends dimensions)
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
# Session name from ttyd URL arg, default to "journal"
SESSION="${1:-journal}"
# Only allow alphanumeric, hyphens, underscores (prevent tmux injection)
if ! echo "$SESSION" | grep -qE '^[a-zA-Z0-9_-]{1,30}$'; then
    SESSION="journal"
fi
exec tmux -S /tmp/tmux-1000/default new-session -A -s "$SESSION"
