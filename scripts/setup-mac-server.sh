#!/bin/bash
# Origin: personal vault scripts/setup-mac-server.sh. Scrubbed modular copy — plug-in points marked PLUG-IN(...)
#
# setup-mac-server.sh — turn a Mac (e.g. an M1 Air) into an always-on,
# lid-closed Exocortex server you can also open and use as a laptop, and SSH
# into.
#
# Run ON THE MAC, after cloning both repos. Re-running is safe (idempotent).
#   scp this over, then:  bash setup-mac-server.sh
#
# Undo notes are at the bottom.
set -euo pipefail

# --- paths (env-overridable) --------------------------------------------------
APP_USER="${EXOCORTEX_APP_USER:-$(whoami)}"
SKELETON="${EXOCORTEX_SKELETON_DIR:-$HOME/exocortex-skeleton}"
VAULT="${EXOCORTEX_VAULT_DIR:-$HOME/exocortex-vault}"
PORT="${EXOCORTEX_PORT:-5000}"
# PLUG-IN(OWNER_NAME): shown in the app header/footer.
OWNER_NAME="${EXOCORTEX_OWNER_NAME:-Exocortex Owner}"

echo "==> Setting up Exocortex server for user '$APP_USER'"

# --- 1. sanity: repos present ------------------------------------------------
[ -d "$SKELETON" ] || { echo "Missing $SKELETON — clone the skeleton (app code) repo there first."; exit 1; }
[ -d "$VAULT" ]     || { echo "Missing $VAULT — clone your personal/vault repo there first."; exit 1; }

# --- 2. python venv + deps ---------------------------------------------------
if [ ! -x "$SKELETON/venv/bin/gunicorn" ]; then
  echo "==> Creating venv + installing requirements"
  python3 -m venv "$SKELETON/venv"
  "$SKELETON/venv/bin/pip" install --upgrade pip
  "$SKELETON/venv/bin/pip" install -r "$SKELETON/requirements.txt"
else
  echo "==> venv already present, skipping"
fi

# --- 3. LaunchDaemon: start at BOOT, no GUI login needed ----------------------
# (INSTALL.md's mac path uses a LaunchAgent, which only starts after you log
#  in. A Daemon runs headless, which is what an always-on closed-lid server
#  wants.)
PLIST=/Library/LaunchDaemons/com.exocortex.plist
echo "==> Writing $PLIST (needs sudo)"
sudo tee "$PLIST" >/dev/null <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.exocortex</string>
  <key>UserName</key><string>$APP_USER</string>
  <key>WorkingDirectory</key><string>$SKELETON</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SKELETON/venv/bin/gunicorn</string>
    <string>-k</string><string>gevent</string>
    <string>-w</string><string>2</string>
    <string>-b</string><string>127.0.0.1:$PORT</string>
    <string>server:app</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>EXOCORTEX_DATA_DIR</key><string>$VAULT/data</string>
    <key>EXOCORTEX_CONTENT_DIR</key><string>$VAULT/tulku</string>
    <key>EXOCORTEX_OWNER_NAME</key><string>$OWNER_NAME</string>
    <key>EXOCORTEX_APP_NAME</key><string>Exocortex</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/exocortex.log</string>
  <key>StandardErrorPath</key><string>/tmp/exocortex.err</string>
</dict></plist>
PLISTEOF

sudo launchctl bootout system "$PLIST" 2>/dev/null || true
sudo launchctl bootstrap system "$PLIST"
echo "==> Service loaded. Logs: /tmp/exocortex.log  /tmp/exocortex.err"

# --- 4. SSH (Remote Login) so you can drive it from your phone/laptop --------
echo "==> Enabling Remote Login (SSH) — needs sudo"
sudo systemsetup -setremotelogin on || \
  echo "   (If this errored, enable manually: Settings > General > Sharing > Remote Login)"

# --- 5. Stay awake with the lid CLOSED, no external monitor ------------------
# disablesleep 1 is the key: prevents clamshell sleep. KEEP IT ON THE CHARGER.
echo "==> Configuring power: never sleep, awake with lid shut (needs sudo)"
sudo pmset -a disablesleep 1
sudo pmset -c sleep 0 displaysleep 10 powernap 0 disksleep 0
# -c = while on charger. Auto-restart after a power blip:
sudo pmset -a autorestart 1 2>/dev/null || true

# --- 6. smoke test -----------------------------------------------------------
echo "==> Waiting for the server to answer on 127.0.0.1:$PORT ..."
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "    OK — Exocortex is up."
    break
  fi
  sleep 1
  [ "$i" = 15 ] && echo "    Not answering yet — check /tmp/exocortex.err"
done

cat <<DONE

==================== done ====================
Server:   http://127.0.0.1:$PORT   (on this Mac itself)
From your phone/other machine, SSH in:
    ssh $APP_USER@<this-mac-ip>
Find the IP with:  ipconfig getifaddr en0   (or en1 on Wi-Fi)

To reach the dashboard from your phone over the LAN, either:
  - SSH tunnel:   ssh -L $PORT:127.0.0.1:$PORT $APP_USER@<mac-ip>   then open localhost:$PORT
  - or change the daemon bind from 127.0.0.1 to 0.0.0.0 (LAN-exposed; only on trusted Wi-Fi).

You can open the lid and use it as a normal laptop anytime — the server keeps running.
KEEP IT PLUGGED IN (disablesleep drains a battery fast when unplugged).

--- to undo later ---
  sudo launchctl bootout system $PLIST && sudo rm $PLIST   # stop + remove service
  sudo pmset -a disablesleep 0                              # allow normal lid-close sleep
==============================================
DONE
