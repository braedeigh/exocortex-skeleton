#!/bin/bash
cat > /etc/systemd/system/ttyd.service << 'EOF'
[Unit]
Description=ttyd - Web Terminal
After=network.target

[Service]
Type=simple
User=bradie
ExecStart=/usr/local/bin/ttyd --port 7681 --writable -a -t fontSize=14 -t reconnect=1 /opt/exocortex/build/ttyd_connect.sh
Restart=always
RestartSec=3
WorkingDirectory=/opt/exocortex
Environment=CLAUDE_SKIP_PERMISSIONS_ALLOWLIST_CHECK=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl restart ttyd
sleep 2
systemctl status ttyd --no-pager
echo "DONE"
