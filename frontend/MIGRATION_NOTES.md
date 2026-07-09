# Old frontend → React SPA: comparison & porting notes

*Written 2026-07-09. Reference for finishing the React migration and retiring
`templates/` + `static/`. The old files will be archived (tarball + browsable
copy) before removal; git history keeps them too.*

---

## How each frontend is organized

### Old (server-rendered): `templates/` + `static/`
Flask + Jinja + vanilla JS, built as an **iframe app-shell**:

- `split.html` — outer shell (`/classic`): desktop terminal-pane ∣ divider ∣ dashboard-pane
  split, mobile tab bar, file upload/drag-drop/paste, scheduled prompts, session bar,
  postMessage plumbing, registers old `sw.js`.
- `index.html` — the dashboard (`/tab/<name>`): all **14 tabs** in one page, populated by
  ~35 JS modules in `static/js/` (core.js render loop, per-tab modules, lazy kitchen/
  ecosystem bundles). All the modals (delete-confirm, approvals, receipt import…).
- Standalone pages, each iframed or visited directly: `journal.html`, `keeper.html`,
  `research.html`, `settings.html`, `personality.html`, `person.html`, `phone.html`,
  `notes.html`, `food_map.html`, `vscode_launcher.html`, `login.html`, `about.html`.
- CSS: `static/css/style.css` (design tokens + all dashboard styles), `frosted.css`
  (public mode), per-page inline `<style>` blocks.
- Theming: `static/js/sky-theme.js` — 4 modes (Auto/Light/Dark/Color-runway), 7 solar
  day-phases, user overrides from Settings, broadcast to all iframes via postMessage.
- PWA: `static/manifest.json` + `static/sw.js` (network-first, offline fallback only).
- Vendored: Leaflet + US state/county GeoJSON (Ecosystem map, food map).

### New (React SPA): `frontend/`
Vite 8 + React 19 + TS + TanStack Router (file-based) + TanStack Query. CSS Modules +
custom properties, no UI kit. Only 4 runtime deps. Served from `dist/` by `routes/spa.py`.

- `src/routes/` — file-based routes; `src/shell/` — SplitLayout (port of split.html),
  TopTabs, FrameHost iframe registry, terminal pane, frameBridge postMessage.
- `src/features/` — one module per page (todos, journal, habits, notes), each with
  components + pure-logic helpers + vitest tests.
- `src/api/` — typed endpoint helpers over one fetch client (401 → /login).
- `src/ui/` — shared primitives (Button, IconButton, TapRow, Checkbox, Sheet, Toast).
- PWA via vite-plugin-pwa/Workbox (precache shell, NetworkFirst /api, denylist for
  Flask-owned paths); unregisters the old `/static/sw.js`.
- **Strangler-fig bridge**: unported pages render as same-origin iframes —
  `/legacy/$tab` → `/tab/<name>?embed=spa`, `/files` → `/keeper`,
  `/research` → `/research-view`, `/settings` → `/settings-view`.

---

## Page-by-page status

**Natively ported (React owns the UI):**

| Page | Old source | React location | Gaps vs old (see below) |
|---|---|---|---|
| Today / To Do | index.html `#tab-today` + todos.js/habits.js/health.js/reminders.js… | `features/todos` + `features/habits` (`/todos`, `/todos/editor`) | Triage, food banner, kitchen quick-list, contact reminders, approvals, habits phase 2 |
| Journal | journal.html | `features/journal` (`/journal`) | threads, People/Threads panels |
| Notes pill / dev+idea notes | notes-pill.js, mini-notes.js | `NotesPill`/`NotesPanel` + `/notes` browser | — (browser is new, better) |
| Shell / split view | split.html | `src/shell` | scheduled-prompts UI exists (SchedulePanel) ✓; fake public terminal replaced by PublicLanding |
| Mobile terminal chrome | split.html mobile tabs | `/chat` + PhoneFrames | still iframes `/phone` (see live deps) |

**Still Flask, iframed by React (needs porting):**

| Page | Old source (template + JS, approx size) |
|---|---|
| Life Map | `#tab-map`; habits.js grid, activity.js (247), contacts.js (427), reminders.js (553) |
| Kitchen | `#tab-kitchen`; kitchen.js (2647), kitchen-recipes.js (1253) |
| Inventory | `#tab-inventory`; inventory.js (685), archivals.js (708) |
| Money | `#tab-money`; money.js (1014) |
| Car | `#tab-car`; car.js (197) |
| Meditation | `#tab-meditation`; meditation.js (646) |
| Media | `#tab-media`; media.js (301) |
| Movement | `#tab-movement`; movement.js (341) |
| Body | `#tab-body`; overview.js (301), food.js (261), shared kitchen safety cards |
| Ideas | `#tab-ideas`; ideas.js (261) |
| Ecosystem | `#tab-ecosystem`; ecosystem.js (980), eco-match.js, Leaflet + GeoJSON |
| Housing | `#tab-housing`; housing.js (238) |
| People | `#tab-people`; people.js (321) |
| Research | research.html; research.js (1698) — hash-routed threads/library/annotator |
| Settings | settings.html; settings.js (454) — theme editor, account |
| Keeper / Files | keeper.html — file tree, wikilinks, autosave, undo-restore |
| Personality | personality.html — section cards over one markdown doc |
| Person page | person.html; person.js (410) — facts, heatmap, impression, story, receipts |

**No React equivalent at all (not even iframed — decide: port, keep as Flask, or drop):**

| Page | Notes |
|---|---|
| `phone.html` (`/phone`) | **Actively used** by React mobile Chat (PhoneFrames iframes it). Port into React or keep. |
| `food_map.html` (`/food-map`) | Public shareable read-only food map. Port alongside Ecosystem. |
| `vscode_launcher.html` (`/vscode`) | Memory gauge + start/stop in-browser VS Code. |
| `notes.html` (legacy scratchpad) | Autosaving textarea + undo/redo + "send to terminal". The React `/notes` is a *different thing* (notes browser) — scratchpad has no replacement. |
| `login.html`, `about.html` | Stay Flask (auth + public about) unless deliberately reworked. |
| `split.html` at `/classic` | The rollback shell. Delete last, once confident. |

---

## Feature gaps inside already-ported pages

Things the old page did that the React port doesn't (from code TODOs + comparison):

**Today/Todos:**
- 🧭 **Triage** button (chat session that reorders todos); `frameBridge.openTerminalSession` is a stopgap that lands on Today.
- **Food-log banner** and food quick-log (food.js) — food logging lives only on Body tab / legacy.
- **Kitchen quick-list** on Today.
- **Contact reminders** ("keep in touch" pops) on Today.
- **"Show hidden prompts"** expand-all toggle (deferred).
- **Applications tracker** + per-tab tagged-todo strips (old todos.js).
- **Pending-change approval flow** — old `pending.js` + `static/js/approvals/{food,long-covid,contacts}.js` polled `/api/pending` and offered approve/edit/undo modals. **No React UI exists** (types are vendored in `src/api/types/` but unused). Backend feature goes dark on ported pages until this is built.
- Streaks: inline "+ day count" add form; "track as daily habit" linkage.
- Symptoms: editing an already-logged day (only on Body tab today).

**Habits ("phase 2" TODOs in code):** tracker grid, habit config modal (+Tracked habit),
edit mode (drag/reorder/rename/delete), companion-page links, evening kitchen close-out
checklist, habit add/remove/move/settings endpoints.

**Journal:** thread/group entity highlighting + thread popovers (`/api/threads`),
People & Threads launcher panels on the floating rail. (Person highlighting, popovers,
backlinks, find-bar, calendar, card stream all ported ✓.)

---

## Live dependencies of the NEW frontend on OLD files — do not archive blindly

These old files are load-bearing for the React app **today**:

1. **`static/js/sky-theme.js`** — loaded by `frontend/index.html` at runtime; it *is* the
   theming engine (CSS vars are only a pre-JS fallback). Must be ported/bundled before
   `static/js/` is removed.
2. **`templates/phone.html`** (+ `/phone` route) — iframed by React mobile Chat.
3. **All `/tab/<name>` content**: `templates/index.html` + ~30 JS modules + `style.css`,
   `frosted.css`, Leaflet vendor — needed until every legacy tab is ported.
4. **`keeper.html`, `research.html`, `settings.html`** — iframed at `/files`, `/research`,
   `/settings` until ported.
5. **`login.html`** — auth flow (SPA redirects 401 → `/login`).
6. `person.html`, `personality.html` — linked from PersonPopover / More menu.
7. `/terminal/` (ttyd) and `/files/` (VS Code) are reverse proxies, not templates — unaffected.

Safe to remove early: old `static/sw.js` + `static/manifest.json` (React SW unregisters
the old one; only `/classic` references them), once `/classic` rollback is retired.

## Archive plan (when porting is done)

1. Verify each React port against the old page.
2. `tar -czf` the whole `templates/` + `static/` + template-serving route code; also keep
   a browsable copy outside the repo (e.g. `/opt/exocortex/personal/reference/old-frontend/`).
3. Remove `templates/` + `static/` + `/classic`, `/tab`, `*-view`, `/keeper`, `/person`,
   `/personality`, `/food-map`, `/phone`, `/notes`(legacy), `/vscode` template routes in one
   dedicated commit (separate from the in-flight todos work). Keep `/login`/`/logout`/`/auth`.
4. Update React: drop `legacy.$tab` route, FrameHost/frameBridge iframe machinery,
   vite proxy entries, and the Workbox `navigateFallbackDenylist` entries that pointed at
   removed Flask paths.

## Suggested porting order

1. **sky-theme engine → TS module** (unblocks Settings; removes the live static/js dependency)
2. **Settings** (small; needs sky-theme)
3. **Small tabs**: Car, Housing, Media, Ideas, People, Movement (each ≤ ~350 lines of old JS)
4. **Person page + Personality** (linked from journal/People)
5. **Body + Life Map** (activity/contacts/reminders engines — shared with Today gaps)
6. **Meditation, Inventory (+ archivals), Money**
7. **Ecosystem (+ food_map public page)** — needs a React Leaflet integration
8. **Kitchen (+ recipes)** — biggest module
9. **Research** — biggest standalone app
10. **Keeper/Files**, **phone.html → native chat**, **scratchpad notes**, **vscode launcher**
11. **Pending-approvals UI** (cross-cutting; must exist before approvals-dependent tabs retire)
12. Retire `/classic`, archive, backend cleanup.
