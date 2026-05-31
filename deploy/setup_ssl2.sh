#!/bin/bash
rm -rf /etc/letsencrypt/accounts
certbot --nginx -d exocortex.mudscryer.org --non-interactive --agree-tos -m bradie.lee33@gmail.com --register-unsafely-without-email && echo "SSL DONE OK"
