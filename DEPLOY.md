# Deploying your own Exocortex

A personal life/health dashboard you talk to and shape. This guide is written so an
AI agent (Claude Code) can stand up an instance on a fresh VPS with minimal input from
you — you mostly provide a domain name and change one password.

> ⚠️ Read `SHARE_TODO.md` first. This repo still contains some of the original author's
> personal assumptions (milestone dates, a hardcoded domain, a dependency on a personal
> "tulku" journal dir). Until those are cleaned up, treat this as a starting template,
> not a finished product.

## What you need
- A VPS running Ubuntu 22.04+ with root/sudo
- (For HTTPS) a domain name with an A record pointed at the VPS IP
- Python 3.11+

## Quick start (an agent can run these in order)

```bash
# 1. Get the code
sudo mkdir -p /opt/exocortex && cd /opt/exocortex
git clone <this-repo-url> .

# 2. Choose where DATA lives — kept separate from code on purpose.
#    Back this directory up; it is the only copy of the user's data.
export EXOCORTEX_DATA_DIR=/var/lib/exocortex-data
sudo mkdir -p "$EXOCORTEX_DATA_DIR"

# 3. Python env + deps
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# 4. First run generates auth.json with the password "exocortex".
#    CHANGE IT immediately in the app's Settings after first login.

# 5. Harden the box: firewall (ufw), fail2ban, SSH key-only login, etc.

# 6. Web server + TLS: put nginx in front as a reverse proxy to 127.0.0.1:5000,
#    then get a cert for your domain:
#      sudo certbot --nginx -d your.domain.com --agree-tos -m you@example.com

# 7. Run as a service (see systemd template below), then:
sudo systemctl enable --now exocortex.service
```

## systemd unit template
Create `/etc/systemd/system/exocortex.service` (adjust paths + data dir):

```ini
[Unit]
Description=Exocortex
After=network.target

[Service]
WorkingDirectory=/opt/exocortex
Environment=EXOCORTEX_DATA_DIR=/var/lib/exocortex-data
Environment=TEMPLATES_AUTO_RELOAD=1
ExecStart=/opt/exocortex/venv/bin/gunicorn -k gevent -w 2 \
  --worker-connections 1000 --timeout 120 \
  --max-requests 1000 --max-requests-jitter 200 \
  -b 127.0.0.1:5000 server:app
Restart=always

[Install]
WantedBy=multi-user.target
```

## How data works
All app data is JSON files under `EXOCORTEX_DATA_DIR`, written atomically through
`store.py` (the single read/write seam). Missing files fall back to sensible defaults,
so the app runs on an empty data dir. Back up that directory (git, rsync, anything).

## Optional extras
- `deploy/setup_codeserver.sh` — browser VS Code
- `deploy/fix_ttyd.sh`, `deploy/ttyd_connect.sh` — embedded web terminal
- `deploy/setup_filebrowser.sh` — file browser
