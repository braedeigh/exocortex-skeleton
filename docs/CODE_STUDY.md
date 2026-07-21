# Code Study Guide — learn this codebase

**How to use this:** start a fresh Claude session in `/opt/exocortex/skeleton` and say:

> Read `docs/CODE_STUDY.md` and run a study session with me. Pick up wherever the
> "progress" section says we left off.

Work through one unit per session (30–60 min each). Update the progress section
at the end of each session.

---

## Instructions for the assistant running the session

You are a **study guide, not a contractor**. The owner owns this codebase and
wants to genuinely understand it — much of it was written rapidly by agents
during a migration, so it is consistent but unfamiliar to them.

Ground rules:
- **Teach by tracing real code.** Open the actual files, quote the actual lines.
  No hypothetical examples when a real one is 20 lines away.
- **Predict-then-verify.** Before showing how something works, ask them to guess
  ("what do you think happens if the POST fails?") — then read the code together
  to check the guess. Wrong guesses are the good part.
- **They drive.** Offer the unit's path, but follow their questions wherever they
  go. Depth over coverage.
- **Read-only.** Do not refactor, "improve", or fix anything during study
  sessions. If you find a real bug together, write it into `dev_todo.md` and
  move on.
- **Small chunks, checkpoints.** After each concept, one short check question.
  If they answer easily, speed up.
- **End every session** by having THEM summarize what they learned in 3–5
  sentences, then append it (verbatim, theirs) to the progress log below along
  with what to start with next time.

## Context brief (read this, then skim the pointers)

The app: a personal life/health dashboard ("Exocortex"). Flask backend
(`server:app`, gunicorn, 2 gevent workers) + React SPA (`frontend/`,
Vite + React 19 + TanStack Router/Query). Code here is the shareable
"skeleton"; personal data lives in the owner's private vault (wired via
`EXOCORTEX_DATA_DIR`/`EXOCORTEX_CONTENT_DIR`). Read the repo `CLAUDE.md` first.

Recent history that explains the code's shape (see `git log` around 2026-07-09):
1. The old server-rendered frontend (Jinja + vanilla JS) was fully ported to
   React and deleted — archived in the owner's vault at
   `reference/old-frontend/`. Every page is a "feature
   module"; nearly all were parity ports of legacy pages.
   `frontend/MIGRATION_NOTES.md` is the map of that effort.
2. The data layer began migrating from JSON files to SQLite: `store.py`
   dispatches collections listed in `SQL_COLLECTIONS` to `sqlstore.py`
   (database of record) which keeps the JSON files as derived mirrors.
   `todos`/`pending_changes`/`sessions` are still file-backed on purpose
   (external writers).
3. An "optimistic UI with visible errors" sweep standardized every feature:
   render cached data immediately; error states only when there's nothing to
   show; every mutation failure rolls back + toasts.

## The one diagram to internalize

```
tap → component → feature hook (optimistic cache patch, instant pixels)
    → feature api.ts → src/api/client.ts → POST /api/...
    → routes/<feature>.py → store.write()
    → sqlstore.put(): SQLite COMMIT → JSON mirror export
    → next poll: GET /api/data/<tab> → store.read() → SELECT → cache replaced
      with database truth (or: failure → rollback + error toast)
```

Every feature is this. Bigger features are this with more components.

---

## Syllabus

### Unit 1 — The data layer (the foundation)
Files: `store.py`, `sqlstore.py`, `tests/test_store.py`, `tests/test_sqlstore.py`.
- Why atomic writes (temp file + fsync + rename)? What failure does it prevent?
- What race does `mutate()` close that `read()`+`write()` leaves open?
- Trace `store.write("car_maintenance", …)` into SQLite and back out as a mirror.
- Exercise: in a python REPL against a **temp dir** (copy the `data_dir` fixture
  trick from `tests/conftest.py`), write/read/mutate a fake collection; kill the
  process mid-mutate; observe nothing corrupted.
- Check: why are `todos` and `pending_changes` NOT in `SQL_COLLECTIONS`?

### Unit 2 — One backend feature end to end
Files: `routes/car.py`, then `server.py`: the `gate()` before_request, the
`/api/data/<tab>` aggregation, `register(app)` wiring at the bottom.
- How does a request get authenticated? What's `view_mode` / public mode
  (`public_config.py`)?
- Exercise: predict the exact JSON `POST /api/car/add` writes, then verify with
  `curl` (or the test client) against a temp data dir.
- Check: where would you add a new endpoint `POST /api/car/archive`? (Answer in
  words, don't build it.)

### Unit 3 — One frontend slice at minimum size
Files: `frontend/src/features/car/` (all of it), `frontend/src/routes/car.tsx`,
`frontend/src/api/client.ts`.
- The five-file anatomy: types / api / hook / components / pure math + tests.
- Trace the "one tap, top to bottom" diagram with real line numbers.
- The optimistic overlay: find where the cache is patched, where rollback
  happens, where the error toast fires.
- Exercise: run `npx vitest run src/features/car` and read one test; break the
  helper on purpose, watch it fail, revert.
- Check: why do components never call `fetch` directly?

### Unit 4 — The reference feature at full scale
Files: `frontend/src/features/todos/` — `useTodayData.ts`, `optimistic.ts`,
`todoHelpers.ts`, `TodosPage.tsx`. (This is also the owner's active WIP — read, don't touch.)
- Query keys and invalidation; the 5s poll; `useOptimisticMutation` as the
  factory every other feature copied.
- Sheets, toasts with Undo, drag-and-drop coordination.
- Check: explain in their own words what happens between a checkbox tap and the
  data being "confirmed", including both failure timings (before/after poll).

### Unit 5 — The shell (everything around the pages)
Files: `frontend/src/routes/__root.tsx`, `shell/SplitLayout.tsx`,
`shell/TopTabs.tsx`, `shell/tabs.ts`, `src/theme/` (engine + resolve + solar),
`shell/useSessions.ts` (SSE), `features/approvals/ApprovalsHost.tsx`.
- File-based routing; why `body{overflow:hidden}` and per-page scroll containers
  (this bit us — see commits `8c44d0f`, `e26154a`).
- How the sky-theme engine sets CSS variables at runtime; what Settings edits.
- The terminal pane: what's an iframe (ttyd) vs native; SSE session list.
- Check: a new page `/foo` — list every file that must exist or change.

### Unit 6 — The agent ecosystem & what's next
Files: `routes/pending.py`, `frontend/src/features/approvals/`,
`tools/add-todo/` (skim the Rust), `scripts/research_dispatcher.py`,
`/opt/exocortex/exocortex-rs` (skim `exo-store`).
- The staging door: why agents write `pending_changes` through one binary.
- Why external writers block SQL-flipping `todos`; the planned ingest watcher
  and ops-log/sync design (ask the assistant to reconstruct it from
  `sqlstore.py`'s docstring + this file).
- Check: explain the difference between "JSON as mirror" (car) and "JSON as
  truth" (todos) and what breaks if you confuse them.

### Stretch units (pick by curiosity)
- Testing culture: `pytest.ini`, `tests/conftest.py`, one route test + one pure
  frontend test; the "name tests for behavior" rule in `CLAUDE.md`.
- The PWA: `frontend/vite.config.ts` Workbox config — precache, NetworkFirst
  API cache, the navigate-fallback denylist and why `/files/` is on it.
- A big feature interior: kitchen (recipes pipeline) or research (annotator
  anchor math in `features/research/anchor.ts`).

---

## Glossary
- **optimistic overlay** — UI shows the change instantly from a patched cache;
  server confirms later; rollback + toast on failure.
- **mirror** — the JSON file exported after every SQLite commit; derived, never
  authoritative (for SQL-backed collections).
- **strangler fig** — the migration pattern used for the React port: new shell
  wraps old pages, replaces them one at a time, then the old thing is removed.
- **collection** — one named blob of data (`todos`, `expenses`), one `docs` row
  in SQLite / one JSON file.
- **WAL** — SQLite write-ahead-log mode; lets readers and one writer coexist.
- **staging door** — agents propose changes into `pending_changes` via the
  `add-todo` binary; the approvals UI applies them via native endpoints.

## Progress log
_(assistant: append after each session — their summary, in their words, plus "next time: …")_

- (not started)
