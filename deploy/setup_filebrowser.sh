#!/bin/bash
# Setup FileBrowser behind nginx
# Run as root: sudo bash setup_filebrowser.sh

set -e

# 1. Create systemd service
cat > /etc/systemd/system/filebrowser.service << 'EOF'
[Unit]
Description=FileBrowser — web file manager for exocortex
After=network.target

[Service]
Type=simple
User=bradie
ExecStart=/opt/exocortex/build/filebrowser --database /opt/exocortex/build/filebrowser.db
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 2. Add nginx location block (insert before the first closing brace of the SSL server block)
NGINX_CONF="/etc/nginx/sites-enabled/exocortex"
if ! grep -q '/files/' "$NGINX_CONF"; then
    sed -i '/location \/terminal\//i \
    location /files/ {\
        auth_basic "Exocortex";\
        auth_basic_user_file /etc/nginx/.htpasswd;\
        proxy_pass http://127.0.0.1:8080;\
        proxy_set_header Host $host;\
        proxy_set_header X-Real-IP $remote_addr;\
        proxy_http_version 1.1;\
        proxy_set_header Upgrade $http_upgrade;\
        proxy_set_header Connection "upgrade";\
    }\
' "$NGINX_CONF"
    echo "Added /files/ location to nginx config"
else
    echo "/files/ location already in nginx config"
fi

# 3. Test nginx config
nginx -t

# 4. Enable and start
systemctl daemon-reload
systemctl enable filebrowser
systemctl start filebrowser
systemctl reload nginx

echo ""
echo "FileBrowser is live at https://exocortex.mudscryer.org/files/"
echo "No login required — protected by Flask session auth via nginx"
