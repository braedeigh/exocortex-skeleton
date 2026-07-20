# Phase 1 cutover — real auth (SQLite, exocortex-rs-served login)

Origin: personal vault deploy/phase1-cutover.md. Scrubbed modular copy —
plug-in points marked PLUG-IN(...).

**Optional.** Only relevant if you run the optional Rust strangler front
server (exocortex-rs) and want it to own login/session instead of Flask.
Skip this whole document if you're running Flask alone.

Ordered, copy-pasteable runbook for cutting a live machine over from Phase-0
(exocortex-rs as a headerless reverse proxy in front of Flask) to Phase 1
(exocortex-rs owns login + session, and forwards a trusted identity header to
Flask). Run the steps in order — the ordering in §4/§5 is load-bearing.

Prereqs: `exo` has gained a `backup --out <dir>` subcommand (snapshots
`system.db` + all `users/*/exo.db` via SQLite's backup API) and a `user add`
subcommand. Both are assumed built by the time you run this.

## 1. Build (no sudo)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /opt/exocortex/exocortex-rs   # PLUG-IN(RS_DIR): your exocortex-rs checkout
cargo build --release
cargo test
```
Don't proceed past a failing test.

## 2. Root setup (sudo)

```bash
sudo mkdir -p <SRV_DIR>/users/<APP_USER>
sudo chown -R <APP_USER>:<APP_USER> <SRV_DIR>
```
This creates the whole `<SRV_DIR>` tree in one shot (parent + your user's
subdir) and hands ownership to `<APP_USER>` so every step after this one runs
unprivileged.

## 3. Create the account (no sudo)

```bash
/opt/exocortex/exocortex-rs/target/release/exo user add <APP_USER> \
  --display-name "<OWNER_NAME>" --admin \
  --config /opt/exocortex/exocortex-rs/exo.toml
```
**Use the same password as your current site login, if you have a mobile
client that stores it and silently re-authenticates** — a different password
here means the client fails to re-login with no visible prompt to fix it.

Then link the vault into the new per-user layout:
```bash
ln -sfn <VAULT_DIR> <SRV_DIR>/users/<APP_USER>/vault
```
No sudo needed — `<APP_USER>` owns `<SRV_DIR>` after step 2.

## 4. Flask side first (sudo)

Install the proxy-secret drop-in (`deploy/flask-proxy-secret.conf.template`,
rendered):
```bash
sudo mkdir -p /etc/systemd/system/exocortex.service.d
sudo cp deploy/flask-proxy-secret.conf \
  /etc/systemd/system/exocortex.service.d/proxy-secret.conf
sudo systemctl daemon-reload
sudo systemctl restart exocortex.service
```
**Order matters: Flask restarts before Rust.** The Flask-side trust patch is
inert until the identity header actually arrives, so it's safe to bring up
first — restarting Flask here does not yet change any user-visible behavior.

## 5. Rust side (sudo)

```bash
sudo systemctl restart exocortex-rs.service
```
This is the step that actually flips traffic over to real auth — from here
on, exocortex-rs is issuing sessions and forwarding the trusted header to
Flask.

## 6. Verify

```bash
# Logged-out check: should be 401
curl -s -o /dev/null -w '%{http_code}\n' https://<APP_DOMAIN>/api/auth-check

# Login: should be 302
curl -s -o /dev/null -w '%{http_code}\n' -c /tmp/exo-cookies.txt \
  -d 'password=<CURRENT_SITE_PASSWORD>' \
  https://<APP_DOMAIN>/login

# Logged-in auth-check: should be 204
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/exo-cookies.txt \
  https://<APP_DOMAIN>/api/auth-check

# A private API GET with the same cookie jar: should be 200
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/exo-cookies.txt \
  https://<APP_DOMAIN>/api/todos

# /login page itself (GET) should still render: 200
curl -s -o /dev/null -w '%{http_code}\n' https://<APP_DOMAIN>/login
```
Then, by hand: log in from a mobile browser and, if you have a mobile client
that stores the site password and re-authenticates silently, confirm it still
loads afterward — that's the real end-to-end check, the curl calls above only
prove the HTTP contract.

Clean up the temp cookie jar once verified: `rm -f /tmp/exo-cookies.txt`.

## 7. Rollback

If anything in §6 fails, revert Flask's trust patch — exocortex-rs can stay
running:
```bash
sudo rm /etc/systemd/system/exocortex.service.d/proxy-secret.conf
sudo systemctl daemon-reload
sudo systemctl restart exocortex.service
```
Flask's legacy session auth still works after this — the trust patch was
additive, not a replacement, so removing the drop-in just stops Flask from
looking for the identity header again.

`exocortex-rs.service` does **not** need to be stopped or reverted: with no
valid `exo_session` cookie in play (nothing minted one, since Flask's `/login`
is what users hit again after rollback), exocortex-rs simply forwards traffic
headerless — which is exactly Phase-0 behavior, the state this machine was in
before this runbook started.
