# Deploying your own Exocortex

A personal life/health dashboard you talk to and shape. This guide is written so an
AI agent (Claude Code) can stand up an instance on a fresh VPS with minimal input from
you — you mostly provide a domain name and change one password.

> **Just want it on your own computer?** Use [INSTALL.md](INSTALL.md) instead — this
> page is for public servers. Note the quick-start below predates the React frontend:
> wherever you land, the frontend needs Node 20+ and `cd frontend && npm install &&
> npm run build` before first run (`install.sh` does all of it).

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
sudo mkdir -p /opt/exocortex/skeleton && cd /opt/exocortex/skeleton
git clone <this-repo-url> .

# 2. Choose where DATA lives — kept separate from code on purpose.
#    Back this directory up; it is the only copy of the user's data.
export EXOCORTEX_DATA_DIR=/var/lib/exocortex-data
sudo mkdir -p "$EXOCORTEX_DATA_DIR"

# 3. Python env + deps
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# 4. First run generates auth.json. Set EXOCORTEX_DEFAULT_PASSWORD before
#    first boot to choose the admin password; if unset, a random one-time
#    password is generated and printed to the server log — grab it from
#    `journalctl -u exocortex` (or stderr) and change it in Settings.

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
WorkingDirectory=/opt/exocortex/skeleton
Environment=EXOCORTEX_DATA_DIR=/var/lib/exocortex-data
Environment=TEMPLATES_AUTO_RELOAD=1
ExecStart=/opt/exocortex/skeleton/venv/bin/gunicorn -k gevent -w 2 \
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
- `scripts/setup-mac-server.sh` — turn a Mac into an always-on, lid-closed server
- `scripts/fix_ttyd.sh`, `scripts/ttyd_connect.sh` — embedded web terminal
- `scripts/setup_ssl.sh` — Let's Encrypt cert via certbot
- `deploy/exocortex-rs.service.template`, `deploy/exo.toml.template`, `deploy/phase1-cutover.md` — optional Rust strangler front server + real multi-user auth

> **`deploy/` and `scripts/` now exist in this repo** — full systemd unit
> templates, the nginx vhost template, and a crontab template live in
> `deploy/` (placeholdered — `<APP_DOMAIN>`, `<APP_USER>`, etc., see
> `deploy/README.md`); the matching shell scripts (backup, ttyd, SSL, VPS
> hardening, Keeper rollover) live in `scripts/` (env-var-overridable, see
> each script's header comment). For the full narrative runbook — the
> two-repo split, env-var wiring, systemd/nginx/DNS ordering, cron, and the
> Claude Code slash-command + journal-capture-hook setup — see
> `docs/SETUP-FULL.md`.
>
> **Do not use `auth_basic`/htpasswd on `/files/` or `/terminal/`, and do not
> deploy either location without `auth_request /api/auth-check;`.** That
> directive — present throughout `deploy/nginx-exocortex.conf.template` — is
> a proper session-based gate: nginx subrequests to the app's own
> `/api/auth-check` route, so only a real logged-in app session reaches
> either location. Swapping it for `auth_basic`, or omitting it, reopens the
> web terminal as an effectively unauthenticated shell. (This is also why
> `setup_nginx.sh`, `setup_codeserver.sh`, and `setup_filebrowser.sh` from
> the vault were deliberately **not** migrated into this repo's `scripts/` —
> they generate exactly that regression; see
> `docs/scrub-log/A-deploy-ops.md`.) Use
> `deploy/nginx-exocortex.conf.template` as the source of truth for nginx
> instead.
