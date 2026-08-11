# Exocortex — app code (skeleton repo)

This is the **app code** (remote `exocortex-skeleton`): a Flask site run by gunicorn (`server:app`). It's the shareable "skeleton" — generic, carries **no personal data**. The owner's data + content live in a **separate private vault** repo, wired in via `EXOCORTEX_DATA_DIR` / `EXOCORTEX_CONTENT_DIR`. **Code goes here; the owner's files go there — never mix them.** Anything personal, install-specific, or a deployment choice belongs in `config.py` (env-overridable), a data file under `EXOCORTEX_DATA_DIR`, or the gitignored `CLAUDE.local.md` / `frontend/.env.local` — never hardcoded in app code. Instance-specific paths and context live in `CLAUDE.local.md` (auto-loaded, not committed).

## Working here
- After **Python** edits: **`sudo systemctl reload exocortex.service`** — never `restart`. Reload SIGHUPs the gunicorn master, which boots fresh workers on the new code and drains the old ones. **`restart` SIGTERMs the whole service cgroup, and agent turns live in that cgroup** (`routes/observatory.py` spawns each `claude -p` as a child of a worker), so a routine restart kills every session running on the box — measured across the transcripts: 59 turns killed by restart, 1 by reload. Use `restart` ONLY for changes to the unit file, an `Environment=` line, or anything read at gunicorn master start. If this install has no reload path, see `deploy/` for the drop-in that adds one. After **frontend** edits: `cd frontend && npm run build` (vite → `frontend/dist/`), then refresh — no restart, no reload.
- **Commit when a thing ships.** This repo gets deliberate, named commits — one per feature/fix/refactor, message saying what changed and why. Uncommitted work here may have no backup safety net: don't end a session with finished work sitting uncommitted.
- Data layer goes through `store.py` (`EXOCORTEX_DATA_DIR`). Collections in `SQL_COLLECTIONS` dispatch to `sqlstore.py`: SQLite (`exo.db`) is the database of record, and the JSON files are one-way export mirrors — never read back, so **never write them directly** for SQL-backed collections. Routes live in `server.py` + the `routes/` package (each module exposes `register(app)`, wired up at the bottom of `server.py`). The frontend is a React SPA in `frontend/src/` (feature modules under `src/features/`, TanStack Router), built to `frontend/dist/` and served by `routes/spa.py`. Only `/login` is still server-rendered (`templates/login.html`).
- **Don't use the harness auto-memory store** (`~/.claude/.../memory/`). The owner shouldn't get a hidden memory context loading into sessions. If something's worth persisting, talk to them and write it into a project markdown they own — never the harness store.
- `tools/stream/` is the journal engine (card-pool spine `stream.py`, capture hook `keeper_capture.py`, reconciler `reconcile_transcripts.py`). Root resolved lazily via `TULKU_STREAM_ROOT` or `EXOCORTEX_CONTENT_DIR`; a vault may keep exec-only shims at its old `_system/` paths for existing callers.

## Plain-language layer (the code explains itself, in plain English)
This codebase is **bilingual**: plain-English explanation lives *inside* the files as a first-class layer, so the owner — who doesn't live deep in code — can open any file and read it like a notebook. Follow this whenever you write or change code:

- **New file → a top-of-file block in plain English:** what this file does and which other files it touches. Enough to *get it*, not a totalizing spec.
- **Touch a file that has no block → add one.** If you edit any code file that's missing its top-of-file plain-English block, write one as you pass through. That's how the whole codebase gets covered over time — file by file, as they're touched.
- **Meaningful code → an inline note in plain English, present tense** — what a chunk does / why it's this way, right at the spot. Renames, typos, and trivial glue don't earn a note (same bar as "when do you write a test").
- **Bake in the prompt that produced it**, verbatim where possible, next to what it made (file-level prompt in the top block; a spot-level prompt inline). **Strip anything personal** — health, relationships, names, life detail — so this repo stays shareable; keep only the technical ask. Distill a mostly-personal prompt down to its technical rider.
- **Overwrite, never accumulate.** These notes are *present tense*, not a changelog. Edit a spot again → **delete the old note and its prompt, write the new one.** Only ever one note per spot, always describing the code as it is *now* — no history piles up in the body, nothing to prune.
- **Cross-file stuff goes in a doc, linked — not smeared across files.** A decision spanning many files, a procedure, or the history the overwrite rule can't keep, lives in a short markdown beside the code; the file's block just links to it. In-file notes stay local and present-tense.
- **The note must never lie.** A confident English sentence sitting next to code that no longer matches it is *worse* than no note — the owner reads the English, not the code, and a stale note walks her (and the next Claude) straight into a bug. **Never claim more certainty than the code earns:** where you only honestly know a region, say a region, plainly. Overwrite means overwrite. This honesty is the whole point.

Reference examples: `frontend/src/features/todos/reminderMath.ts` (block added from scratch) and `frontend/src/features/journal/calendarMath.ts` (a developer block rewritten into this style).

## UI guidelines (firm defaults)
Build **touch-first and legible**. These are defaults, not suggestions:

- **Tap targets ~40px tall.** Anything interactive — buttons, toggles, list rows, chips, icon buttons — should be about 40px tall whenever layout allows. Err toward bigger.
- **No text below 12px** unless absolutely necessary. Default body text comfortably larger.
- **Icon / × / delete buttons must be clearly visible** — not faint, not tiny, with a comfortable hit area; don't pair them with sub-12px labels.
- Favor **legibility and comfortable hit areas over compactness**, especially on mobile/PWA.
- **"Small until edit":** when compact view and big targets conflict, keep controls small in the normal view and grow them to ~40px in edit mode (`.card.editing` enlarges `.delete-btn` / `.drag-handle` / `.todo-note-btn`).

## UI patterns to stay consistent with
- **Card = the view; title-line button = edit/manage; modal = focused editing.** Cards are collapsible with a chevron and remember open/closed state in localStorage (see e.g. `frontend/src/features/body/CollapsibleCard.tsx`, `lifemap/MapCard.tsx`).
- Destructive actions confirm first.
- Theme: light = lavender-grey (`postDawn`), dark = indigo (`twilight`), with an Auto mode keyed to the owner's-city sunrise/sunset (`frontend/src/theme/`; coordinates from `frontend/.env.local` via `src/ownerHome.ts`).

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
