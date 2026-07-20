# Exocortex — macOS Setup Guide (Apple Silicon)

> Generic runbook derived from a real setup. Placeholders: `<user>`, `<your-mac>`,
> `<tailnet>`, `<tailscale-ip>`, `<your-github>`. Substitute your own values.

A running record of setting up `exocortex-skeleton` on this Mac (Apple Silicon / arm64, macOS Darwin 25.5.0). Newest entries appended at the bottom.

- **Repo:** https://github.com/braedeigh/exocortex-skeleton (private)
- **Local clone:** `~/exocortex-skeleton`
- **Goal:** local install per `INSTALL.md` — run the app at http://localhost:5000
- **Chosen scope:** base install, **no API keys** (all optional keys deferred; core app works without them)
- **Started:** 2026-07-19

---

## Reproduce on a fresh Mac (condensed runbook)
Ordered recipe distilled from the chronological log below. Apple Silicon, macOS.
Commands assume `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.

1. **Xcode Command Line Tools** (gives `git`): `xcode-select --install` (GUI, needs admin). Wait for it.
2. **GitHub CLI + auth** (private repos): install `gh` (brew or standalone), `gh auth login` (HTTPS, browser).
3. **Clone the code** (skeleton) + **the data vault** (this repo, `exocortex-personal`) into separate folders.
4. **Homebrew** → `brew install python node` (need Python 3.11+, Node 20+).
5. **Build/run**: from the skeleton, `./install.sh` (venv + deps + frontend). ⚠️ If the frontend build fails on `Sparkline`, apply the case-sensitivity fix (rename `sparkline.ts`→`sparklineMath.ts`, update 2 imports) — unless it's merged upstream.
6. **Point the app at the vault**: run with `EXOCORTEX_DATA_DIR=<vault>`, `EXOCORTEX_OWNER_NAME=<name>`, `EXOCORTEX_DEFAULT_PASSWORD=<pw>`.
7. **Always-on**: gunicorn as a **system LaunchDaemon** (`/Library/LaunchDaemons/com.exocortex.server.plist`, bind `127.0.0.1:5050`); `pmset -a sleep 0` (+ `disablesleep 1` on a laptop, keep it plugged in).
8. **Private remote access**: `brew install tailscale`; `sudo tailscaled install-system-daemon`; `sudo /opt/homebrew/bin/tailscale up`.
9. **Terminal / in-app Claude Code** (optional): `brew install tmux ttyd caddy`; use `scripts/ttyd_connect.sh` + `scripts/Caddyfile`; load `com.exocortex.ttyd` + `com.exocortex.caddy` **user LaunchAgents** (they need the login session — Claude's auth is in the login keychain). Front door becomes **`localhost:5051`**.
10. **Set a strong password** in Settings (the seed password is a placeholder).

See `PHONE-SETUP.md` for phone access and `scripts/` for the infra files.

---

## What the app is (one line)
Self-hosted, single-user personal life/health dashboard. Flask + gunicorn backend, React SPA frontend (Vite/npm), data as JSON + SQLite in `./data/`. Version 0.6.

## Requirements vs. this machine (starting state)
| Need | Required | Found at start | Action |
|---|---|---|---|
| Git | any | Apple Git 2.50.1 (after installing Command Line Tools) | ✅ done |
| GitHub auth | for private clone | none | ✅ `gh` installed locally + `gh auth login` (user `<your-github>`) |
| Python | 3.11+ | 3.9.6 (system, too old) | ⬜ install newer |
| Node / npm | 20+ | not installed | ⬜ install |
| Homebrew | (to install the above) | not installed | ⬜ install |

## Optional API keys (all deferred — app runs without them)
- `OPENAI_API_KEY` — semantic/vector search
- `EXOCORTEX_USDA_KEY` — USDA food lookups
- `EXOCORTEX_CONTACT_EMAIL` — research-sources contact
- `EXOCORTEX_DEFAULT_PASSWORD` — override default login password (`exocortex`)

---

## Step log

### ✅ Step 0 — Prerequisites cleared
- Installed Apple **Command Line Tools** (gave us working `git 2.50.1`).
- Installed **GitHub CLI `gh` 2.96.0** locally (`~/.local/bin/gh`, no admin needed).
- Authenticated to GitHub as **`<your-github>`** (token in macOS keychain, `repo` scope).
- **Cloned** the repo to `~/exocortex-skeleton`.
- Read `README.md`, `INSTALL.md`, `install.sh`, `requirements.txt`, `config.py`, `CLAUDE.md`.

### ✅ Step 1 — Install Homebrew
- Installed **Homebrew 6.0.11** to `/opt/homebrew` (user ran the installer; needed admin password once).
- Downloaded the install script locally first (`~/brew-install.sh`) to avoid a paste/line-wrap issue with the long curl URL.

### ✅ Step 2 — Install Python + Node
- `brew install python node` → **Python 3.14.6** (`/opt/homebrew/bin/python3`) and **Node 26.5.0** + **npm 11.17.0** (`/opt/homebrew/bin/node`).
- Both exceed the repo minimums (Python 3.11+, Node 20+).
- ⚠️ Watch: Python 3.14 is very new — the pinned deps (pandas 3.0.3, gevent 26.5.0) need cp314 wheels or they'll compile from source. Verifying in Step 3.

### ✅ Step 3 — Run ./install.sh (venv + Python deps + frontend build)
From `~/exocortex-skeleton`, with Homebrew's tools on PATH (`export PATH="/opt/homebrew/bin:$PATH"`):
```bash
./install.sh
```
- **Python venv** created at `./venv` (Python 3.14.6). All pinned deps installed cleanly (no source-compile issues on 3.14): Flask 3.1.3, gunicorn 26.0.0, gevent 26.5.0, pandas 3.0.3, bcrypt 5.0.0, jsonschema 4.26.0.
- **Frontend**: `npm install` in `frontend/` succeeded; `npm run build` (vite + `tsc --noEmit`) **initially FAILED** — see the fix below.

### 🔧 Step 3a — Fix a real repo bug (case-sensitivity build break)
**Symptom:** `npm run build` failed with
`[MISSING_EXPORT] "Sparkline" is not exported by "src/features/people/Sparkline.ts"`.

**Root cause:** the People feature had two files differing only by **case + extension**:
- `frontend/src/features/people/Sparkline.tsx` — the React component
- `frontend/src/features/people/sparkline.ts` — the pure-math helper (`buildSparkline`, …)

`PersonRow.tsx` does `import { Sparkline } from './Sparkline'`. On the author's **Linux** box (case-sensitive FS) that resolves to `Sparkline.tsx`. On **macOS** (case-insensitive FS) the bundler matches `./Sparkline` to `sparkline.ts` (`.ts` tried before `.tsx`), which has no `Sparkline` export → build fails. Classic "builds on Linux, breaks on Mac."

**Fix applied (local, uncommitted):**
```bash
git mv frontend/src/features/people/sparkline.ts \
       frontend/src/features/people/sparklineMath.ts
```
Then updated the two importers from `./sparkline` → `./sparklineMath`:
- `frontend/src/features/people/Sparkline.tsx`
- `frontend/src/features/people/sparkline.test.ts`

After this, `npm run build` succeeds (`✓ built in ~950ms`, `tsc --noEmit` clean).

> **Upstream note:** this is a genuine cross-platform bug in the repo, worth reporting/committing so anyone on macOS can build. Left as a local change — committing/pushing to the repo is the owner's call. See `git status` / `git diff` in `~/exocortex-skeleton`.

### ✅ Step 4 — Start & verify the app
```bash
cd ~/exocortex-skeleton
export PATH="/opt/homebrew/bin:$PATH"
PORT=5050 ./venv/bin/python3 server.py     # 5050 avoids macOS AirPlay on :5000
```
- `✓ Startup validation passed — all data files OK`
- `GET /` → 200, `GET /login` → 200, page title **Exocortex**, password field present.
- Data dir: `~/exocortex-skeleton/data/` (JSON + SQLite `exo.db`). **This folder is the entire backup.**
- Running the **Flask dev server** here (fine for local trial). Production/always-on should use **gunicorn** (see DEPLOY.md).

---

## How to run it again (quick reference)
```bash
cd ~/exocortex-skeleton
export PATH="/opt/homebrew/bin:$PATH"
PORT=5050 ./venv/bin/python3 server.py
# → open http://localhost:5050 , log in with password: exocortex , change it in Settings
```
- After pulling new code: re-run `./install.sh` (picks up new deps + rebuilds frontend).
- `gh` lives at `~/.local/bin/gh` (already on PATH); logged in as `<your-github>`.

## Everything installed on this machine (inventory)
| Thing | Version | Location | How |
|---|---|---|---|
| Xcode Command Line Tools | (Apple Git 2.50.1) | system | `xcode-select --install` (user, GUI) |
| GitHub CLI `gh` | 2.96.0 | `~/.local/bin/gh` (+ unpacked in scratchpad) | downloaded release zip, no admin |
| Homebrew | 6.0.11 | `/opt/homebrew` | official installer (user ran, admin pw once) |
| Python | 3.14.6 | `/opt/homebrew/bin/python3` | `brew install python` |
| Node + npm | 26.5.0 / 11.17.0 | `/opt/homebrew/bin/node` | `brew install node` |
| App venv | Python 3.14.6 | `~/exocortex-skeleton/venv` | `./install.sh` |
| Frontend build | — | `~/exocortex-skeleton/frontend/dist` | `npm run build` |

### ✅ Step 5 — Set login (single-user, for now)
This app's login is a **single shared password** (bcrypt hash in `data/auth.json`), **no usernames**. True named-user accounts require the separate **`exocortex-rs`** Rust proxy, which does not exist on either GitHub account yet (checked `braedeigh` + `<your-github>`: only `exocortex-skeleton` exists; no `exocortex-personal`, no `exocortex-rs`).

For now, as requested:
- **Password → `password`** (regenerated `data/auth.json` `password_hash` via `bcrypt.hashpw`, kept the existing `secret_key`).
- **Display owner name → `<user>`** via `EXOCORTEX_OWNER_NAME` (set in the server's run env). *Display only — not a real username.*
- Verified: wrong password rejected (HTTP 200 stay-on-login), `password` accepted (HTTP 302 → `/`), authed `GET /` → 200.

> ⚠️ **`password` is a placeholder for local-only use.** Before this is reachable beyond `localhost` (Tailscale / always-on), set a strong password in Settings.

### ✅ Step 6 — Personal data vault (`exocortex-personal`)
- Created `~/exocortex-personal` (fresh, empty vault).
- Pointed the live app at it: server now runs with `EXOCORTEX_DATA_DIR=~/exocortex-personal` (+ `EXOCORTEX_OWNER_NAME=<user>`, `EXOCORTEX_DEFAULT_PASSWORD=password`, `PORT=5050`). App seeded it fresh (`auth.json`, `exo.db`, `uploads/`).
- `git init` + first commit; created and pushed **private** repo **`<your-github>/exocortex-personal`** (https://github.com/<your-github>/exocortex-personal).
- Login verified against the vault (password `password` → 302).
- Data ⇄ code separation now matches the intended architecture. **Back up = push this repo** (or copy the folder).

### Claude Code integration — findings (2026-07-19)
- **Claude Code CLI is installed**: `~/.local/bin/claude` v2.1.215. She can log in and use it in a terminal here (`claude`, then the login flow — her Anthropic account).
- **The app's Terminal & Research tabs are Linux-coupled and won't work on macOS as-is:**
  - Need **tmux** (not installed here).
  - Assume Linux specifics: `/proc` process walking (`routes/terminal.py`), tmux socket `/tmp/tmux-1000/default`, uid 1000. macOS has none of these.
  - So driving Claude Code *inside the app* would need porting (or running the app on Linux). The CLI itself works fine standalone.

### ✅ Step 7 — Always-on hosting (this Mac, headless)
- **Production server:** gunicorn (gevent, 2 workers) replacing the Flask dev server — command per DEPLOY.md, bound `127.0.0.1:5050`.
- **launchd daemon:** `/Library/LaunchDaemons/com.exocortex.server.plist` (source kept at `~/com.exocortex.server.plist`). Runs as `<user>`, `RunAtLoad` + `KeepAlive` → starts at boot, auto-restarts on crash. Env baked in (`EXOCORTEX_DATA_DIR`, `EXOCORTEX_OWNER_NAME`, `HOME`, `PATH`).
- **No-sleep (laptop):** `pmset -a sleep 0` + `pmset -a disablesleep 1` → stays running **lid-closed**. **Must stay plugged into power.**
- Installer script: `~/exocortex-alwayson-setup.sh` (run once with `sudo`; has UNDO notes). Verified: `GET /login` → 200 from gunicorn.
- Note: running the script twice logs `Load failed: 5: Input/output error` on the 2nd run — benign ("already loaded").

### ✅ Step 8 — Tailscale (private access)
- Installed via `brew install tailscale` (1.98.x); system daemon via `tailscaled install-system-daemon` (in the setup script).
- Signed in (`sudo /opt/homebrew/bin/tailscale up`) as `<user>@`. This node: **`<your-mac>`** / `<tailscale-ip>` / `<your-mac>.<tailnet>.ts.net`, Online.
- ⚠️ `tailscale`/`tailscaled` are in `/opt/homebrew/bin`, which **`sudo` doesn't have on its PATH** — always call Tailscale under sudo with the **full path** `/opt/homebrew/bin/tailscale`.

### ✅ Step 9 — Port the Terminal / Claude-Code pane to macOS
The left "terminal" pane (`TerminalFrames.tsx`) loads an iframe `/terminal/?arg=<session>`. In prod that's **nginx → ttyd → `ttyd_connect.sh` → tmux session running `claude`**. None of that existed here. Rebuilt it on macOS:

- **Installed** `tmux`, `ttyd` 1.7.7, `caddy` 2.11.4 (`brew`).
- **Reconstructed `ttyd_connect.sh`** → `~/exocortex-personal/scripts/ttyd_connect.sh` (original lives in the author's private vault). `ttyd` runs it per connection with the session name; it `tmux new-session -A` (attach-or-create) running `claude` on socket `/tmp/tmux-1000/default` (the exact path the app uses — works fine on macOS since it's passed via `-S`).
- **Caddy reverse proxy** (`~/exocortex-personal/scripts/Caddyfile`) on **`127.0.0.1:5051`** = the front door: `/terminal/*` → ttyd, everything else → gunicorn (:5050). **Use `http://localhost:5051`** (the terminal pane only resolves through Caddy).
- **Persistence (LaunchAgents, no sudo):** `~/Library/LaunchAgents/com.exocortex.ttyd.plist` + `com.exocortex.caddy.plist` (RunAtLoad + KeepAlive). They run in her **logged-in session** because `claude` auth is in the **login keychain** (`security` service `Claude Code-credentials`) — a boot-time *system* daemon can't unlock it. gunicorn stays a system daemon (no keychain needed).
- **FileVault is On** → macOS auto-login is unavailable. After a reboot she enters the FileVault password once (which logs her in), then the agents start and the terminal works. Fully-unattended reboots aren't possible with FileVault — inherent, and the safer posture.

**Session types (`ttyd_connect.sh`):** the **`chat`** session (the Keeper) auto-runs **`claude --dangerously-skip-permissions "/journalstart"`** (boots straight into a Keeper journaling session; `/journalstart` is wired only here); **every other session opens a plain login shell** (so she can run any command herself, including her own `claude` invocation). Worker sessions (`rw-*`) are pre-created by the app and just attached to. Changing the command only affects *newly created* sessions — kill an existing one (`tmux -S /tmp/tmux-1000/default kill-session -t =<name>`) to have it recreated with the new command.

**Two bugs fixed during the port:**
1. **New sessions died with `[exited]`** — a freshly-created tmux session inherits `ttyd_connect.sh`'s `PATH`, which lacked `~/.local/bin` where `claude` lives → `command not found: claude`. Fixed by putting `~/.local/bin` first in the script's (and the ttyd agent's) PATH. (`chat` worked only because it *attached* to a pre-made session.)
2. **Security: unauthenticated writable shell** — `/terminal/` bypassed the app login (the exact risk in DEPLOY.md). Fixed with Caddy `forward_auth` → the app's `/api/auth-check` (204 authed / 401 not), and `bind 127.0.0.1` so it's localhost-only (verified refused from the tailnet IP). Remote access is meant to go via `tailscale serve`.
3. **Empty pane (blank terminal)** — `forward_auth` forwarded the `Upgrade: websocket` headers to the auth subrequest, which gunicorn 400s → the ttyd websocket never established → blank pane. Fixed by stripping `Connection`/`Upgrade` from the auth subrequest only (`header_up -Connection` / `-Upgrade`); the real upgrade still reaches ttyd. Verified: ws → 101 with cookie, 401 without.

**Ops note:** reloading a LaunchAgent with back-to-back `bootout`+`bootstrap` can race ("Bootstrap failed: 5: Input/output error"); wait ~3s between them (or `pkill` the process first).

**Known macOS degradations (non-fatal):** session "recaps" and the needs-input indicator use Linux `/proc` (`routes/terminal.py`) and the `/proc/meminfo` spawn-guard (`routes/kitchen/shared.py`) — these no-op/blank on macOS; the terminal itself works. Can be patched to use `ps`/`os.kill` later if wanted.

## Still to do
1. **Expose to her phone** — `tailscale serve` for HTTPS (best for the PWA) OR rebind gunicorn to the tailnet. Requires enabling HTTPS certs in the Tailscale admin console.
2. **Strong password** — replace `password` (she can do it in the app's **Settings** — no restart needed; the change-password endpoint updates the live process).
3. **PR the setup log to `exocortex-personal`** — this file becomes the runbook for setting up her **home computer** too. *(Also worth: a separate PR to `exocortex-skeleton` for the Sparkline case-sensitivity fix — it's a shared-code bug.)*
4. *(Optional/later)* **In-app Claude Code (Terminal/Research)** — needs tmux + Linux porting; deferred.

## Leftover files that can be deleted
- `~/brew-install.sh` (the Homebrew installer script — no longer needed)
