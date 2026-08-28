# compost-pile-2026-08-27  —  shed 2026-08-27

Five dashboard tabs set down together, in one folder, under the name the owner gave the
pile. They come back together too (`/shed restore compost-pile-2026-08-27`).

## What this was
Five sub-tabs of the Dashboard, each a page with its own little API:

- **Car** — a maintenance log (oil changes, tires, dates, cost) and a notes card. Lived
  under More ▾ as "Car Maintenance".
- **Movement** — exercise routines you could open, edit, and run through. An optional tab.
- **Housing** — the place-hunting board: candidate places as cards with a status ladder
  (looking → applied → …) and notes. Lived under More ▾.
- **Travel** — trips, each with a packing list drawn from the real inventory, with
  "packed" checkboxes and a reckoning at the end. Lived under More ▾.
- **Meditation** — a sit log with a timer card, a compose cell for entries, and the deity
  profiles view/editor. An optional tab.

## Where it lived
For each of car, movement, housing, travel, meditation:
- `frontend/src/features/<name>/`          (the page and its helpers + their vitest files)
- `frontend/src/routes/<name>.tsx`         (the SPA route that mounted it at /<name>)
- `routes/<name>.py`                       (the API behind it)
- `tests/test_<name>_routes.py`            (movement, housing, travel only — car and
                                            meditation never had route tests)
- `server.py.compost-pile.py` (here)       the sections cut out of `server.py`: the
  `_load_car / _load_car_notes / _load_meditation / _load_deity_profiles /
  _load_meditation_notes / _load_movement` helpers, the `/api/data/car|housing|
  meditation|movement` payload endpoints, and the five `<name>.register(app)` lines.

Everything is here at the same relative path it had in the tree, moved with `git mv`, so
`git log --follow` still reads its history.

## Why it was set down
Owner, 2026-08-27, on the survey: "Shed the ones unmarked. Calling this the compost pile."
Ecosystem, Money, Ideas and Media from the same survey she marked **Keep**.

## What the signals said
Usage collection started 2026-07-20; window surveyed 2026-07-20 .. 2026-08-27 (38 days).
- **Used:** Car 0 visits · Movement 0 · Housing 0 · Travel 0 · Meditation 1. Zero API hits
  on all five route modules; zero store reads/writes on their collections.
- **Modified:** last substantive commits — Car 2026-06-11, Movement 2026-06-11, Meditation
  2026-06-11, Housing 2026-07-01, Travel 2026-07-17 (built that day, never touched again);
  all by the owner. The 2026-07-14 commit on most of them was an app-wide wording sweep,
  not work on the feature. No agent session has ever read or written any of the five
  (code-history `session_files` table).
- **Reachable:** all five were fully wired — registered in `server.py`, a SPA route each,
  listed in `tabs.ts` and the More ▾ / optional tab row in `TopTabs.tsx`. No feature flag
  gated any of them. Nothing else in the tree imported them (Travel's `useTravelData.ts`
  mentions Car only in a comment).

## Unwired
- `server.py`: the five names removed from the `from routes import (...)` list; six
  `_load_*` helpers, four `/api/data/<tab>` handlers and five `register(app)` lines
  removed — all saved verbatim in `server.py.compost-pile.py` with a header on each
  block saying where it sat. A scar note sits above `_load_media()`.
- `frontend/src/shell/tabs.ts`: `car`, `meditation`, `movement`, `housing`, `travel`
  removed from `VALID_TABS`, `TAB_META` and `TAB_ROUTES`.
- `frontend/src/shell/TopTabs.tsx`: `meditation` and `movement` removed from
  `OPTIONAL_TABS`; the `travel`, `housing`, `car` entries removed from `ALWAYS_MORE_TABS`.
- `tests/test_spa_routes.py`: `/car /meditation /movement /housing /travel` removed from
  the list of SPA paths expected to serve the app shell.
- `frontend/src/shell/panels/sections.test.ts`: the one assertion that used `/travel` as
  its example dashboard path now uses `/money`.

**Left as it was, on purpose:** `routes/shell.py` still lists the five in its own
`VALID_TABS` and still redirects old deep links (`/dashboard/travel` → `/travel`,
`/car-maintenance` → `/dashboard/car`). Those now land on the SPA's not-found page.
Its comment says to keep it in step with `tabs.ts`; it was left alone so the restore is
one folder and two shell files, not three — tidy it if the pile ever goes to burn.

## Data it read
**Removed at the owner's request, 2026-08-27** ("I want them out"), *after* the code was shed.
Exported first to the vault at `personal/reference/compost-pile-2026-08-27/` (one JSON per
collection, plus a README), then deleted from `exo.db` (`docs` rows) and `data/*.json`:
`car_maintenance` (4 entries), `car_notes`, `deity_profiles` (1), `meditation_log`,
`meditation_notes`, `movement` (1 routine), `housing` (1 place), `trips` (1 trip).
`travel_templates` never existed. Travel also *read* `active_inventory` and `archivals`,
which are live under Inventory and were not touched. `dev_notes` / `idea_notes` filed
under these five tab keys are still in their collections; nothing displays them.

**Restoring the code alone gives five empty pages.** Put the data back first: copy each
file from the vault folder to `data/<name>.json`; the store adopts it on first read.

## To bring it back
/shed restore compost-pile-2026-08-27
