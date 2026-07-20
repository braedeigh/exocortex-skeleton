#!/bin/bash
# Origin: personal vault mailclaude/install.sh. Scrubbed modular copy —
# plug-in points marked PLUG-IN(...)
#
# mail-claude install — run as root on the target host, from this staging
# folder:
#   sudo ./install.sh
# Idempotent: safe to re-run after edits. Does NOT touch sshd_config,
# Tailscale, ufw, or Claude auth — those are manual steps in your own
# deployment runbook (see README.md's "Remaining manual steps" below).
set -euo pipefail
cd "$(dirname "$0")"

# PLUG-IN(SRV_DIR): base install directory. Override with MAILCLAUDE_BASE if
# you relocate the tree — you must then also update the systemd units
# (systemd/*.service, systemd/*.path) and clerk/.claude/settings.json, which
# hardcode this path in their sandbox rules.
BASE="${MAILCLAUDE_BASE:-/srv/mailclaude}"

# PLUG-IN(APP_USER): the Linux user who owns the corpus (the knowledge base
# the clerk answers from) and the clerk workspace. This is normally whoever
# operates the bot day to day. Override with MAILCLAUDE_APP_USER; defaults to
# the user who invoked sudo, falling back to the current user.
APP_USER="${MAILCLAUDE_APP_USER:-${SUDO_USER:-$(id -un)}}"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

# --- users & groups ---------------------------------------------------------
getent group mailroom >/dev/null || groupadd mailroom
getent passwd mail >/dev/null || useradd -m -s /bin/bash -G mailroom mail
getent passwd mailer >/dev/null || useradd -m -s /usr/sbin/nologin -G mailroom mailer
usermod -aG mailroom mail
usermod -aG mailroom mailer
passwd -l mail >/dev/null
passwd -l mailer >/dev/null

# --- directory tree ---------------------------------------------------------
mkdir -p "$BASE"/{corpus,clerk/.claude,data/{inbox,drafts,sent,failed},bin,secrets}

# corpus: APP_USER writes, mailroom reads
chown -R "$APP_USER":mailroom "$BASE/corpus"
find "$BASE/corpus" -type d -exec chmod 2750 {} +
find "$BASE/corpus" -type f -exec chmod 640 {} +

# clerk: APP_USER-owned, world-readable (mail runs claude here)
chown -R "$APP_USER":"$APP_USER" "$BASE/clerk"
chmod 755 "$BASE/clerk" "$BASE/clerk/.claude"

# data: mailroom-shared, setgid so new files inherit the group
chown -R mail:mailroom "$BASE/data"
find "$BASE/data" -type d -exec chmod 2770 {} +
find "$BASE/data" -type f -exec chmod 660 {} +

# secrets: mailer only
chown -R mailer:mailer "$BASE/secrets"
chmod 700 "$BASE/secrets"

chown "$APP_USER":mailroom "$BASE"
chmod 755 "$BASE"

# --- files ------------------------------------------------------------------
install -o "$APP_USER" -g mailroom -m 750 bin/session.sh bin/poll-mail.py \
    bin/draft-runner.sh bin/send-to-owner.py "$BASE/bin/"
install -o "$APP_USER" -g "$APP_USER" -m 644 clerk/CLAUDE.md "$BASE/clerk/"
install -o "$APP_USER" -g "$APP_USER" -m 644 clerk/.claude/settings.json "$BASE/clerk/.claude/"

for t in secrets/*.example; do
    dest="$BASE/secrets/$(basename "$t" .example)"
    [[ -e "$dest" ]] || install -o mailer -g mailer -m 600 "$t" "$dest"
done
chmod 700 "$BASE/secrets"; chmod 600 "$BASE"/secrets/*.json

install -m 644 systemd/* /etc/systemd/system/
systemctl daemon-reload

cat <<EOF

Installed. Remaining manual steps (see README.md and your own deployment
runbook for host-specific detail):
  1. Edit $BASE/secrets/{imap,smtp}.json (currently the templates).
  2. Add a \`Match User mail\` ForceCommand block to /etc/ssh/sshd_config
     pointing at $BASE/bin/session.sh, set PasswordAuthentication no, then:
     systemctl restart ssh
  3. Lock down network access to SSH (e.g. VPN/allowlist + firewall).
  4. As mail: log in to Claude Code (shared auth), then run claude once
     interactively in $BASE/clerk and ACCEPT THE TRUST DIALOG —
     allow rules are ignored until the workspace is trusted. Verify with
     /permissions that the sandbox matches clerk/.claude/settings.json.
  5. Put first files in $BASE/corpus/ (as $APP_USER).
  6. systemctl enable --now mail-poll.timer mail-draft.path mail-send.timer
  7. Run your own hardening checklist before adding group members' keys to
     /home/mail/.ssh/authorized_keys.
EOF
