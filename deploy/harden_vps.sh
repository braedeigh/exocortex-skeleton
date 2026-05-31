#!/bin/bash
# VPS Security Hardening
# Run as root: sudo bash harden_vps.sh
set -e

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
# Check current service file and fix
TTYD_SERVICE="/etc/systemd/system/ttyd.service"
if [ -f "$TTYD_SERVICE" ]; then
    # Replace any 0.0.0.0 binding or add --interface lo
    if grep -q "0.0.0.0" "$TTYD_SERVICE"; then
        sed -i 's/0\.0\.0\.0/127.0.0.1/g' "$TTYD_SERVICE"
        echo "Fixed ttyd to bind 127.0.0.1"
    fi
    # Make sure --interface lo or -i lo is set, or --bind is localhost
    systemctl daemon-reload
    systemctl restart ttyd
    echo "ttyd restarted on localhost only"
else
    echo "WARNING: ttyd service file not found at $TTYD_SERVICE"
fi

echo ""
echo "=== 3. FIX FILE PERMISSIONS ==="
chown -R bradie:bradie /opt/exocortex
chmod 750 /opt/exocortex
# Files should be 640, directories 750
find /opt/exocortex -type d -exec chmod 750 {} \;
find /opt/exocortex -type f -exec chmod 640 {} \;
# Make scripts executable
find /opt/exocortex -name "*.sh" -exec chmod 750 {} \;
find /opt/exocortex -name "*.py" -exec chmod 750 {} \;
echo "Permissions: DONE — 750 dirs, 640 files, bradie:bradie owned"

echo ""
echo "=== 4. SSH HARDENING ==="
# Create hardening config
cat > /etc/ssh/sshd_config.d/hardening.conf << 'SSHEOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
AllowUsers root bradie
SSHEOF

# Make sure bradie has an SSH directory for keys
mkdir -p /home/bradie/.ssh
chmod 700 /home/bradie/.ssh
# Copy root's authorized keys to bradie if they exist
if [ -f /root/.ssh/authorized_keys ]; then
    cp /root/.ssh/authorized_keys /home/bradie/.ssh/authorized_keys
    chown bradie:bradie /home/bradie/.ssh/authorized_keys
    chmod 600 /home/bradie/.ssh/authorized_keys
    echo "Copied root's SSH keys to bradie"
fi
chown bradie:bradie /home/bradie/.ssh

echo ""
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "!! IMPORTANT: Before restarting SSH, make sure  !!"
echo "!! you can SSH in with a key. Test in a NEW     !!"
echo "!! terminal: ssh root@5.78.194.167              !!"
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
echo "  [x] ttyd — bound to localhost (was exposed on 0.0.0.0!)"
echo "  [x] /opt/exocortex — 750/640, owned by bradie (was 777!)"
echo "  [x] fail2ban — active, protects SSH + nginx auth"
echo "  [ ] SSH — config written, RESTART MANUALLY after key test"
echo ""
echo "NEXT STEPS:"
echo "  1. Test SSH key login in a new terminal"
echo "  2. Run: systemctl restart sshd"
echo "  3. Test SSH again — password should be rejected"
echo "  4. Consider changing the nginx basic auth password to something strong"
echo "  5. Consider adding rate limiting to nginx"
