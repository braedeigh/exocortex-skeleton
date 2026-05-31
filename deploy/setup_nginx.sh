#!/bin/bash
cat > /etc/nginx/sites-available/exocortex << 'CONF'
server {
    listen 80;
    server_name exocortex.mudscryer.org;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /terminal/ {
        proxy_pass http://127.0.0.1:7681/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
CONF
cp /etc/nginx/sites-available/exocortex /etc/nginx/sites-enabled/exocortex
nginx -t && systemctl reload nginx && echo "DONE OK"
