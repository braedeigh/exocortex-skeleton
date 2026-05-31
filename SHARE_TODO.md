# Before this repo is safe to share publicly

This scaffold is **code only** (no data, fresh git history). It runs, but it still
carries personal and install-specific bits that must be cleaned before it's a real
shareable product. This file is the honest gap between "Bradie's app" and "an app
anyone can run."

## 1. Personal constants hardcoded in `server.py`
- `_common_data()` hardcodes milestone dates and labels: `days_clean` (2026-02-22),
  `days_prozac` (2026-04-01), `days_peptides` (2026-05-30), rendered in the morning
  header as "Day N off weed / of Prozac / on peptides."
  → Make these user-configurable (e.g. a `streaks.json` the user defines), or remove.

## 2. Install-specific values
- `mudscryer.org` is hardcoded as the public landing host (`server.py` LANDING_HOSTS,
  `public_config.py`), with a `mudscryer.html` landing page.
  → Make the domain an env var / config; ship a generic landing or none.

## 3. The big one — dependency on `../tulku/` (the personal keeper system)
Several routes read personal content directly from the sibling `tulku/` directory,
which a new user won't have:
- Habits: `tulku/HABITS.md`, `tulku/habits.csv`
- Journal: `tulku/Journal/Daily/*.md`
- Meetings: `tulku/meetings/`
- Public intro: `tulku/public_intro.md`
→ Decouple: move these into the app's own `DATA_DIR` (e.g. `data/habits.md`), or make
  the journal/meetings features optional. **This is the core "separate personal from
  build" work** — it's not just the JSON data files, the code itself reaches into the
  keeper system.

## 4. Feature assumptions to generalize (later / optional)
- HRT hardcodes `estradiol` injection — fine personally; generalize the med name for others.
- Deity-yoga meditation is niche but fully data-driven (empty for new users), so harmless.

## 5. First-run security
- `auth.json` auto-generates on first run with the password `exocortex`.
  → `DEPLOY.md` tells new users to change it immediately; keep that prominent.
