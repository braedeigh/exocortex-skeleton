# Exocortex — app code (Spark / skeleton repo)

This is the **app code** (this repo, `/opt/exocortex/skeleton`, remote `exocortex-skeleton`): the live Flask site run by gunicorn (`server:app`). It's the shareable "skeleton" — generic, carries **no personal data**. Personal data + content are **her files**, in the separate vault repo `/opt/exocortex/personal` (remote `exocortex-personal`), wired in via `EXOCORTEX_DATA_DIR` / `EXOCORTEX_CONTENT_DIR`. **Code goes here; her files go there — never mix them.** See `/opt/exocortex/personal/RESTORE.md` for the full wiring, and `/opt/exocortex/personal/CLAUDE.md` for who Bradie is and the overall system. The live app is always `/opt/exocortex/skeleton` — there are no other working copies to confuse it with.

## Working here
- After **Python** edits: `sudo systemctl restart exocortex.service`. Static files (JS/CSS) and templates reload on refresh — no restart.
- Data layer goes through `store.py` (atomic JSON I/O, `EXOCORTEX_DATA_DIR`). Routes live in `server.py` + the `routes/` package (each module exposes `register(app)`, wired up at the bottom of `server.py`); frontend is vanilla JS in `static/js/` rendered into `templates/`.
- Build/dev TODO list: `dev_todo.md`.
- **Don't use the harness auto-memory store** (`~/.claude/.../memory/`). Bradie doesn't want a hidden memory context loading into her sessions (her call — same rule the Keeper follows). If something's worth persisting, talk to her and write it into a project markdown she owns (these `CLAUDE.md` files, `RESTORE.md`, `docs/IDEAS.md`, `tulku/` protocol files) — never the harness store.

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

## Testing

Tests live in `tests/` and run with **pytest** (a dev-only dep — `./venv/bin/pip install -r requirements-dev.txt`). Config is in `pytest.ini`.

```
./venv/bin/python3 -m pytest          # run everything
./venv/bin/python3 -m pytest tests/test_todos_routes.py -q
./venv/bin/python3 -m pytest -k toggle      # by name
```

**Write a test whenever you touch behavior that can silently break** — a route's contract, a data migration, or the `store` layer. New `routes/` endpoint → add a route test. Bug fix → add a test that fails before the fix and passes after. Don't chase coverage of trivial rendering glue.

**How tests are structured here** (mirror this):

- **Isolated data, always.** Everything reads/writes JSON through `store.py`, which resolves `store.DATA_DIR`. The `data_dir` fixture (`tests/conftest.py`) monkeypatches `store.DATA_DIR` to a fresh pytest `tmp_path` per test — so tests never touch real data and never collide. Any fixture/test that hits the store must depend on `data_dir` (directly or via `seed`/`client`).
- **Test routes against a *minimal* app, not `server.py`.** The `client` fixture builds a bare `Flask` app and calls only `todos.register(app)` (via `from routes import todos`). This skips `server.py`'s startup, the auth `before_request` gate, and unrelated data loads — tests stay fast and focused on the handler under test. (If you ever need the auth gate in a test, set it with `client.session_transaction()`.)
- **Three layers, three files** — copy the nearest one:
  - `test_store.py` — the atomic JSON layer (round-trip, default-on-missing, `mutate` persists but rolls back on exception).
  - `test_todos_data.py` — pure data helpers (id back-fill, section mapping, the auto-sort vs `manual_order` logic in `todos_to_sections`).
  - `test_todos_routes.py` — the HTTP contract: `seed(...)` a starting state, POST JSON, assert the persisted result via `conftest.read_todos()`.
- **Identity is by `id`.** To-dos are matched by stable `id` (text is a legacy fallback). Tests assert that same-text items stay independent and that the text fallback still works — keep that guarantee when extending routes.
- **Name tests for the behavior**, not the function (`test_toggle_disambiguates_same_text`), and keep each test to one assertion of intent.

*(Adapting conventions from Bradie's Elixir `CLAUDE.md` — to be folded in once uploaded.)*
