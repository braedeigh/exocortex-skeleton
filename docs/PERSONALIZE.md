# Personalizing your exocortex

Everything in this repo that was extracted from the original author's instance has had
the personal values replaced with a **single placeholder vocabulary**. This page is the
contract: what each placeholder means, where it appears, and how to plug in your own
value. Every scrubbed seam in the tree is marked inline with a `PLUG-IN(<KEY>): ...`
comment; `docs/SCRUB-LOG.md` indexes every file that was scrubbed and what was removed.

These entries are also the **profile entry points** for the planned setup flow: a
first-run Setup page (form) and a conversational setup agent will both write the same
profile, the conversational one staging its suggestions through the app's
pending-changes approval queue (`routes/pending.py`) for you to approve. Until that
exists, personalization is: search for the placeholder, plug in your value.

## The profile entry points

| Key | Meaning | Where it's used | How to set it |
|---|---|---|---|
| `<OWNER_NAME>` | Your display name | app header/title, agent prompts, systemd env | env `EXOCORTEX_OWNER_NAME` (config.py); literal in templates |
| `<OWNER_EMAIL>` | Your email | certbot expiry notices, git backup identity, mailclaude | env `EXOCORTEX_GIT_EMAIL` / edit templates |
| `<APP_DOMAIN>` | Your public domain | nginx templates, exo.toml `public_origin`, ssl scripts | edit `deploy/*.template`; env `EXOCORTEX_APP_DOMAIN` in scripts |
| `<APP_USER>` | Linux account running it all | systemd units, hardening script, mailclaude install | edit templates; env `EXOCORTEX_APP_USER` in scripts |
| `<SKELETON_DIR>` | Where this repo is cloned | cron template, agent prompts, runner scripts | env `EXOCORTEX_SKELETON_DIR` (scripts default `/opt/exocortex/skeleton`) |
| `<VAULT_DIR>` | Your private data/content repo | agent prompts, workspace sandboxes, cron, backup | env `EXOCORTEX_VAULT_DIR`; also `EXOCORTEX_DATA_DIR`/`EXOCORTEX_CONTENT_DIR` for the app itself |
| `<SRV_DIR>` | Service state root (`/srv/...`) | mailclaude, rust-door deploy, proxy secret | env `MAILCLAUDE_BASE`; edit templates |
| `<TMUX_SOCKET>` | Shared tmux socket path | terminal integration, keeper rollover, ttyd | env `EXOCORTEX_TMUX_SOCKET`; edit `exocortex-tmux.service.template` |

Convention: **shell scripts** read env vars with sane defaults, so they run unedited
once the env is set (the systemd/cron templates set it). **Templates and prompts**
(`*.template`, agent `CLAUDE.md`s) carry the literal `<...>` tokens — copy, then
substitute. **The app itself** reads the `EXOCORTEX_*` env vars via `config.py` and
`store.py` — no placeholders in app code.

## Beyond the eight keys

Some migrated pieces have richer plug-ins than a single value — each is marked in
place and detailed in its scrub-log entry:

- **Cricket schemas** (`agents/crickets/examples/`) — replace the example symptom/
  people schemas with the fields *you* track; roster ships with these off.
- **Persona plug-ins** (`claude-commands/`) — `/spark` and `/thistle` have project-
  reference plug-in sections; `examples/terra.md` needs your own bedrock/values doc;
  `examples/gardener.md` needs a domain you actually know and love.
- **The keeper seed** (`content-scaffold/CLAUDE.md`) — has a marked "Who you're
  keeping for" section; the journal works before you fill it in, but the keeper is
  generic until you do.
- **mailclaude** (`agents/mailclaude/`) — copy `secrets/*.example` without the
  `.example` suffix and fill in real IMAP/SMTP credentials (never commit those).
