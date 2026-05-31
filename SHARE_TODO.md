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

Verified: boots on an empty data dir, all dashboard endpoints return 200, `APP_NAME`
flows into the UI.

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
