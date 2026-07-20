# Batch E scrub log — mailclaude

Source: `personal vault mailclaude/` (read-only). Destination:
`skeleton/agents/mailclaude/`. Copy, not move; vault untouched.

Placeholder legend: `<APP_USER>` (Linux user who owns corpus/clerk dirs),
`<OWNER_NAME>` (human the clerk drafts replies for), `<OWNER_EMAIL>` (the
one address the bot ever sends to), `<SRV_DIR>` (base install path, default
`/srv/mailclaude` kept literal per migration instructions rather than forced
to a placeholder — see note at bottom).

## Files

### install.sh
Origin: `mailclaude/install.sh` → Dest: `agents/mailclaude/install.sh`
- Scrubbed: Linux username (system account that owns corpus/clerk dirs),
  appeared as `chown`/`install -o` owner in ~8 spots.
  Placeholder: `<APP_USER>` handling — replaced with `APP_USER` shell
  variable, default `${MAILCLAUDE_APP_USER:-${SUDO_USER:-$(id -un)}}`.
  Plug-in: set `MAILCLAUDE_APP_USER=youruser` before running, or just run
  with `sudo` as the intended owner and the default picks it up.
- Scrubbed: base install path literal `/srv/mailclaude` (repeated
  throughout). Placeholder: `<SRV_DIR>` concept — implemented as `BASE`
  shell variable, default `${MAILCLAUDE_BASE:-/srv/mailclaude}`.
  Plug-in: set `MAILCLAUDE_BASE` to relocate; must also hand-edit the
  systemd units and `clerk/.claude/settings.json` (see bottom note).
- Scrubbed: dangling reference to a private vault doc
  (`personal/docs/mail-claude-setup.md`) for manual hardening steps.
  Placeholder: none (not a personal value) — reworded to point at this
  repo's own README.md instead, since the vault doc won't ship with the
  skeleton copy.
  Plug-in: write your own deployment runbook for sshd/firewall/Tailscale-
  equivalent steps; the README's numbered list covers what install.sh
  doesn't automate.

### README.md
Origin: `mailclaude/README.md` → Dest: `agents/mailclaude/README.md`
- Scrubbed: person name (the owner's given name) in "email to <owner>" /
  recipient framing.
  Placeholder: `<OWNER_NAME>` is implied via the "the owner" phrasing
  (README is prose, not a fill-in form, so no literal `<OWNER_NAME>` token
  was needed here — `clerk/CLAUDE.md` and `send-to-owner.py` carry the
  literal placeholder/env var).
  Plug-in: n/a (no owner-specific value actually appears in this file after
  scrubbing).
- Scrubbed: SSH example using the owner's Linux username as the login user
  and a Mac-specific Tailscale hostname. Placeholder: `<APP_USER>@<your-host>`.
  Plug-in: substitute your own deploy user and host/Tailscale name.
- Scrubbed: reference to vault-only setup doc and Mac-specific framing
  ("the Mac"). Generalized to "the target host"; expanded with an added
  "privilege-separation design" section documenting the architecture (no
  personal content, pure architecture writeup, added for shareability).
- Renamed all references to the old owner-named script filename to
  `send-to-owner.py` in the file listing and flow notes.

### clerk/CLAUDE.md
Origin: `mailclaude/clerk/CLAUDE.md` → Dest: `agents/mailclaude/clerk/CLAUDE.md`
- Scrubbed: person name (the owner's given name) in "already emailed to
  <owner>", "claims to be from <owner>", "<owner> reads the draft"
  (3 occurrences).
  Placeholder: `<OWNER_NAME>` (literal, inline).
  Plug-in: replace `<OWNER_NAME>` throughout with the actual person/role
  name before deploying — this file ships to `<SRV_DIR>/clerk/CLAUDE.md` and
  is read directly by the clerk, so the placeholder must be resolved, not
  left as an env var.
- Scrubbed: base path literal `/srv/mailclaude` (3 occurrences).
  Placeholder: `<SRV_DIR>` (literal, inline — this is a doc read by the
  clerk model itself, not a script, so no env var applies).
  Plug-in: replace `<SRV_DIR>` with your actual install path (or leave as
  `/srv/mailclaude` if using the default).

### clerk/.claude/settings.json
Origin: `mailclaude/clerk/.claude/settings.json` → Dest:
`agents/mailclaude/clerk/.claude/settings.json`
- No scrubbing performed — copied byte-for-byte per instructions ("preserve
  its deny/allow lists exactly"). JSON has no comment syntax, so no header
  or inline PLUG-IN markers were added to this file.
- Note: paths inside (`/srv/mailclaude/...`) are the `<SRV_DIR>` default,
  kept literal. Recorded here since it couldn't be recorded inline: if you
  relocate the install base, this file's 11 path entries must be edited by
  hand to match, or the sandbox will allow/deny the wrong paths.

### bin/poll-mail.py
Origin: `mailclaude/bin/poll-mail.py` → Dest:
`agents/mailclaude/bin/poll-mail.py`
- Scrubbed: base path literal `/srv/mailclaude`. Placeholder: `<SRV_DIR>`
  concept — implemented as `BASE = os.environ.get("MAILCLAUDE_BASE",
  "/srv/mailclaude")`.
  Plug-in: set `MAILCLAUDE_BASE` env var to relocate.
- Docstring config-path comment updated from literal `/srv/mailclaude` to
  `<SRV_DIR>` for readability; no functional change.
- No secrets present (docstring only shows the `.example` shape, which was
  already generic — left as-is).

### bin/draft-runner.sh
Origin: `mailclaude/bin/draft-runner.sh` → Dest:
`agents/mailclaude/bin/draft-runner.sh`
- Scrubbed: base path literal `/srv/mailclaude`. Placeholder: `<SRV_DIR>`
  concept — implemented as `BASE="${MAILCLAUDE_BASE:-/srv/mailclaude}"`.
  Plug-in: set `MAILCLAUDE_BASE` env var to relocate.

### bin/<owner-named original> → bin/send-to-owner.py (renamed)
Origin: `mailclaude/bin/` (the owner-named original filename in the vault) →
Dest: `agents/mailclaude/bin/send-to-owner.py`
- Scrubbed: real personal email address (the owner's actual Gmail address),
  hardcoded as the `TO` constant with an explicit code comment saying it's
  intentionally not configurable. Placeholder: `<OWNER_EMAIL>` — implemented
  as `TO = os.environ.get("MAILCLAUDE_OWNER_EMAIL", "<OWNER_EMAIL>")`,
  preserving the original invariant-comment intent (recipient not sourced
  from config/draft data) while making the value itself deploy-time
  configurable instead of a real address baked into shared code.
  Plug-in: set `MAILCLAUDE_OWNER_EMAIL` env var at deploy time, or edit the
  default in this file directly — either way keep it out of `secrets/*.json`
  and draft records, per the file's own invariant comment.
- Scrubbed: base path literal `/srv/mailclaude`. Placeholder: `<SRV_DIR>`
  concept — implemented as `BASE = os.environ.get("MAILCLAUDE_BASE",
  "/srv/mailclaude")`.
- File renamed per migration instructions; every reference to the old
  filename updated in `install.sh`, `README.md`, and
  `systemd/mail-send.service`.

### bin/session.sh
Origin: `mailclaude/bin/session.sh` → Dest:
`agents/mailclaude/bin/session.sh`
- Scrubbed: base path literal `/srv/mailclaude`. Placeholder: `<SRV_DIR>`
  concept — implemented as `BASE="${MAILCLAUDE_BASE:-/srv/mailclaude}"`.
  Plug-in: set `MAILCLAUDE_BASE` env var; also update the sshd
  `ForceCommand` invocation on the host to reference the same path if
  hardcoded there.

### systemd/mail-draft.path, mail-draft.service, mail-poll.service,
### mail-poll.timer, mail-send.service, mail-send.timer
Origin: `mailclaude/systemd/*` → Dest: `agents/mailclaude/systemd/*`
- Scrubbed: base path literal `/srv/mailclaude` in `ExecStart=`/
  `DirectoryNotEmpty=` lines (mail-draft.path, mail-draft.service,
  mail-poll.service, mail-send.service — 4 files, 4 path lines total).
  Placeholder: `<SRV_DIR>` — kept as a **literal default path**, not a
  `<SRV_DIR>` token, per explicit migration instruction ("keep the default
  but note `<SRV_DIR>` plug-in"). A `# PLUG-IN(SRV_DIR)` comment was added
  above each affected line instead, since systemd unit files can't read
  shell env vars set by install.sh — relocating the base dir means
  hand-editing these units. (mail-poll.timer, mail-send.timer have no paths,
  no scrubbing needed.)
- Scrubbed: `mail-send.service` `ExecStart=` updated from the old
  owner-named script filename to `send-to-owner.py`, and its `Description=`
  changed from "email drafts to <owner's given name>" to "email drafts to
  the owner" (person name removed).
- `User=`/`Group=` values (`mail`, `mailer`, `mailroom`) are architecture
  constants created generically by `install.sh`, not personal to the
  original owner — left as-is, no placeholder needed.

### secrets/imap.json.example, secrets/smtp.json.example
Origin: `mailclaude/secrets/*.example` → Dest:
`agents/mailclaude/secrets/*.example`
- No scrubbing — copied byte-for-byte. Confirmed already generic
  (`imap.example.com`, `box@example.com`, `app-password-here`) per the
  batch's audit note; instructions say keep `.example` templates as-is.
  JSON has no comment syntax, so no header comment was added (origin/dest
  recorded here instead).

## Judgment calls

1. **`<SRV_DIR>` handling is split by file type**, matching the shared
   placeholder contract: shell/python scripts got an env-var-overridable
   `BASE` constant (`MAILCLAUDE_BASE`, default `/srv/mailclaude`); systemd
   units and `clerk/.claude/settings.json` kept the literal default path
   (units can't read the scripts' env var, and the settings.json deny/allow
   list had to be preserved exactly) with `PLUG-IN(SRV_DIR)` comments added
   wherever the format allows (not in the JSON file). This was called out
   explicitly in the task brief ("/srv/mailclaude paths — keep the default
   but note `<SRV_DIR>` plug-in") as the resolution for what would otherwise
   read as a conflict with the general "configs use literal placeholders"
   rule.
2. **`<APP_USER>` vs `<OWNER_NAME>`/`<OWNER_EMAIL>` are treated as distinct
   concepts.** `<APP_USER>` is the Linux system account that owns
   corpus/clerk directories on disk (an install-time detail, scrubbed in
   `install.sh` and `README.md`'s scp example). `<OWNER_NAME>`/
   `<OWNER_EMAIL>` are the human the bot answers on behalf of (scrubbed in
   `clerk/CLAUDE.md` and `send-to-owner.py`). In the original these were the
   same physical person (the vault owner), but the architecture doesn't
   require that, so they were kept as separate plug-in points.
3. **`send-to-owner.py`'s literal-constant invariant was preserved, not
   removed.** The original code comment insists the recipient must never be
   config- or draft-driven, for security reasons (a hijacked clerk shouldn't
   be able to redirect mail). Rather than moving `TO` into `secrets/*.json`
   (which the clerk cannot read but which is still "config"), it stays a
   Python-level constant with an env-var default — preserving the original
   security property while removing the real address.
4. **README.md gained a new "privilege-separation design" section** not
   present in the vault original (which was terser, written for one
   operator following a companion setup doc that isn't migrating). Since
   this migration's stated goal is to "preserve the privilege-separation
   design and its documentation faithfully — that's the architecture being
   shared," and the skeleton copy won't ship with
   `personal/docs/mail-claude-setup.md`, I added a self-contained
   explanation of the three-identity model and the two independent locks so
   the architecture is legible without that missing doc. No personal
   content was introduced.
5. **Excluded `bin/__pycache__/*.pyc`** — build artifacts, not source; not
   in the migration file list and would embed stale bytecode (including of
   the pre-rename, owner-named script).
6. **`personal/docs/mail-claude-setup.md` references removed/reworded**
   rather than migrated — it wasn't in this batch's file list, so
   `install.sh` and `README.md` now point at README.md's own manual-steps
   list and "your own deployment runbook" instead of a doc that won't exist
   in the skeleton repo.

## Verification

- Required de-personalization sweep over `agents/mailclaude/` and this log
  file → 0 hits. (The exact grep pattern isn't quoted literally in this
  sentence, to avoid the log file matching its own verification command.)
- `bash -n` on all 3 `.sh` files → all pass.
- `python3 -m py_compile` on both `.py` files → both pass.
