# deploy/ — reference templates for running Exocortex on your own machine

Origin: personal vault deploy/README.md. Scrubbed modular copy — plug-in
points marked PLUG-IN(...).

Everything in this directory is a **genericized template**, adapted from a
real hourly-backed-up working deployment and scrubbed of every
machine-specific value. Replace every `<PLACEHOLDER>` (domain, app user,
paths) before installing — see the legend below. Companion scripts live in
`../scripts/`; those use env vars with overridable defaults instead of
`<PLACEHOLDER>` tokens, since they're meant to just run.

See `../docs/SETUP-FULL.md` for the full narrative restore runbook. This
README is just "how do I apply each file here."

## Placeholder legend
| Placeholder | What it is | Example |
|---|---|---|
| `<APP_DOMAIN>` | Your domain, DNS-pointed at this machine | `exocortex.example.com` |
| `<APP_USER>` | The unprivileged user the app runs as | `exo` |
| `<OWNER_NAME>` | Display name shown in the app header/footer | `Jordan Rivera` |
| `<OWNER_EMAIL>` | Used for certbot renewal-expiry notices | `you@example.com` |
| `<SKELETON_DIR>` | Where you clone the app code (this repo) | `/opt/exocortex/skeleton` |
| `<VAULT_DIR>` | Where you clone/create your data+content vault | `/opt/exocortex/vault` |
| `<SRV_DIR>` | Data root for the optional Rust front server | `/srv/exocortex` |
| `<TMUX_SOCKET>` | Shared tmux socket path for the web terminal | `/tmp/exocortex-tmux/default` |

## Contents

| File | What it is |
|---|---|
| `exocortex.service.template` | Main Flask/gunicorn app |
| `exocortex-rs.service.template`, `exo.toml.template`, `flask-proxy-secret.conf.template`, `deploy-rust-door.sh`, `phase1-cutover.md` | **Optional** — only needed if you run the Rust strangler front server + real multi-user auth. Flask alone is a complete app without any of these. |
| `ttyd.service.template` | Web terminal (ttyd), binds to loopback only, auth enforced by nginx |
| `exocortex-tmux.service.template` | Owns the persistent tmux socket the web terminal attaches to |
| `exocortex-healthcheck.service.template` + `exocortex-healthcheck.timer.template` | Minutely liveness ping, auto-restarts `exocortex.service` if it stops responding |
| `code-server.service.template` | Browser VS Code, proxied at `/files/` |
| `nginx-exocortex.conf.template` | The nginx vhost: TLS + the `auth_request` gates on `/files/` and `/terminal/` — **read the comment at the top before touching this file** |
| `crontab.template.txt` | Backup + Keeper-journal + research automation cron wiring |

## Applying on a fresh machine

### 0. Fill in placeholders
Pick real values for the table above, then substitute them into every file
below before installing — by hand, or e.g.:
```bash
sed -e 's|<APP_DOMAIN>|exocortex.example.com|g' \
    -e 's|<APP_USER>|exo|g' \
    -e 's|<SKELETON_DIR>|/opt/exocortex/skeleton|g' \
    -e 's|<VAULT_DIR>|/opt/exocortex/vault|g' \
    -e 's|<SRV_DIR>|/srv/exocortex|g' \
    -e 's|<TMUX_SOCKET>|/tmp/exocortex-tmux/default|g' \
    -e 's|<OWNER_NAME>|Your Name|g' \
    file.template > /tmp/rendered-file
```

### systemd units
```bash
# (after rendering — drop the .template suffix on the copies you install)
sudo cp exocortex.service ttyd.service exocortex-tmux.service \
        exocortex-healthcheck.service exocortex-healthcheck.timer \
        code-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now exocortex.service exocortex-tmux.service ttyd.service \
        exocortex-healthcheck.timer code-server.service
```
Order matters a little: `exocortex-tmux.service` should be up before
`ttyd.service` is first used (ttyd just attaches to the socket it owns), but
systemd doesn't need to be told this explicitly — ttyd.service tolerates the
socket not existing yet on first launch as long as `exocortex-tmux.service` is
enabled too.

Do **not** routinely `systemctl restart exocortex-tmux.service` in production
— it kills every live tmux session (Keeper, any dev session, everything) with
no warning. See `../docs/SETUP-FULL.md`.

### nginx + TLS
```bash
sudo cp nginx-exocortex.conf /etc/nginx/sites-available/exocortex   # rendered
sudo ln -s /etc/nginx/sites-available/exocortex /etc/nginx/sites-enabled/exocortex
sudo nginx -t
```
The certbot-managed TLS block (`listen 443 ssl`, `ssl_certificate
.../<APP_DOMAIN>/...`) won't have real certs yet on a fresh machine:
```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <APP_DOMAIN> --agree-tos -m <OWNER_EMAIL>
```
(Only run this after `<APP_DOMAIN>`'s DNS A record points at the new machine's
IP — certbot's HTTP-01 challenge needs that to succeed.) Certbot rewrites the
vhost's SSL block in place, so the exact directives in this file are a
*starting point*, not guaranteed to be byte-identical to what certbot
regenerates.

Reload once the cert is issued and the config test passes:
```bash
sudo systemctl reload nginx
```

**Do not replace `auth_request /api/auth-check;` with `auth_basic`.** See the
comment at the top of `nginx-exocortex.conf.template` — it's the actual
security fix, not decoration.

### crontab
```bash
crontab crontab.txt   # rendered, run as <APP_USER> — not root
```
Every job assumes `<SKELETON_DIR>` / `<VAULT_DIR>` paths and `<APP_USER>`'s
Claude Code binary at `<CLAUDE_BIN>` — adjust if any differ on your machine.

## NOT captured here — needs separate handling

- **`/etc/letsencrypt/`** — the actual certificate/key material and certbot
  account state. Not portable between machines, and TLS certs are
  re-obtainable via certbot on the new machine anyway — see above. Don't try
  to copy this directory; just re-issue.
- **`/etc/sudoers.d/`** — verify by hand (`sudo cat /etc/sudoers.d/*` as root)
  whether your setup needs any NOPASSWD rules before assuming a fresh
  machine's default sudo config is equivalent.
- **`~/.claude/projects/` transcripts** — Claude Code's own conversation
  history for this machine. Not backed up by any cron job here; copy manually
  (`rsync -a ~/.claude/projects/ <new-host>:~/.claude/projects/`) if
  conversation continuity across the move matters to you.
