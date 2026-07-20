# Exocortex

A personal life + health dashboard you shape by talking to it. Track what *you* care
about — habits, symptoms, food, meds, reminders, money, whatever — on one self-hosted
page. Built to run on your own VPS so your data stays yours.

The idea: instead of a fixed app, you describe what you want to keep track of and the
interface builds out from a small set of reusable pieces (logged events, lists,
recurring reminders, calendars, counters). Self-hosted, single-user, your data in
plain JSON files you own.

## Just downloaded this?
The repo is written to guide you (and your AI) through its own setup:

1. **On your own computer:** **[INSTALL.md](INSTALL.md)** — `./install.sh` and you're
   running. **On a Mac** (Apple Silicon, incl. always-on via launchd + Tailscale):
   **[docs/SETUP-MACOS.md](docs/SETUP-MACOS.md)**. **On a public server** (domain +
   HTTPS): **[DEPLOY.md](DEPLOY.md)**; the full always-on machine build (systemd,
   nginx, cron, agents) is **[docs/SETUP-FULL.md](docs/SETUP-FULL.md)**.
2. **Have Claude do it with you:** open Claude Code at this repo's root and run
   **`/onboard`** — a first-session guide that installs if needed, interviews you,
   and stages your profile through the approval queue (or just say "set this up
   for me"). Afterward, **`/help`** answers "what does this page do / where does
   this live" any time. The docs above are written for an AI agent to execute —
   they, plus [docs/PERSONALIZE.md](docs/PERSONALIZE.md) and
   [docs/SCRUB-LOG.md](docs/SCRUB-LOG.md), tell it everything it needs to know.
3. **Make it yours:** every personal value is a marked placeholder —
   [docs/PERSONALIZE.md](docs/PERSONALIZE.md) is the contract (name, domain, paths,
   plug-in schemas). A first-run Setup page + conversational setup agent that fill
   these in for you are planned; today it's find-the-placeholder.

## What's in the box (beyond the app)
- `deploy/` — systemd/nginx/cron templates for an always-on server
- `scripts/` — ops + automation (backup, keeper rollover, cricket runners, research dispatch)
- `agents/` — the agent layer: nightly **crickets**, the **research pipeline** roles,
  app-embedded workspaces (person-summary, triage, receipts, recipes), and
  **mailclaude** (a privilege-separated email-answering bot)
- `claude-commands/` — `/journalstart`, `/endsession`, `/thread`, `/spark`, `/thistle`
  (+ example personas), auto-linked as project commands
- `content-scaffold/` — the journaling engine + seed keeper persona, self-seeded into
  your data dir on first boot

## Status
This is an early scaffold extracted from the author's personal instance. Before it's a
clean general-purpose app, the items in **[SHARE_TODO.md](SHARE_TODO.md)** need doing
(de-personalizing hardcoded values, decoupling from the author's journal system).

## Architecture in one breath
Flask + gunicorn backend, vanilla-JS frontend, all data as JSON behind `store.py` (one
atomic read/write seam, `EXOCORTEX_DATA_DIR`-relocatable — the on-ramp to a database
later). Routes are split per feature in the `routes/` package, each module exposing a
`register(app)` wired up in `server.py`.

Installable as a PWA — `static/manifest.json` + a network-first service worker
(`static/sw.js`, online-fresh with offline fallback) + app icons, so it adds to your
phone's home screen and runs full-screen.

## Journaling
The day-view journal (cards) works right out of the box — a fresh install seeds
itself a small deterministic card engine and a generic keeper persona on first boot.
See [INSTALL.md](INSTALL.md#journaling) for the details, including optional
Claude Code integration.
