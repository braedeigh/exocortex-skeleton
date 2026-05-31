#!/bin/bash
apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d exocortex.mudscryer.org --non-interactive --agree-tos -m bradie.lee33@gmail.com && echo "SSL DONE OK"
