#!/bin/bash
# Origin: personal vault scripts/fix_terminal_auth.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# Close an unauthenticated /terminal/ web shell by adding nginx auth_request,
# mirroring what the /files/ block already does. Safe + idempotent: backs up
# the config, inserts one line, tests, reloads — and rolls back if the test
# fails.
#
# Run with: sudo ./scripts/fix_terminal_auth.sh
set -euo pipefail

DOMAIN="${EXOCORTEX_APP_DOMAIN:-}"
CONF="${EXOCORTEX_NGINX_CONF:-/etc/nginx/sites-enabled/exocortex}"
BACKUP="${CONF}.bak-$(date +%Y%m%d-%H%M%S)"

if [ "$(id -u)" -ne 0 ]; then
    echo "Needs root. Run:  sudo $0"
    exit 1
fi

# Already gated? (line present anywhere inside the terminal block)
if grep -Pzo 'location /terminal/ \{[^}]*auth_request' "$CONF" >/dev/null 2>&1; then
    echo "✓ /terminal/ already has auth_request — nothing to do."
    exit 0
fi

echo "Backing up $CONF → $BACKUP"
cp -a "$CONF" "$BACKUP"

# Insert the auth_request line as the first directive inside `location /terminal/ {`.
sed -i '/location \/terminal\/ {/a\        auth_request /api/auth-check;' "$CONF"

echo "Inserted. Testing nginx config..."
if nginx -t 2>&1; then
    systemctl reload nginx
    echo
    echo "✓ Done. /terminal/ now requires a logged-in session."
    echo "  Test it: open an incognito window and visit"
    echo "  https://${DOMAIN:-<your-domain>}/terminal/  — it should NOT give a shell."
    echo
    echo "Next: any typed-password gate in scripts/ttyd_connect.sh is now"
    echo "redundant (nginx handles auth via the web session) — safe to remove it"
    echo "so users aren't prompted for a password every time the terminal loads."
else
    echo "✗ nginx config test FAILED — rolling back, no changes applied."
    cp -a "$BACKUP" "$CONF"
    exit 1
fi
