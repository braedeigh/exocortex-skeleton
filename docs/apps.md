# Apps — the site as separate, linked apps

The site used to be one everything-app. It is now cut into apps, each installed
on its own on a phone and each showing only its own tabs:

| App | Holds | Projects (`projects.json`) |
|---|---|---|
| **Journal** | Journal, To Do, the Keeper, its sessions (the Personal room), Life Map, Fronts, Threads, People, Body, Ideas, Media, the Pond, Files | journal, todos, health |
| **Observatory** | Sessions in every room, Terrain (but not the Pond), Research, the SQL lab, Automations | research, workshop, observatory, transcripts |
| **Finances** | Money | money |
| **Inventory** | Inventory and archivals | life |
| *Based Foods* | its own app at its own address, linked from every other app, never proxied | kitchen (its pages here, see below) |

**Settings** and a code file (`/code`) are in every app. **Core** (`projects.json`
`core`: the data layer, login, the shell, settings) is shared by all of them.

`apps.json` at the repo root is the one list. Read by `frontend/src/shell/apps.ts`
(the page), `appmap.py` (the server), `appboundaries.py` and the tests.

## Installing (phones)

- Every app has its own web manifest, `/apps/<id>.webmanifest` (`routes/spa.py`,
  `appmap.manifest`): its own `id`, its own start page (`/<page>?app=<id>`), scope
  `/` (they all live on one site and link to each other). A page opened with
  `?app=<id>` links that manifest and wears that app's name and Home Screen icon;
  a page with no app links none — there is no everything-app to install.
- `/` is the **launcher**: a card per app, and how to install one. Open the app
  from there, then Share → **Add to Home Screen**.
- **iPhone:** each Home Screen app has its own cookies and storage. So you **sign
  in once per app**, and **push notifications belong to the app that turned them
  on**. Signing in sends you to the launcher; pick the app again from there.
- Icons are `frontend/public/apps/<id>-192.png` / `-512.png`: the site icon with the
  app's letter on it, a placeholder made once — replace them freely.
- One service worker (scope `/`) still serves every app, so a bad build reaches all
  of them at once.

## How the page knows which app it is

- `?app=<id>` on load names the app; it is remembered for the life of the window in
  **sessionStorage** (not localStorage, which Android shares between installed apps
  on one site). A phone window opened with neither — an old bookmark, a
  notification's link, an iPhone window that lost its storage — takes on the app
  that holds the page it opened on. A page no app holds (Settings, a kitchen page)
  with no app gets a bar back to the launcher.
- In an app, the strip at the top is that app's tabs only (`shell/AppStrip.tsx`):
  some always shown, some shown while they fit, the rest under More, with "All apps"
  at the bottom. A page the app doesn't hold opens **bare, with a way back** — never
  a redirect, so a link out of a session still lands.
- With no app, a page gets a bar back to the launcher. Public visitors and the
  desktop app (`docs/standalone.md`) are unchanged.
- The Journal *borrows* the Observatory's session list and a session
  (`apps.json` `borrows`): its list shows the Keeper and the Personal room, and a
  new session there starts in Personal. The Observatory's list shows every room but
  hides the Keeper — the Keeper lives in the Journal. One definition:
  `rosterView` beside `roomRoster` in `features/observatory/sessionFilters.ts`.

## Desktop: apps as tab sets

Each app is a built-in, read-only tab set (`panels/tabSets.ts` `appTabSets`, id
`app:<id>`). A panel's ▾ lists the apps first, then her own sets, which keep
working. Picking an app puts that app in the pane — its tabs, and its pages behaving
as that app's (the pane hands its app down through `AppContext`). Split the
workspace and put Journal beside Observatory.

## Based Foods

Its address is per install (`config.based_foods_url`): the one-line file
`based_foods_url` in the data dir, read on every request, or `EXOCORTEX_BASED_FOODS_URL`
in the service's environment, which wins but needs a restart. Neither means no link
is drawn. The kitchen and Food
pages here (Kitchen, the ecosystem map, foods, nutrients, contaminants, review, the
food map, shared recipes) belong to no exocortex app; `apps.json` `based_foods.pages`
marks each `in-based-foods`, `to-port` or `exocortex-only` — the port checklist, also
drawn in the Terrain's Apps room. They stay reachable at their addresses; nothing was
deleted. Missing features are rebuilt in Based Foods by its own team, by PR.

**What moves** (her rule, 2026-10-28): a feature moves to Based Foods when someone
else would want it and it works without her AI setup. Everything else stays an
exocortex extra: receipts and reading them, Claude's organic estimates, the machine's
source proposals and their review page, food tests. Her groceries (list, trips, pantry)
will live in Based Foods.

## The boundary map, and the ratchet

For each app to live one day in a repo of its own, the places where one app's code
uses another's have to go. `appboundaries.py` lists them — **crossings**:

- `import` — a Python file imports a module another app owns;
- `frontend` — a feature folder imports from another app's feature folder;
- `table` — a Python file names another app's table in its SQL (a **text
  heuristic**: the name after FROM / JOIN / INTO / UPDATE / TABLE);
- `page` — an app borrows another's page.

Core is shared, so nothing to or from it counts. The crossings as they stood when the
apps were drawn are in `app_boundaries_baseline.json`. `tests/test_app_boundaries.py`
fails on a **new** crossing, and on a listed one that **no longer happens** — run
`python3 appboundaries.py --prune` to take fixed ones off. So the list only shrinks.
Adding one is a hand edit, on purpose. `tests/test_projects.py` fails if a project
belongs to no app (or two); `tests/test_spa_routes.py` fails if a page in
`routes/spa.py` belongs to no app and isn't shared, the launcher, a Based Foods page
or set down (`apps.json` `set_down`: addresses whose pages are in the shed).

The map is drawn at **/terrain/apps** (the Apps room; `routes/apps.py`, `/api/apps`):
a column per app with its pages, routes, modules and tables, its crossings in red,
and the Based Foods column as the port checklist.

## The road from here (each its own planned job)

1. Untangle the crossings, app by app, pruning the baseline as they go.
2. Decide whether the session engine (`routes/observatory.py` and friends) becomes
   shared Core; today the Journal's use of it is a recorded crossing.
3. A server per app, at its own address — the `standalone_app.py` pattern (a server
   built from a list of route modules).
4. Split `exo.db` along the apps' tables.
5. Move each app into its own repo, the way Based Foods already is.
