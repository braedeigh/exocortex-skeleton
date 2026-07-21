# SETUP-FULL — rebuild Exocortex on a new machine

Origin: personal vault RESTORE.md. Scrubbed modular copy — plug-in points
marked PLUG-IN(...).

This is the full, narrative restore runbook — the two-repo architecture, the
systemd/nginx/cron infrastructure, and the Claude Code wiring (slash commands,
the journal capture hook) all in one place. For the shorter paths, prefer:

- **Local/laptop, no domain, no systemd** → [INSTALL.md](../INSTALL.md).
- **A Mac (Apple Silicon), incl. always-on via launchd + Tailscale** → [SETUP-MACOS.md](SETUP-MACOS.md).
- **Public server with a domain, agent-driven quick start** → [DEPLOY.md](../DEPLOY.md).

This document is for when you want the *complete* picture — a VPS or a
headless Mac, running unattended, with backup, the web terminal, and the
journal automation all wired up — and it goes into more depth than either of
those on the parts that are easy to get subtly wrong: the two-repo data
split, the systemd/nginx/DNS ordering, and the Claude Code capture hook.

Two repos, two remotes:
- **`<SKELETON_DIR>`** — the code/engine (this repo — generic, no personal
  data). Remote: `origin` → your skeleton fork/clone.
- **`<VAULT_DIR>`** — your data, content, and (optionally) deploy snapshots.
  Remote: `origin` → your own private vault repo. **Never mix code into
  this repo or data into the skeleton repo** — see this repo's `CLAUDE.md`.

The exact deploy artifacts (nginx vhost, systemd units, crontab) referenced
throughout this doc are template versions in `../deploy/` in *this* repo —
see `../deploy/README.md` for how to apply each one. This file is the
narrative; `../deploy/` is the fill-in-the-placeholders source of truth for
exact file contents.

---

## 1. Clone your repos

```bash
sudo mkdir -p /opt/exocortex && cd /opt/exocortex
git clone <your-skeleton-repo-url> skeleton
git clone <your-vault-repo-url> vault
sudo chown -R <APP_USER>:<APP_USER> /opt/exocortex
```

**Optional v2 cutover** — if you build the Rust strangler front server
(exocortex-rs): nginx fronts it (Axum on `127.0.0.1:8100`, unit
`deploy/exocortex-rs.service.template`, config `deploy/exo.toml.template`),
which reverse-proxies everything unported to Flask on `:5000`. Build it with
`~/.cargo/bin/cargo build --release -p exo-cli` (Rust via rustup). Flask's
`ProxyFix` needs `x_for=2` for the two proxy hops if you run this. Skip this
whole paragraph and the rest of the "optional" callouts below if you're
running Flask alone — it's a complete app without exocortex-rs.

The paths `<SKELETON_DIR>` and `<VAULT_DIR>` are load-bearing — every systemd
unit, cron job, and script in `deploy/`/`scripts/` uses them (as literal
`<PLACEHOLDER>` tokens in templates, or as env vars with these same defaults
in `.sh` scripts). Render/set them consistently across every file, or things
silently point at the wrong place.

**Phase 1 (real auth)**, optional and only relevant with exocortex-rs: adds
`<SRV_DIR>` as its data root (`data_root` in `exo.toml`): `system.db`
(accounts, sessions) at the top level, `proxy_secret` (the HMAC secret Flask
uses to trust the identity header from exocortex-rs — see
`deploy/flask-proxy-secret.conf.template`), and one dir per user under
`users/`, e.g. `users/<APP_USER>/exo.db` plus `users/<APP_USER>/vault` — a
symlink back to `<VAULT_DIR>`. Flask picks up the drop-in via
`EXO_PROXY_SECRET_FILE=<SRV_DIR>/proxy_secret`
(`/etc/systemd/system/exocortex.service.d/proxy-secret.conf`). Full ordered
cutover steps: `deploy/phase1-cutover.md`.

## 2. Python env + dependencies

```bash
cd <SKELETON_DIR>
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```
`gunicorn` + `gevent` are both required — the systemd unit's `ExecStart` needs
them. (Tests need the extra `requirements-dev.txt`.) The frontend additionally
needs Node 20+: `cd frontend && npm install && npm run build` (or run
`install.sh`, which does the whole thing).

## 3. The wiring — env vars that make it *your* instance

`deploy/exocortex.service.template` sets these:

| Var | What it configures |
|---|---|
| `EXOCORTEX_DATA_DIR` | Root of the JSON/SQLite data store (todos, streaks, auth.json, uploads, config) — set to `<VAULT_DIR>/data` |
| `EXOCORTEX_CONTENT_DIR` | Markdown content: journal, habits, meetings, `about.md` — set to `<VAULT_DIR>/tulku` (or wherever your vault keeps content) |
| `EXOCORTEX_RECEIPTS_DIR` | Receipt image store |
| `EXOCORTEX_RECIPES_DIR` | Recipe-pipeline data |
| `EXOCORTEX_IDEAS_FILE` | The ideas/vision doc "send to ideas" appends to |
| `EXOCORTEX_OWNER_NAME` | Owner name shown in header/footer — `<OWNER_NAME>` |
| `EXOCORTEX_APP_NAME` | Display app name |
| `TEMPLATES_AUTO_RELOAD` | Flask template auto-reload (dev convenience; harmless in prod) |

**`EXOCORTEX_DATA_DIR` vs `EXOCORTEX_CONTENT_DIR` — don't conflate them.**
`DATA_DIR` is structured JSON/SQLite (todos, streaks, config — read/written
through `store.py`); `CONTENT_DIR` is markdown prose (the journal itself,
habit notes, `about.md`). They're normally two different subdirectories of
the same vault checkout, but the app treats them as independent roots — you
*can* point them at different places entirely (e.g. content on a separate
encrypted volume) and the app won't care.

Two more vars exist in the code (`store.py`) but don't need to be set — they
fall back to defaults derived from `EXOCORTEX_DATA_DIR`:

| Var | Default (when unset) | What it configures |
|---|---|---|
| `EXOCORTEX_TRIAGE_DIR` | `<DATA_DIR>/../triage` | Working dir for the "talk to it, it reorders your todos" Claude session |
| `EXOCORTEX_PERSON_DIR` | `<DATA_DIR>/../person-summary` | Working dir for the "regenerate impression" Claude session on a person page |

One more exists but has no live default wiring — uses its code default:

| Var | Default | What it configures |
|---|---|---|
| `EXOCORTEX_DEFAULT_PASSWORD` | `"exocortex"` (literal, in `config.py`) | Seeds the password hash the **first time ever** `auth.json` is generated — see step 9. Irrelevant once `auth.json` exists. |
| `EXOCORTEX_USDA_KEY` | `""` (feature off) | USDA FoodData Central API key for nutrition lookups. The app reads a per-user config value first, then falls back to this env var. |

## 4. Test it in the foreground first

```bash
cd <SKELETON_DIR>
EXOCORTEX_DATA_DIR=<VAULT_DIR>/data \
EXOCORTEX_CONTENT_DIR=<VAULT_DIR>/tulku \
EXOCORTEX_RECEIPTS_DIR=<VAULT_DIR>/receipts \
EXOCORTEX_RECIPES_DIR=<VAULT_DIR>/recipes \
EXOCORTEX_IDEAS_FILE=<VAULT_DIR>/docs/IDEAS.md \
EXOCORTEX_OWNER_NAME='<OWNER_NAME>' EXOCORTEX_APP_NAME='Exocortex' \
venv/bin/gunicorn -k gevent -w 2 -b 127.0.0.1:5000 server:app
```
Open `http://127.0.0.1:5000` — should be your dashboard, your data, your
streaks. Ctrl-C to stop once confirmed.

## 5. Install the systemd units

All templates live in `deploy/` — see `deploy/README.md` for the render +
copy/enable commands. What each one does:

| Unit | Role |
|---|---|
| `exocortex.service` | The Flask app itself (gunicorn, 2 gevent workers, port 5000 loopback-only) |
| `exocortex-tmux.service` | Owns the persistent tmux server (`<TMUX_SOCKET>`) that the web terminal attaches to. Deliberately a *separate* unit from `ttyd.service` — a tmux server living in ttyd's cgroup gets killed every time ttyd restarts, along with every session in it. **Known footgun: restarting `exocortex-tmux.service` still kills every live tmux session** — only restart it if you genuinely mean to nuke all terminal state. |
| `ttyd.service` | The web terminal server, binds to `127.0.0.1:7681` only (not exposed directly — nginx proxies `/terminal/` to it, with auth enforced at the nginx layer, see step 6). Runs `scripts/ttyd_connect.sh`, which waits for a real terminal size then attaches to the shared tmux socket. |
| `exocortex-healthcheck.service` + `.timer` | Runs every minute: curls the app, restarts it on failure. Self-healing watchdog for the main app only — does not check ttyd, tmux, or code-server. |
| `code-server.service` | Browser VS Code, proxied at `/files/` (see step 6). |

```bash
sudo cp <SKELETON_DIR>/deploy/*.service <SKELETON_DIR>/deploy/*.timer /etc/systemd/system/   # rendered
sudo systemctl daemon-reload
sudo systemctl enable --now exocortex.service exocortex-tmux.service ttyd.service \
    exocortex-healthcheck.timer code-server.service
```

## 6. nginx + TLS + DNS

Vhost template: `deploy/nginx-exocortex.conf.template`. Domain: `<APP_DOMAIN>`,
DNS A record → this machine's IP, TLS via certbot (Let's Encrypt), auto-renewed
by certbot's own systemd timer.

Key wiring in the vhost, both protected the same way:
- `location /files/` → proxies to code-server on `127.0.0.1:8080`
- `location /terminal/` → proxies to ttyd on `127.0.0.1:7681`, plus a
  `sub_filter` hack that disables xterm.js scrollback/CSS-scrollbar

Both use `auth_request /api/auth-check;` — nginx makes a subrequest to the
Flask app's `/api/auth-check` route, which returns `204` if
`session['authed']` is truthy (a valid logged-in session cookie) or `401`
otherwise. A `401` triggers `error_page 401 = @login_redirect`, which 302s
the browser to `/login`. This is the **only** thing gating the web terminal
and code-server — do not deploy either location without it. See the
comment at the top of `deploy/nginx-exocortex.conf.template`, and the
deprecated-scripts warning in `deploy/README.md`.

Apply on a fresh machine: see `deploy/README.md` for the exact copy/certbot
commands. Order: get DNS pointed at the new box first, then run certbot,
since certbot's HTTP-01 challenge needs the domain resolving to the machine
it's running on.

Optional: `scripts/apex-landing.conf.template` is a landing-page-only vhost
for a bare apex domain (distinct from the app's usual subdomain), if you want
one. It's a separate, independent nginx server block — apply it the same way,
with its own certbot run.

## 7. Cron jobs

Template: `deploy/crontab.template.txt`. Install with `crontab crontab.txt`
(rendered) — run as `<APP_USER>`, not root. What each job does:

| Schedule | Script | What it does |
|---|---|---|
| Hourly, `:00` | `scripts/git_backup.sh` | Auto-commits + pushes the vault (data, content) to `origin/main`; for the skeleton repo, only *pushes* already-committed work (code commits should be deliberate, made by hand when something ships). Drops a `BACKUP_FAILING.txt` flag at the vault root if `git add -A` ever fails, so a broken backup is loud (visible in every Claude session + `git status`) instead of silently rolling on. |
| Daily 3:00 | `scripts/keeper_rollover.sh close` | Sends `/endsession` into the Keeper's tmux pane — writes the diary entry, closes the journaling day. |
| Daily 3:10 | `scripts/keeper_rollover.sh open` | Sends `/clear` then `/journalstart` into the same pane — fresh Keeper incarnation for the new day. |
| Daily 2:00 / weekly Mon 4:00 / weekly Sun 5:00 | vault-side "cricket" automation | Not migrated into this repo (vault-side content tooling — see `deploy/README.md`'s crontab template for the exact lines if you build your own equivalent). |
| Daily 2:30 | `scripts/usage_rollup.py` | Folds the access log's per-request lines into per-feature read/write counts (the `api` key of the `feature_usage` collection) — see INSTALL.md's "Usage tracking" section. |
| Weekly Sun 4:30 | `scripts/usage_doctor.py --devnote` | The architecture pulse: posts a `[usage]` dev note with top routes, top collections per process, tab hours, and the zero-traffic lists. |

## 8. Link the Claude Code slash-commands

Slash commands (`/journalstart`, `/endsession`, and any others you add) live
in this repo at `claude-commands/`, but Claude Code loads them from
`~/.claude/commands/`. Symlink them:
```bash
bash <SKELETON_DIR>/scripts/link_commands.sh
```
Idempotent, links whatever `*.md` files are present — add a new command file
to `claude-commands/` and it's picked up automatically, no script edit
needed. Run as `<APP_USER>` (not root — it touches `~/.claude`). Restart the
`claude` CLI afterward so it re-reads the commands. (`INSTALL.md` covers the
same linking for the local/laptop path — `install.sh` does it there.)

**Keeper capture hook — two copies, both required.** The journal's
capture-at-source hook (a `UserPromptSubmit` hook, see `INSTALL.md`'s
"Journaling" section for the local-path version) is wired in
**project-level** settings, and Claude Code only loads the settings of the
directory the session was launched from — parent/child dirs don't inherit
each other's hooks. If you launch Claude Code sessions from more than one
directory (e.g. both `<VAULT_DIR>` directly and an umbrella parent directory
above it), the hook must exist in **both** directories' `.claude/settings.json`
— once per launch directory, each with a path to the hook script correct for
that context.

**Failure mode if the hook isn't loaded in the directory you launched
from:** Keeper sessions still *look* normal — you can type, the Keeper
responds — but nothing auto-saves: no capture cards mint, no `.on` marker
file appears in the session-tracking directory, and any fallback minting
uses guessed (wrong) timestamps. This is silent corruption, not a crash.
**Quick check:** after a `/journalstart` session's first message, a fresh
`<session-id>.on` marker file should exist in the vault's keeper-sessions
directory (see your `CLAUDE.md`/journal skill for the exact path). If it's
missing, the hook isn't wired for that launch directory — fix
`.claude/settings.json` there before trusting the session to record anything.

## 9. auth.json — how login gets set up

`server.py` checks `EXOCORTEX_DATA_DIR/auth.json` at process start:
- **If it exists**: loads `secret_key` (Flask session signing) and
  `password_hash` from it and boots with those.
- **If absent** (true first run, or a fresh machine with an empty data dir):
  generates a random 32-byte hex `secret_key`, bcrypt-hashes
  `EXOCORTEX_DEFAULT_PASSWORD` (default literal `"exocortex"` if that env var
  isn't set), and writes both into a new `auth.json`. **There is no
  interactive setup step — the app boots immediately usable with the seed
  password.** Log in at `/login` and change it right away via Settings
  (`POST /api/auth/change-password`, requires current password + new
  password ≥6 chars).

On a restore: if you carry over an existing `data/auth.json`, login is
unchanged, no setup needed. If you leave it behind (e.g. after untracking it
for secrets hygiene, or a genuinely fresh install), the app auto-generates a
fresh one on first boot with the default password above — log in and change
it immediately.

## 10. Not backed up anywhere — handle separately

- **`/etc/letsencrypt/`** — cert/key material, not readable by an
  unprivileged user. Don't try to copy it; re-issue via certbot on the new
  machine (step 6).
- **`/etc/sudoers.d/`** — verify by hand as root whether any NOPASSWD rules
  live there that your app or automation depends on before assuming a fresh
  install's default sudo config is equivalent.
- **`~/.claude/projects/` transcripts** — Claude Code's own conversation
  history for this machine, not backed up by any cron job here. Copy manually
  (`rsync -a ~/.claude/projects/ <new-host>:~/.claude/projects/`) if
  conversation continuity across the move matters.

## 11. Secrets-in-git — a decision to make before you push anywhere new

If your vault's `data/auth.json` (secret_key + password hash), any API-key
config files, or bank/financial CSVs ever got committed to git history,
cloning that repo onto a new machine — or pushing it somewhere new — brings
that history with it. Decide up front whether to scrub history
(`git filter-repo`) or just `git rm --cached` + rotate the exposed
credentials going forward; don't discover this after the repo is already
public or shared.

---

## Notes

- **Everything** app-level lives in `EXOCORTEX_DATA_DIR` (JSON/SQLite) +
  `EXOCORTEX_CONTENT_DIR` (markdown). Back up your vault repo (the hourly
  cron already does) and you've backed up the app's own data. The
  *infrastructure* around it — nginx, systemd, cron, TLS certs, sudoers — is
  what this document and `deploy/` cover.
- If paths change (different `EXOCORTEX_DATA_DIR` etc.), remember
  `EXOCORTEX_TRIAGE_DIR` and `EXOCORTEX_PERSON_DIR` move with
  `EXOCORTEX_DATA_DIR` by default (they're derived from it) unless
  independently overridden.
