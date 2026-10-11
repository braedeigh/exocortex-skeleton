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

## Running a public-only mirror
Set `EXOCORTEX_PUBLIC_ONLY=1` in the service environment and the instance becomes a
read-only mirror: every request gets the frosted "public" view (`public_config.py`
decides what that shows), `/login` answers 404, and no cookie or proxy header
authenticates. Use it for a second copy of the site on a public host — a portfolio
page, a demo — pointed at a copy of the data, so a stranger's browser never meets a
door into the private instance. Nothing in the app writes in this mode that you'd
want to keep, so the data copy can be overwritten freely (an hourly `git reset
--hard` mirror works). The Observatory and terminal stay unreachable.

The **Terrain map** (`/terrain/files`; the old `/terrain/map` address forwards there) is open to visitors — on the mirror and on
the private site's logged-out view alike. They see every file from both repos
and the session orbs with their titles; what they cannot do is read a personal
file: `/api/observatory/terrain/file` answers `403 {"private": true}` for
anything that isn't git-tracked app code (`routes/terrain.py`,
`_visitor_may_read`). The other Terrain rooms, traces, flow, creek and the
session roster stay 401. Since the same day the map is the ONLY page open to
visitors: `public_config.py` splits what a stranger may reach into the app
shell, `PRESENTABLE_PATHS` (the map) and `_NOT_YET_PRESENTABLE` (the frosted
dashboard, about, kitchen, money … — closed, each line ready to move back up
when the owner calls it presentable). On the mirror `/` lands on the map, full
width. Contract: `tests/test_terrain_public.py`, `tests/test_public_only.py`.

`/terrain/files?embed=1` (or the old `/terrain/map?embed=1`, which forwards) is the map with no chrome — breathing heat, the Open agent
pool, an "Open Terrain ↗" button — made to sit in an `<iframe>` on a portfolio page.
Set `EXOCORTEX_FRAME_ANCESTORS="https://your-site.org https://www.your-site.org"` in
the mirror's service environment: the mirror then answers
`Content-Security-Policy: frame-ancestors <those>` on `/terrain/files`, `/terrain/map` and
`frame-ancestors 'none'` everywhere else. Unset, nothing on the mirror can be framed.

### A live map, without publishing the private box
By default a mirror draws the map from its own copy of the data, so it is only as
fresh as whatever refreshes that copy (an hourly `git reset --hard` means an hourly
map). To make it **live**, push instead: run `scripts/publish_terrain.py` on the
private box and it builds the map there — the same payload that box's own map
draws from — and POSTs it to the mirror's ingest door every ~15s
(`deploy/exocortex-terrain-publish.service.template` is the unit).

Why push rather than exposing the private instance: the connection is outbound
only, so nothing on the internet reaches the machine holding the data, and a
visitor can't read a personal file because the mirror doesn't have one. The
privacy stops being a code path that must hold on every request and becomes a
fact about the mirror's disk. What travels is the map payload and nothing else —
paths, commit times, session ids and titles, run buckets. Never file contents:
the mirror's `/terrain/file` serves out of its own app-code checkout and answers
`private` for everything it doesn't have.

Set up:
1. `EXOCORTEX_TERRAIN_MIRROR_URL=https://<PUBLIC_DOMAIN>` in the publisher's
   environment, and `EXOCORTEX_PUBLIC_ONLY=1` on the mirror (the ingest door
   answers 404 anywhere else, so a leaked secret can't poison a private map).
2. Copy `<DATA_DIR>/terrain_mirror_secret` — 64 hex characters, minted on first
   need, chmod 0600 — from either machine to the other. It authenticates
   `POST /api/observatory/terrain/ingest`, which is exempt from the session gate
   (`public_config.py`) and so checks the secret itself, in constant time.
3. Keep both out of git: the secret and `<DATA_DIR>/terrain_mirror/` (the stored
   map, rewritten every few seconds).

The publisher sends the **uncapped** payload once (~215 KB gzipped) and the mirror
re-cuts it per request with the same ranking the private box uses, so every tier of
the visitor's Files slider is correct from the one artifact. It only pushes when the
map actually changed — `generated_at` is excluded from the comparison — so an idle
afternoon sends nothing. Until the first push the mirror falls back to building a map from whatever data
it has of its own, so a pull-style mirror keeps working exactly as before and a
push-only host simply draws an empty map for its first few seconds. Once a map
has been published it wins, and the map's refresh chip shows how old the PUBLISHED
map is rather than how long ago the browser fetched it, so a stopped publisher is
visible as a number that keeps growing instead of a map pretending to be live.
Contract: `tests/test_terrain_mirror.py`, `tests/test_publish_terrain.py`.

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
