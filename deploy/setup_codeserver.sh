#!/bin/bash
# Setup code-server behind nginx
# Run as root: sudo bash setup_codeserver.sh

set -e

# 1. Remove old filebrowser service
systemctl stop filebrowser 2>/dev/null || true
systemctl disable filebrowser 2>/dev/null || true
rm -f /etc/systemd/system/filebrowser.service

# 2. Create code-server systemd service
cat > /etc/systemd/system/code-server.service << 'EOF'
[Unit]
Description=code-server — VS Code in the browser
After=network.target

[Service]
Type=simple
User=bradie
ExecStart=/usr/bin/code-server --open /opt/exocortex
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 3. Update nginx — replace /files/ block to proxy to code-server
NGINX_CONF="/etc/nginx/sites-enabled/exocortex"

# Remove old /files/ block if it exists and replace with code-server proxy
python3 -c "
import re
conf = open('$NGINX_CONF').read()
# Remove old /files/ location block
conf = re.sub(r'\n\s*location /files/\s*\{[^}]*\}\n', '\n', conf)
open('$NGINX_CONF', 'w').write(conf)
"

# Add new /files/ block for code-server
sed -i '/location \/terminal\//i \
    location /files/ {\
        auth_basic "Exocortex";\
        auth_basic_user_file /etc/nginx/.htpasswd;\
        proxy_pass http://127.0.0.1:8080/;\
        proxy_set_header Host $host;\
        proxy_set_header X-Real-IP $remote_addr;\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\
        proxy_set_header X-Forwarded-Proto $scheme;\
        proxy_http_version 1.1;\
        proxy_set_header Upgrade $http_upgrade;\
        proxy_set_header Connection "upgrade";\
        proxy_set_header Accept-Encoding gzip;\
    }\
' "$NGINX_CONF"

# 4. Test and reload
nginx -t
systemctl daemon-reload
systemctl enable code-server
systemctl start code-server
systemctl reload nginx

echo ""
echo "code-server is live at https://exocortex.mudscryer.org/files/"
echo "Protected by nginx basic auth"
