# Exocortex

A personal life + health dashboard you shape by talking to it. Track what *you* care
about — habits, symptoms, food, meds, reminders, money, whatever — on one self-hosted
page. Built to run on your own VPS so your data stays yours.

The idea: instead of a fixed app, you describe what you want to keep track of and the
interface builds out from a small set of reusable pieces (logged events, lists,
recurring reminders, calendars, counters). Self-hosted, single-user, your data in
plain JSON files you own.

## Run your own
On your own computer: **[INSTALL.md](INSTALL.md)** — `./install.sh` and you're running.
On a public server (domain + HTTPS): **[DEPLOY.md](DEPLOY.md)** — written so an AI
agent (Claude Code) can provision a VPS for you with minimal input.

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
