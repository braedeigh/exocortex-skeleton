#!/bin/bash
# Origin: personal vault scripts/setup_ssl.sh, merged with the near-duplicate
# scripts/setup_ssl2.sh (same certbot call, plus a stuck-registration
# workaround) since they differ only by that one flag. Scrubbed modular copy —
# plug-in points marked PLUG-IN(...)
#
# Get (or renew) a Let's Encrypt cert for the app's nginx vhost via certbot.
# Only run this after DNS for your domain already points at this machine —
# certbot's HTTP-01 challenge needs that to succeed.
#
# Usage:
#   sudo EXOCORTEX_APP_DOMAIN=... EXOCORTEX_OWNER_EMAIL=... ./scripts/setup_ssl.sh
#   sudo EXOCORTEX_APP_DOMAIN=... ./scripts/setup_ssl.sh --no-email
#       (use --no-email if a prior stuck/broken certbot account registration
#       is blocking this — clears /etc/letsencrypt/accounts and registers
#       unsafely-without-email; this was scripts/setup_ssl2.sh in the vault)
set -euo pipefail

# PLUG-IN(APP_DOMAIN): the domain this cert is for.
DOMAIN="${EXOCORTEX_APP_DOMAIN:?set EXOCORTEX_APP_DOMAIN to your domain, e.g. exocortex.example.com}"
# PLUG-IN(OWNER_EMAIL): certbot renewal-expiry notifications go here.
OWNER_EMAIL="${EXOCORTEX_OWNER_EMAIL:-}"

apt-get install -y certbot python3-certbot-nginx

if [ "${1:-}" = "--no-email" ]; then
  rm -rf /etc/letsencrypt/accounts
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email \
    && echo "SSL DONE OK"
else
  : "${OWNER_EMAIL:?set EXOCORTEX_OWNER_EMAIL, or re-run with --no-email}"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$OWNER_EMAIL" \
    && echo "SSL DONE OK"
fi
