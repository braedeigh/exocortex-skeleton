# unvisited-2026-10-10  —  shed 2026-10-10

## What this was
Eight pages of the app that were never opened, set down together:

- **Recordings** — the voice-recording list with transcripts.
- **Transcripts** — the pond of imported conversation transcripts.
- **Scratchpad** — the free-form scribble page.
- **VS Code** — the page that starts and embeds a code editor.
- **Automations** — the full-page list of scheduled prompts.
- **Wiki** and its **Wiki pond** — the thread wiki and its pond view.
- **Notes** — the "browse all notes" page.
- **Build** — the build-queue card board.

## Where it lived
- `frontend/src/features/{recordings,transcripts,scratchpad,vscode,wiki,wikipond,notes,build}/`
- `frontend/src/features/automations/AutomationsPage.*` (the page only)
- `frontend/src/routes/{recordings,transcripts,scratchpad,vscode,automations,wiki,wiki.$slug,wiki_.pond,notes,build}.tsx`
- `routes/{recordings,transcripts,wiki,buildtodo}.py` and their tests
  (`tests/test_{recordings,transcripts,wiki,buildtodo}_routes.py`, `tests/test_wiki_pond.py`)

Everything sits in this folder at the same relative path.

## Why it was set down
Her call, 2026-10-10: "everything that I don't use i want put in archive until i
decide i want it again and not shown on the app", then "just frickin remove all
that ... and take it all off the UI and let's see".

## What the signals said
- Used: zero page visits for every one of them in the whole collection window
  (2026-07-20 .. 2026-10-10, 83 days). Zero API requests to recordings,
  transcripts, wiki and buildtodo since per-request logging began 2026-09-24;
  one request to automations (2026-10-03).
- Modified: not surveyed per file for this cut.
- Reachable: all of them were — each had a page address, and most a nav entry.
  This is *unvisited*, not dead. That is why it is shed and not burned.

## What stays (on purpose)
- `frontend/src/features/automations/api.ts` and `routes/automations.py` —
  Terrain's Runs view reads the schedule through them.
- The three `/api/vscode/*` endpoints inside `server.py` — inline code, left
  where it is; nothing calls them now.
- `transcriptstore.py`, `notestore.py` and their tests — other code uses them.
- The page addresses in `routes/spa.py` (`/wiki`, `/notes`, `/build`, …) — they
  still answer with the app, which shows its not-found page.
- All data. Recordings, build cards, wiki state and notes are untouched in the
  vault; the Todos and Journal note panels still work.

## Unwired
- `server.py` — `buildtodo`, `wiki`, `recordings`, `transcripts` removed from the
  `from routes import (...)` list, and their four `.register(app)` lines.
- `frontend/src/shell/tabs.ts` — `notes`, `build`, `recordings` out of `VIEW_META`.
- `frontend/src/shell/TopTabs.tsx` — `scratchpad`, `vscode` menu entries; `notes`
  out of the `MORE_VIEWS` filter.
- `frontend/src/shell/panels/sections.ts` — `transcripts`, `notes`, `scratchpad`,
  `recordings`, `build` sections.
- `frontend/src/features/todos/NotesPanel.tsx` — the ↗ "browse all notes" link
  (its `Link` import and the `showAllLink` destructure went with it; the prop
  is still in the type so callers are unchanged).
- `frontend/src/shell/SchedulePanel.tsx` — the "Automations ↗" button and its
  `useNavigate`.

## How to bring it back
`/shed restore unvisited-2026-10-10` — move each file back to its path, re-add
the wires listed above, run the tests and the build.
