#!/bin/bash
# Origin: personal vault scripts/fix_ttyd.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# (Re)write and restart ttyd.service from known-good values — useful if the
# live unit has drifted. Prefer applying deploy/ttyd.service.template on a
# fresh machine; use this to repair an existing install in place.
set -e

APP_USER="${EXOCORTEX_APP_USER:-$(whoami)}"
SKELETON="${EXOCORTEX_SKELETON_DIR:-/opt/exocortex/skeleton}"

cat > /etc/systemd/system/ttyd.service << EOF
[Unit]
Description=ttyd - Web Terminal
After=network.target

[Service]
Type=simple
User=$APP_USER
# scrollback=0: tmux owns all scrollback; with 0, xterm.js reserves no
# scrollbar gutter in the grid width and never draws a scrollbar.
ExecStart=/usr/local/bin/ttyd --port 7681 -i lo --writable -a -t fontSize=14 -t reconnect=1 -t scrollback=0 $SKELETON/scripts/ttyd_connect.sh
Restart=always
RestartSec=3
WorkingDirectory=$SKELETON
Environment=CLAUDE_SKIP_PERMISSIONS_ALLOWLIST_CHECK=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl restart ttyd
sleep 2
systemctl status ttyd --no-pager
echo "DONE"
