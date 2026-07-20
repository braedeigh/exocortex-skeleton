#!/bin/bash
# Origin: personal vault scripts/harden_vps.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# VPS Security Hardening
# Run as root: sudo bash harden_vps.sh
set -e

APP_USER="${EXOCORTEX_APP_USER:-$(whoami)}"
VAULT="${EXOCORTEX_VAULT_DIR:-/opt/exocortex/vault}"
# PLUG-IN(SSH_HOST_HINT): fill in for the printed "test in a new terminal"
# reminder below (your server's IP or hostname).
SSH_HOST_HINT="${EXOCORTEX_SSH_HOST_HINT:-<your-server-ip>}"

echo "=== 1. FIREWALL ==="
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (redirects to HTTPS)
ufw allow 443/tcp   # HTTPS
# Say yes automatically
echo "y" | ufw enable
ufw status
echo "Firewall: DONE — only SSH, HTTP, HTTPS open"

echo ""
echo "=== 2. FIX TTYD BINDING ==="
# ttyd must bind to localhost only — nginx proxies it
TTYD_SERVICE="/etc/systemd/system/ttyd.service"
if [ -f "$TTYD_SERVICE" ]; then
    if grep -q "0.0.0.0" "$TTYD_SERVICE"; then
        sed -i 's/0\.0\.0\.0/127.0.0.1/g' "$TTYD_SERVICE"
        echo "Fixed ttyd to bind 127.0.0.1"
    fi
    systemctl daemon-reload
    systemctl restart ttyd
    echo "ttyd restarted on localhost only"
else
    echo "WARNING: ttyd service file not found at $TTYD_SERVICE"
fi

echo ""
echo "=== 3. FIX FILE PERMISSIONS ==="
chown -R "$APP_USER:$APP_USER" "$VAULT"
chmod 750 "$VAULT"
# Files should be 640, directories 750
find "$VAULT" -type d -exec chmod 750 {} \;
find "$VAULT" -type f -exec chmod 640 {} \;
# Make scripts executable
find "$VAULT" -name "*.sh" -exec chmod 750 {} \;
find "$VAULT" -name "*.py" -exec chmod 750 {} \;
echo "Permissions: DONE — 750 dirs, 640 files, $APP_USER:$APP_USER owned"

echo ""
echo "=== 4. SSH HARDENING ==="
cat > /etc/ssh/sshd_config.d/hardening.conf << SSHEOF
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
AllowUsers root $APP_USER
SSHEOF

APP_USER_HOME="$(eval echo "~$APP_USER")"
mkdir -p "$APP_USER_HOME/.ssh"
chmod 700 "$APP_USER_HOME/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
    cp /root/.ssh/authorized_keys "$APP_USER_HOME/.ssh/authorized_keys"
    chown "$APP_USER:$APP_USER" "$APP_USER_HOME/.ssh/authorized_keys"
    chmod 600 "$APP_USER_HOME/.ssh/authorized_keys"
    echo "Copied root's SSH keys to $APP_USER"
fi
chown "$APP_USER:$APP_USER" "$APP_USER_HOME/.ssh"

echo ""
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "!! IMPORTANT: Before restarting SSH, make sure  !!"
echo "!! you can SSH in with a key. Test in a NEW     !!"
echo "!! terminal: ssh root@$SSH_HOST_HINT             !!"
echo "!! If that works with your key, then run:       !!"
echo "!!   systemctl restart sshd                     !!"
echo "!! If you restart now and have no key, you're   !!"
echo "!! locked out forever.                          !!"
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo ""
echo "SSH config written but NOT restarted yet — do it manually after testing"

echo ""
echo "=== 5. FAIL2BAN ==="
apt-get install -y fail2ban
cat > /etc/fail2ban/jail.local << 'F2BEOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 24h

[nginx-http-auth]
enabled = true
port = http,https
filter = nginx-http-auth
logpath = /var/log/nginx/error.log
maxretry = 5
bantime = 1h
F2BEOF
systemctl enable fail2ban
systemctl restart fail2ban
echo "fail2ban: DONE — SSH (3 tries = 24h ban), nginx auth (5 tries = 1h ban)"

echo ""
echo "=== 6. VERIFY TTYD IS LOCALHOST ONLY ==="
sleep 1
if ss -tlnp | grep 7681 | grep -q "0.0.0.0"; then
    echo "WARNING: ttyd is still on 0.0.0.0! Checking service file..."
    cat "$TTYD_SERVICE" | grep ExecStart
else
    echo "GOOD: ttyd is bound to localhost only"
fi

echo ""
echo "=== SUMMARY ==="
echo "  [x] UFW firewall — only 22, 80, 443 open"
echo "  [x] ttyd — bound to localhost"
echo "  [x] $VAULT — 750/640, owned by $APP_USER:$APP_USER"
echo "  [x] fail2ban — active, protects SSH + nginx auth"
echo "  [ ] SSH — config written, RESTART MANUALLY after key test"
echo ""
echo "NEXT STEPS:"
echo "  1. Test SSH key login in a new terminal"
echo "  2. Run: systemctl restart sshd"
echo "  3. Test SSH again — password should be rejected"
echo "  4. Consider changing any nginx basic-auth password to something strong"
echo "  5. Consider adding rate limiting to nginx"
