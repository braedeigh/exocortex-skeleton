# Exocortex — app code (Spark / skeleton repo)

This is the **app code**: the live Flask site run by gunicorn (`server:app`). It's the shareable "skeleton" — generic, carries **no personal data**. Personal data + content live in the vault repo `/opt/exocortex` (wired in via `EXOCORTEX_DATA_DIR` / `EXOCORTEX_CONTENT_DIR`). See `/opt/exocortex/RESTORE.md` for the full wiring, and `/opt/exocortex/CLAUDE.md` for who Bradie is and the overall system.

## Working here
- After **Python** edits: `sudo systemctl restart exocortex.service`. Static files (JS/CSS) and templates reload on refresh — no restart.
- Data layer goes through `store.py` (atomic JSON I/O, `EXOCORTEX_DATA_DIR`). Routes live in `server.py` + `routes_*.py`; frontend is vanilla JS in `static/js/` rendered into `templates/`.
- Build/dev TODO list: `dev_todo.md`.

## UI guidelines (firm defaults — from Danielle, her designer friend)
Build **touch-first and legible**. These are defaults, not suggestions:

- **Tap targets ~40px tall.** Anything interactive — buttons, toggles, list rows, chips, icon buttons — should be about 40px tall whenever layout allows. Err toward bigger.
- **No text below 12px** unless absolutely necessary. Default body text comfortably larger.
- **Icon / × / delete buttons must be clearly visible** — not faint, not tiny, with a comfortable hit area; don't pair them with sub-12px labels.
- Favor **legibility and comfortable hit areas over compactness**, especially on mobile/PWA.
- **"Small until edit":** when compact view and big targets conflict, keep controls small in the normal view and grow them to ~40px in edit mode (`.card.editing` enlarges `.delete-btn` / `.drag-handle` / `.todo-note-btn`).

## UI patterns to stay consistent with
- **Card = the view; title-line button = edit/manage; modal = focused editing.** Cards are collapsible `<details class="map-section kitchen-section">` with a `kitchen-arrow` chevron; `data-default-open` controls default state; open/closed is remembered per `data-card` in localStorage.
- Destructive actions confirm first (the `confirmDelete` / `#modal` flow).
- Theme: light = lavender-grey (`postDawn`), dark = indigo (`twilight`), with an Auto (Austin sunrise/sunset) mode — see `static/js/sky-theme.js`.
