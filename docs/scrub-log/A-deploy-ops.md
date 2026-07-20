# Batch A scrub log — deploy/ops architecture

Source: `personal vault deploy/` and `personal vault scripts/` (read-only).
Destination: `skeleton/deploy/`, `skeleton/scripts/`, `skeleton/docs/`. Copy,
not move; vault untouched, no git run, no systemd/nginx/live-service touched.

Placeholder legend (templates/configs/docs): `<APP_DOMAIN>`, `<APP_USER>`,
`<OWNER_NAME>`, `<OWNER_EMAIL>`, `<SKELETON_DIR>`, `<VAULT_DIR>`, `<SRV_DIR>`,
`<TMUX_SOCKET>`. Shell scripts use env vars with overridable defaults instead
(`EXOCORTEX_APP_USER`, `EXOCORTEX_VAULT_DIR`, `EXOCORTEX_SKELETON_DIR`,
`EXOCORTEX_APP_DOMAIN`, `CLAUDE_BIN`, `EXOCORTEX_TMUX_SOCKET`, plus a few
additive ones introduced below and called out as judgment calls).

**Note on this log itself:** entries below name the *kind* of value that was
scrubbed (a real domain, a real username, a real email, a real absolute
vault path, etc.) and never repeat the actual value — consistent with the
instruction that this log record kinds, not secrets. The migrated files
themselves are the audit trail for exact placement; this file is the map.

## deploy/ (systemd, nginx, crontab, Rust-door config)

### exocortex.service → deploy/exocortex.service.template
- Scrubbed: the Linux service account's user/group name (ran as the vault
  owner's own system account). Placeholder: `<APP_USER>`. Plug-in:
  substitute your own service account.
- Scrubbed: the absolute code-checkout path. Placeholder: `<SKELETON_DIR>`.
- Scrubbed: absolute vault paths (data/content/receipts/recipes/ideas file,
  5 occurrences). Placeholder: `<VAULT_DIR>` + subpaths.
- Scrubbed: the owner's real display name (`EXOCORTEX_OWNER_NAME` value).
  Placeholder: `<OWNER_NAME>`, marked `# PLUG-IN(OWNER_NAME)`.

### exocortex-rs.service → deploy/exocortex-rs.service.template
- Scrubbed: the Linux service account name. Placeholder: `<APP_USER>`.
- Kept literal: the sibling-repo checkout path for the optional Rust front
  server — not personal-identifying (no username/domain in it), and not one
  of the contract's placeholder keys; see judgment call 1 below. Marked with
  a `PLUG-IN(RS_DIR)` comment instead.

### exocortex-tmux.service → deploy/exocortex-tmux.service.template
- Scrubbed: the uid-1000 tmux socket path (4 occurrences). Placeholder:
  `<TMUX_SOCKET>`.
- Scrubbed: the Linux service account user/group. Placeholder: `<APP_USER>`.
- Scrubbed: the umbrella working directory (used as the tmux pane's starting
  cwd, 2 occurrences). Placeholder: `<SKELETON_DIR>` — see judgment call 2.
- Dropped a stale in-source comment about two extra sessions no longer being
  pre-created (accurate history, but skeleton-irrelevant noise); functional
  behavior unchanged.

### exocortex-healthcheck.service → deploy/exocortex-healthcheck.service.template
- No personal data (only local ports). Header comment added; PLUG-IN comment
  added noting the exocortex-rs probe half is optional.

### exocortex-healthcheck.timer → deploy/exocortex-healthcheck.timer.template
- No personal data. Header comment added only.

### ttyd.service → deploy/ttyd.service.template
- Scrubbed: the absolute vault path to `ttyd_connect.sh` and
  `WorkingDirectory` (2 occurrences). Since `ttyd_connect.sh` migrates into
  `skeleton/scripts/` in this same batch, both now point at `<SKELETON_DIR>`.
- Scrubbed: the Linux service account name. Placeholder: `<APP_USER>`.

### code-server.service → deploy/code-server.service.template
- Scrubbed: the Linux service account name. Placeholder: `<APP_USER>`.
- Scrubbed: the `--open` argument (umbrella dir). Placeholder:
  `<SKELETON_DIR>`.

### nginx-exocortex.conf → deploy/nginx-exocortex.conf.template
- Scrubbed: the real domain (7 occurrences: two `server_name`,
  `ssl_certificate`, `ssl_certificate_key`, the `if ($host = ...)` block,
  and the `:80` redirect server's `server_name`). Placeholder: `<APP_DOMAIN>`.
- **Not scrubbed on purpose**: the `auth_request /api/auth-check;` gates on
  `/files/` and `/terminal/`, and the whole location-block architecture —
  preserved byte-for-byte per instructions, with an added top-of-file comment
  explaining why it must never be replaced with `auth_basic`.

### exo.toml → deploy/exo.toml.template
- Scrubbed: the real domain in `public_origin`. Placeholder: `<APP_DOMAIN>`.
- Scrubbed: the `/srv/...` data root. Placeholder: `<SRV_DIR>`.
- Commented `[auth.google]` shape (already just placeholder text, no real
  secret present) kept as-is.

### flask-proxy-secret.conf → deploy/flask-proxy-secret.conf.template
- Scrubbed: the `/srv/...` path in `EXO_PROXY_SECRET_FILE`. Placeholder:
  `<SRV_DIR>`.

### deploy-rust-door.sh → deploy/deploy-rust-door.sh
- Scrubbed: the absolute vault path to the healthcheck unit. Env var:
  `EXOCORTEX_SKELETON_DIR` (default `/opt/exocortex/skeleton`, a generic
  convention path with no personal identity in it), plus a new
  `EXOCORTEX_HEALTHCHECK_UNIT` override.
- Added a `PLUG-IN(RENDER_TEMPLATE)` comment: since the healthcheck unit is
  now a `.template` file with `<PLACEHOLDER>` tokens, it must be rendered
  before this script's `cp` installs it — flagged rather than silently
  installing broken unit content.

### README.md → deploy/README.md
- Rewritten from a "verbatim live snapshot" framing to a "genericized
  template set" framing (the destination files are now `.template`s, not
  literal captures). Scrubbed: the real domain, the real owner email
  address (appeared in the certbot example), and all absolute vault paths.
  Added a placeholder legend table and a `sed`-based render example.

### phase1-cutover.md → deploy/phase1-cutover.md
- Scrubbed: absolute vault/skeleton/rust-repo/srv paths (8+ occurrences
  across steps 2–5). Placeholders: `<VAULT_DIR>`, `<SRV_DIR>` (kept the
  rust-repo checkout path literal per judgment call 1).
- Scrubbed: the real Linux username, in an `exo user add` example command and
  a `/srv/.../users/...` path. Placeholder: `<APP_USER>`.
- Scrubbed: the owner's real display name in a `--display-name` example.
  Placeholder: `<OWNER_NAME>`.
- Scrubbed: the real domain in every `curl` verification command (6
  occurrences). Placeholder: `<APP_DOMAIN>`.
- Scrubbed: a personal detail describing a specific mobile client's
  Keychain-based silent re-auth behavior — generalized to "if you have a
  mobile client that stores the site password and re-authenticates
  silently," since this describes an optional companion-app pattern, not a
  value that belongs in a shareable doc as a hard assumption.
- Marked the whole document as **optional** at the top (Rust strangler proxy
  + real multi-user auth only) — wasn't explicit in the vault original,
  which assumed the reader was already committed to the Rust cutover.

### nginx-exocortex.conf.pre-rs
- **Skipped** per explicit instruction (historical, superseded by the
  current vhost). Not migrated, not templated.

## scripts/ (shell tooling)

### git_backup.sh → scripts/git_backup.sh
- Scrubbed: the absolute vault path (5+ occurrences including the
  `BACKUP_FAILING.txt` flag path). Env var: `EXOCORTEX_VAULT_DIR`.
- Scrubbed: the absolute skeleton path (2 occurrences). Env var:
  `EXOCORTEX_SKELETON_DIR`.
- Scrubbed: the absolute exocortex-rs repo path (3 occurrences). New env
  var: `EXOCORTEX_RS_DIR` (default empty — script skips the optional
  Rust-repo push/snapshot logic entirely when unset).
- Scrubbed: the real git commit identity (a real personal name + a real
  personal email address), hardcoded into the `git -c ... commit`
  invocation. New env vars: `EXOCORTEX_GIT_NAME` / `EXOCORTEX_GIT_EMAIL`
  (fall back to the operator's own `git config --global` identity, then a
  generic default) — see judgment call 3.

### keeper_rollover.sh → scripts/keeper_rollover.sh
- Scrubbed: the uid-1000 tmux socket path. Env var: `EXOCORTEX_TMUX_SOCKET`
  (default `/tmp/exocortex-tmux/default`, matching the contract).
- Scrubbed: the absolute vault log path. Env var: `EXOCORTEX_VAULT_DIR` (log
  now defaults to `$VAULT/scripts/keeper_rollover.log`, override with
  `KEEPER_ROLLOVER_LOG`) — see judgment call 4 on why the log moved out of
  the code repo's own directory conceptually.
- Session name `"chat"` and the `KEEPER_TMUX_SESSION` override kept as-is —
  an app/skill convention (matches the `/journalstart`, `/endsession`
  commands shipped in `claude-commands/`), not personal data.

### harden_vps.sh → scripts/harden_vps.sh
- Scrubbed: the real Linux username (9+ occurrences: `chown`, `AllowUsers`,
  the user's `~/.ssh` paths, summary echo lines). Env var:
  `EXOCORTEX_APP_USER`.
- Scrubbed: the absolute vault path (6 occurrences in the
  permission-fixing `find`/`chown` block). Env var: `EXOCORTEX_VAULT_DIR`.
- Scrubbed: **the real server's IP address**, hardcoded into the printed
  "test SSH in a new terminal" warning banner. New env var:
  `EXOCORTEX_SSH_HOST_HINT` (default placeholder text `<your-server-ip>`).
- Mechanical fix: the `AllowUsers root $APP_USER` line needed the SSH
  heredoc terminator changed from quoted `'SSHEOF'` to unquoted `SSHEOF` so
  the shell variable actually expands — quoted heredocs don't interpolate.

### fix_ownership.sh → scripts/fix_ownership.sh
- Scrubbed: the absolute vault path (`REPO=`, 1 definition + used
  throughout). Env var: `EXOCORTEX_VAULT_DIR`.
- Scrubbed: the real Linux username (`OWNER=`, `-not -user`). Env var:
  `EXOCORTEX_APP_USER`.

### fix_terminal_auth.sh → scripts/fix_terminal_auth.sh
- Scrubbed: the real domain in the "test it" echo instructions (1
  occurrence). Env var: `EXOCORTEX_APP_DOMAIN` (falls back to a placeholder
  string in the printed message if unset, since this is informational
  output not a functional path).
- Reworded a line naming a specific dev-partner persona by name (referring
  to a specific workflow) to a generic instruction, since that persona
  naming convention isn't guaranteed to exist in every fork of this
  skeleton.
- nginx config path made overridable via `EXOCORTEX_NGINX_CONF` (was a fixed
  literal path — not personal data, but genericized for consistency since
  other scripts in this batch parameterize their config paths).

### remove_terminal_scrollbar.sh → scripts/remove_terminal_scrollbar.sh
- No personal data present in the source file (only local systemd/nginx
  paths, already generic). Header comment added; no other changes.

### restart_server.sh → scripts/restart_server.sh
- No personal data present. Header comment added only.

### setup_ssl.sh + setup_ssl2.sh → scripts/setup_ssl.sh (merged)
- Scrubbed: the real domain (both files) and the real owner email address
  (setup_ssl.sh's `-m` flag). Env vars: `EXOCORTEX_APP_DOMAIN` (required,
  errors if unset), `EXOCORTEX_OWNER_EMAIL` (required unless `--no-email` is
  passed).
- Merged per instructions: the two vault files were a near-duplicate pair —
  setup_ssl2.sh differed only by clearing `/etc/letsencrypt/accounts` and
  passing `--register-unsafely-without-email` instead of `-m <email>` (a
  workaround for a stuck prior certbot registration). Folded into one script
  as a `--no-email` flag rather than shipping two files that diverge by one
  line.

### ttyd_connect.sh → scripts/ttyd_connect.sh
- Scrubbed: the uid-1000 tmux socket path (2 occurrences). Env var:
  `EXOCORTEX_TMUX_SOCKET`.
- Scrubbed: the umbrella working directory (tmux `-c` starting dir). Env
  var: `EXOCORTEX_SKELETON_DIR`.
- Genericized the hardcoded worker-session name prefix (an app-level
  dispatcher convention, not personal data) into a new env var:
  `EXOCORTEX_WORKER_SESSION_PREFIX` (default unchanged, preserves existing
  behavior) — see judgment call 5.

### fix_ttyd.sh → scripts/fix_ttyd.sh
- Scrubbed: the absolute vault path to `ttyd_connect.sh`. Env var:
  `EXOCORTEX_SKELETON_DIR` (script now lives in `scripts/` alongside it).
- Scrubbed: the real Linux username and the absolute vault path (`User=`,
  `WorkingDirectory=`). Env vars: `EXOCORTEX_APP_USER`,
  `EXOCORTEX_SKELETON_DIR`.

### setup-mac-server.sh → scripts/setup-mac-server.sh
- Scrubbed: the owner's real display name, baked into an
  `EXOCORTEX_OWNER_NAME=...` env line inside the generated LaunchDaemon
  plist. New env var: `EXOCORTEX_OWNER_NAME` (default generic "Exocortex
  Owner").
- Genericized directory names tied to this vault's specific naming history
  (not personal per se, but instance-specific) to generic
  `exocortex-skeleton` / `exocortex-vault` names, both env
  var-overridable (`EXOCORTEX_SKELETON_DIR`, `EXOCORTEX_VAULT_DIR`) to match
  the rest of the batch's contract.
- `$(whoami)` derivation for the run-as user kept, now surfaced as
  `EXOCORTEX_APP_USER` for consistency with the rest of the batch (was
  already generic/non-personal in the original).

### apex-landing nginx config (vault scripts/, real-domain filename) → scripts/apex-landing.conf.template
- Scrubbed: the real apex domain, in both its bare and `www.` forms (3
  occurrences: `server_name`, plus a proxy comment referencing a
  domain-specific landing-page filename, reworded to remove it).
  Placeholder: `<APP_DOMAIN>`.
- Scrubbed: the **origin filename itself** — the vault source file's name
  had the real apex domain baked into it. Recorded here descriptively
  rather than quoting the original filename, and the destination file was
  given a domain-neutral name (`apex-landing.conf.template`).

### link_commands.sh → scripts/link_commands.sh
- Scrubbed: a hardcoded command list naming three specific slash-commands —
  this vault has one command that doesn't exist in this skeleton checkout's
  `claude-commands/` (which only ships two of the three). Rewritten to glob
  `claude-commands/*.md` dynamically per explicit task instruction, so it
  links whatever command files are actually present (today: `endsession`,
  `journalstart`; automatically picks up more later without editing this
  script).

## Left in vault (not migrated)

- **`setup_nginx.sh`, `setup_codeserver.sh`, `setup_filebrowser.sh`**
  (vault `scripts/`) — deprecated, explicitly skipped per instructions. All
  three generate `/files/`/`/terminal/` nginx blocks using `auth_basic` (a
  static htpasswd file) or, in `setup_nginx.sh`'s case, **no auth at all**
  on `/terminal/`. Re-running any of them would regress the `auth_request
  /api/auth-check` session-based gate that `deploy/nginx-exocortex.conf.template`
  documents as load-bearing, reopening the web terminal as an effectively
  unauthenticated shell. A generic version would need to be rewritten from
  scratch to emit `auth_request` blocks instead of `auth_basic`/no-auth —
  not a mechanical scrub, an actual behavior change, so left out rather than
  migrated-and-fixed.
- **`migrate_rename.sh`** (vault `scripts/`) — one-shot historical migration
  (renamed this machine's specific install paths at one specific past
  moment). Not a reusable deploy primitive; a generic version would need to
  be a generic "rename an installed instance's paths" tool, which is a
  different (and currently unneeded) piece of tooling, not a scrub of this
  one.
- **All `*.log` files** in vault `scripts/` (backup, cricket housekeeping,
  cricket run, cricket swarm, keeper rollover, prompt dispatcher,
  reconciler, research dispatcher, research doctor logs) — runtime
  artifacts and personal operational history, not source. Never migrated; a
  generic instance produces its own from a clean slate.
- **`nginx-exocortex.conf.pre-rs`** (vault `deploy/`) — historical,
  superseded config kept for reference on the live machine only. Skipped
  per explicit instruction.
- **`cricket_swarm.sh`, `cricket_housekeep.sh`** (vault `scripts/`), and the
  vault's transcript-reconciliation script (vault content dir) — referenced
  by `crontab.txt`/`RESTORE.md` but **not in this batch's migration list**.
  Left as vault-relative references (`<VAULT_DIR>/scripts/...`,
  `<VAULT_DIR>/tulku/...`) in `deploy/crontab.template.txt` and
  `docs/SETUP-FULL.md`, each flagged with a `PLUG-IN` comment noting they're
  vault-side automation a new user would need to write or adapt themselves.
  A generic version of each would need: the crickets, a pluggable roster of
  "one job per script" extraction agents driven by a prompt library (out of
  scope here); the reconciler, a generic transcript-to-capture-card
  reconciliation script tied to the Keeper's own storage format (also
  content-layer, not ops-layer).

## Judgment calls

1. **The optional Rust front server's own checkout path was kept as a
   literal default**, not mapped to a contract placeholder, in
   `exocortex-rs.service.template`, `deploy-rust-door.sh`, and
   `deploy/phase1-cutover.md`. The placeholder contract (`<APP_DOMAIN>`,
   `<APP_USER>`, `<OWNER_NAME>`, `<OWNER_EMAIL>`, `<SKELETON_DIR>`,
   `<VAULT_DIR>`, `<SRV_DIR>`, `<TMUX_SOCKET>`) has no slot for "the
   optional Rust front-server's own checkout path," and the value itself
   contains no personal information (no username, domain, or identity) —
   it's an architecture-level sibling-repo convention. Rather than invent a
   9th placeholder key not authorized by the brief, this was left as a
   literal default with an explicit `PLUG-IN(RS_DIR)` comment telling the
   reader to adjust it, consistent with how the mailclaude batch (see
   `docs/scrub-log/E-mailclaude.md`, judgment call 1) treated `<SRV_DIR>`
   defaults it couldn't parameterize through every file format.
2. **`exocortex-tmux.service`'s tmux-pane starting directory** (the
   *umbrella* parent of both repos in the original) was mapped to
   `<SKELETON_DIR>` rather than left as a separate concept. The umbrella
   directory itself isn't one of the contract's placeholders, and a tmux
   pane's starting cwd is not load-bearing (it's just where a fresh shell
   opens) — `<SKELETON_DIR>` is a reasonable, always-valid default. Applied
   the same choice consistently in `ttyd.service.template`,
   `code-server.service.template`, and `ttyd_connect.sh`'s `-c` argument.
3. **`git_backup.sh`'s commit identity** (`GIT_NAME`/`GIT_EMAIL`) is a new
   env-var pair not in the contract's explicit list. The contract's six
   named variables don't cover "who signs the automated backup commit," but
   the original hardcoded a real name + real email directly into the `git
   -c` invocation — leaving it un-scrubbed would fail the grep sweep.
   Followed the same "env var with overridable default" pattern as the
   contract's other variables rather than inventing a placeholder-token
   scheme for a shell script.
4. **`keeper_rollover.sh`'s log file moved conceptually out of the code
   repo.** The vault original wrote its log next to the script, inside the
   vault's own `scripts/` dir. Since this script now ships in
   `skeleton/scripts/` — a repo whose own `CLAUDE.md` states it "carries no
   personal data" — writing a runtime log inside the skeleton checkout would
   quietly reintroduce operational/personal data into a shareable repo on
   first run. Defaulted the log path to `$VAULT/scripts/keeper_rollover.log`
   instead (override via `KEEPER_ROLLOVER_LOG`), keeping runtime output in
   the vault where `.gitignore`/backup conventions already expect it.
5. **`ttyd_connect.sh`'s worker-session prefix** was parameterized
   (`EXOCORTEX_WORKER_SESSION_PREFIX`) even though it isn't personal data —
   it's a convention tied to a specific dispatcher (`research_dispatcher.py`,
   which already ships generically in this skeleton's `scripts/`). Kept the
   default identical to preserve current behavior, but made it overridable
   since a fork without that dispatcher, or with a different worker-naming
   scheme, shouldn't have to hand-edit this script to avoid the squatter-
   session guard misfiring.
6. **`crontab.template.txt` and `docs/SETUP-FULL.md` reference vault-side
   scripts that aren't part of this migration batch** (the cricket scripts,
   the transcript reconciler) using `<VAULT_DIR>`-relative paths rather than
   omitting those cron lines entirely. This preserves the full picture of
   what a real instance's crontab looks like (matching the source
   inventory's description of the crontab's full wiring) while being
   explicit, via inline comments, that those particular pieces aren't
   shipped here and are a user's own vault-side responsibility to write or
   adapt.
7. **`fix_terminal_auth.sh`'s persona-referencing line was reworded** rather
   than left naming a specific dev-partner persona, since that persona is a
   convention documented in this repo's own `CLAUDE.md` and available as a
   skill, but not guaranteed to be configured identically in every fork —
   the instruction reads correctly either way once generalized to "safe to
   remove it."
8. **This scrub log itself never quotes an actual scrubbed value** (real
   name, email, domain, IP, or username) — every entry above names the kind
   of value and where it appeared, per the instruction that this log record
   kinds, not secrets. Where the source material's own *filename* carried a
   real value (the apex-landing nginx config), that filename is described
   rather than quoted, both here and in the destination file's origin
   comment.

## Verification

- The mandated case-insensitive de-personalization sweep (real given name +
  surname, the real domain, the real email address, the vault's real
  absolute path, and the real home-directory path) run over every file added
  in this batch (`deploy/*`, the 13 new files in `scripts/`,
  `docs/SETUP-FULL.md`, and this log) → 0 hits after the fix recorded in
  judgment call 8 above (an earlier draft of this log itself had quoted
  several real values while describing what was scrubbed from the source
  scripts — caught by the same sweep it was documenting, and rewritten to
  describe kinds instead). The sweep pattern itself isn't reproduced
  literally in this sentence, to avoid this file matching its own
  verification command.
- `bash -n` on every migrated `.sh` file (14 files: `deploy/deploy-rust-
  door.sh` and 13 in `scripts/`) → all pass, 0 syntax errors.
- `chmod +x` applied to every migrated `.sh` file.
