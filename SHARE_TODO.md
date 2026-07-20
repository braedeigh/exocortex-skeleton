# De-personalization status

This scaffold is **code only** (no data, fresh git history). Goal: anyone can run it
without it carrying the original author's personal/install-specific values.

**The rule going forward:** anything personal, install-specific, or a deployment
choice lives in **`config.py`** (env-overridable) or in a user **data file** — never
hardcoded in the app code.

## ✅ Done
- **Milestone streaks** (was hardcoded quit/med dates + "Day N off weed/Prozac/peptides")
  → now read from `data/streaks.json` (`{"streaks":[{"label","since"}]}`), empty by default.
- **Personal `tulku/` dependency** → all content (habits `HABITS.md`/`habits.csv`,
  journal `Journal/Daily`, `meetings/`, `public_intro.md`, personality) now lives under
  the user's own `DATA_DIR` via `CONTENT_DIR` (= `DATA_DIR`). No sibling-dir dependency.
- **App identity** (was a hardcoded owner name + domain) → `config.py`: `APP_NAME`,
  `OWNER_NAME` (blank = omitted), threaded into header/footer/title/login.
- **Personal landing page** (custom landing templates + host-based landing route) → removed.
- **First-run password** → `config.DEFAULT_PASSWORD` (env `EXOCORTEX_DEFAULT_PASSWORD`),
  documented to change on first login.
- **Data location** → already env-driven (`EXOCORTEX_DATA_DIR`) via `store.py`.
- **Journal card engine decoupled from the author's private vault** → the journal-day
  UI (`routes/cards.py`) shelled out to a `stream.py` that only ever existed in the
  author's personal vault, so a fresh install had no cards and no way to add one.
  Added `content-scaffold/` (the engine, a generic seed keeper `CLAUDE.md`, and empty
  `Journal/`/`keeper-diary/` dirs) plus `store.seed_content_scaffold()`, called on
  server boot, which copies it into a fresh `CONTENT_DIR` the first time
  (idempotent, never overwrites, and a no-op once a real `_system/stream.py`
  exists — so the author's own live vault is untouched). Generic `/journalstart` +
  `/endsession` slash commands and the capture-hook wiring ship in
  `claude-commands/` and `install.sh`.

- **Vault architecture migrated wholesale (2026-07-19, batches A–F)** → deploy/ops
  templates, cricket swarm, research-pipeline prompts, app agent workspaces,
  mailclaude, and the persona commands all copied from the private vault, scrubbed to
  the placeholder contract in `docs/PERSONALIZE.md`, every seam marked `PLUG-IN(...)`
  and recorded in `docs/SCRUB-LOG.md`.

Verified: boots on an empty data dir, all dashboard endpoints return 200, `APP_NAME`
flows into the UI.

## ⏳ Next (from the migration)
- **Setup UI + conversational setup agent** — first-run flow that fills the
  `docs/PERSONALIZE.md` entry points: a Setup page (plain form) and a conversational
  path that suggests values, staged through the pending-changes approval queue
  (`routes/pending.py`) so the AI never writes the profile directly. Both write one
  profile; templates render from it.
- **Generic `CLAUDE.md` split** — this repo's own `CLAUDE.md` is still written for the
  author's instance (her name, vault paths). For "download and Claude knows what to
  do," it needs an instance-agnostic core with the personal layer moved to the vault.
- **`docs/threads-architecture.md`** — the crickets (front-health, thread-scout,
  housekeep) cite it as design-of-record; it was never written. Extract from the
  vault's thread tooling docs.

## ⏳ Next candidates to move into `config.py` (still hardcoded, lower priority)
- **HRT/injection tracker** hardcodes the medication `estradiol` as an activity-type key
  in `routes_health.py` + the frontend + `public_config.py`. Generalizing the med name is
  a multi-file change (the *type key*, not just a label) — left for when it matters.
- **Symptom list** (energy, brain fog, etc.) hardcoded in `static/js/health.js`.
- **FOOD_GUIDE** + default **kitchen category order** hardcoded in `server.py`.
- **Base activity-type colors** (`ACT_TYPES`) + theme accents in the JS/CSS.

These are content/feature defaults rather than personal data, so they're safe to ship as
defaults — but they're the natural next things to lift into `config.py` (or a config file)
so each install can override them.
