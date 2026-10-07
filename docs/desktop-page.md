# The desktop app — the page side

Plain English: the Observatory and Terrain can be run as an app on someone
else's computer. This file covers the **page** half of that: how the page
knows it is the desktop app, which pages it keeps, what the first-run screen
does, and — the main reason this file exists — a list of everything in the
page that still assumes the owner's own install.

The server half (the small app that runs on the person's machine, and the
routes it answers) is `standalone_app.py` and `scripts/standalone.py`. The
window around it is a separate piece again.

Prompt that produced it: "What would it take to turn the observatory and
terrain into a downloadable desktop app?"

## How the page knows

The desktop server writes `window.STANDALONE = true` into the page before it
loads (`routes/spa.py`, beside `VIEW_MODE`). On the normal site the flag is
false or missing. It is the only signal, and it is read in one place:
`frontend/src/shell/standalone.ts`.

It is one build, not two. The same `frontend/dist/` serves both; the desktop
app hides what it doesn't hold. The code for the journal, food and the rest is
still in the download, unreachable.

## What the desktop app keeps

`shell/standalone.ts` holds the lists; everything else asks it.

| Kept | Left out |
|---|---|
| `/observatory` — the session rooms, a session's chat, the archive, the spinoff tree, swarms, token burn | `/observatory/linear`, `/research`, `/nightcrew`, `/helpers`, `/worktrees` |
| `/terrain` — Files, Map, Attention, Commands, Flow, Workshop, Activity, Growth, Builds, Wiring, Runs, SQL | `/terrain/pond`, `/terrain/creek` |
| `/code` (a file opened from the map), `/sql` | every other page of the site |

**The journal is a part the server switches on.** The page holds `/journal`
(and its tab) only when the desktop server lists it in
`window.STANDALONE_EXTRAS`. The Journal page needs the journal's own data on
the machine, so until the server has that and says so, the page shows no
journal at all. What "journal" covers beyond that one page (the Keeper that
writes it, Pond, Creek, Threads) is not decided.

Four places enforce it:

1. **`routes/__root.tsx`** checks every navigation. An address the app doesn't
   hold goes to the app's front page: the map in a wide window, the sessions
   in a narrow one.
2. **`shell/panels/sections.ts`** cuts the desktop tab bar's catalogue down to
   Observatory, Terrain, Flow, Workshop, Activity, Code, SQL and Setup.
   `tabSets.ts` starts a fresh install with "Sessions" and "Code" tab sets.
3. **`shell/TopTabs.tsx`** draws a three-button strip (Observatory / Terrain /
   Setup) in a narrow window instead of the site's two rows.
4. **Pages with doors** ask `pageIsOffered()` per door: the roster
   (`features/observatory/RosterPage.tsx`) and Terrain's hallway
   (`features/terrain/TerrainRoomsIndex.tsx`).

## The first-run screen

`frontend/src/features/setup/`. It stands in front of the app until the person
presses "Open the app", and is reachable afterwards as the Setup tab
(`/observatory/setup`).

It asks `GET /api/standalone` and shows two steps:

1. **Code to draw.** Three ways to fill it, all through
   `POST /api/standalone/project`: this app's own code (`{"own": true}`, shown
   first when the server offers it), a folder on this computer (`{"path"}`),
   or a download from a git address (`{"url"}`). While a download or a history
   read runs, the page re-asks every two seconds and shows the server's own
   progress line.
2. **Claude Code.** Installed? Signed in? The screen only checks and explains.
   It doesn't install anything or sign anyone in.

When more than one project is on the machine (the app's own code and a
person's own folder are separate projects, each with its own map), the others
are listed as buttons that switch which one Terrain draws (`{"id"}`).

Under the two steps is one notice: **sessions act without asking**, with an
"Ask me first" switch (`POST /api/standalone/settings {"ask_first"}`). It
applies to sessions started from then on. Beside it is the **idle check**: a
session left alone for a day is asked whether its job is over. It has its own
switch, "Check on idle sessions" (`{"idle_check"}`). Each switch is drawn only
when the server reports that setting.

"Open the app" turns on once there is a folder. A missing or signed-out Claude
Code does not block it — the map works without it — but the screen says
sessions can't answer yet.

The wording lives in `setupCheck.ts`, apart from the drawing, so it can be
tested without a browser. The folder button uses the window's own
choose-a-folder dialog when there is one (`window.exoDesktop.chooseFolder`);
in a plain browser the type-or-paste box is the only way, because a web page
can't learn a folder's full path.

## Rooms a person edits

On the site the Observatory has two fixed rooms. In the desktop app the rooms
are a list the person owns: it starts as "Personal" and "Code", and the
"Edit rooms" button under them opens a sheet to rename, delete and add
(`features/observatory/RoomsDialog.tsx`).

The list lives on the desktop server (`/api/standalone/rooms`: GET the list,
POST `{name}` to add, POST `<id>` `{name}` to rename, DELETE `<id>`). Every
answer is the whole list. `roomsApi.ts` fetches it and copies it into
`api.ts`, where the helpers every page uses to place and name a session
(`offeredRooms`, `toLane`, `isRoom`, `laneLabel`, `strayRoom`) read it. A
room's id is the lane its sessions carry.

- Deleting a room asks first. The server moves its sessions to the first room
  left, and refuses to delete the last room.
- Under each heading the desktop app says only where the room's sessions
  work: the starting Personal room in the journal's folder, every other room
  in the folder Terrain is drawing. The owner's own introductions are not
  shown.
- The same list feeds the new-session sheet's room picker, the archive's room
  chips, and the Section list on Terrain's agent bar.
- The new-session sheet in the desktop app says "Asks first" follows the
  Setup page's switch, and hides the diary switch unless the journal is on.

## What in the page still assumes the owner's install

Sorted by what was done about it. "Handled" means the desktop app no longer
shows or does it. "Open" means it is still there.

### Handled in desktop mode

- **Links to the rest of the site.** The tab strip's Journal / Dashboard /
  Chat / Settings, the To Do / Life Map / Kitchen row, the More menu, and the
  workspace catalogue's Keeper, Research, Journal, Food, Kitchen, Money,
  Dashboard, Threads, Transcripts, Notes, Files, Scratchpad, Recordings, Build
  and Settings. None is drawn, and typing the address goes home.
- **`/` goes to `/todos`** on the normal site. The desktop app sends it to the
  map or the sessions.
- **Rooms that are hers.** The Linear room (her Linear board), the Research
  room (her research desk), Night crew and Helpers (jobs her cron starts), the
  worktree map (of that crew), and Terrain's Pond and Creek (her journal).
- **The dev-notes pill** on the roster files notes into her build queue.
- **The approvals popup** (`ApprovalsHost`) polls her pending-changes queue on
  every page. Not mounted.
- **The phone-app parts.** The service worker is unregistered on launch and
  the push "is this device looking" heartbeat is not started. The desktop
  server also answers 404 for the worker file.
- **The theme's Auto mode** keeps time by the owner's home coordinates
  (`ownerHome.ts`). The desktop app uses the machine's own clock instead: a
  plain 6-to-18 day, since it doesn't know where the person is.
- **The mobile Chat tab** lists her tmux terminal sessions. Not polled.
- **Terrain's wording said "both repos"** and named them "App code" and
  "Personal vault". In the desktop app the Files room's card and the map's
  guide (`TerrainGuide.tsx`) speak of one folder.
- **The agent bar on the Terrain map** filtered by her rooms. In the desktop
  app its Section list offers the person's own rooms
  (`agentSectionsFor` in `TerrainAgentBar.tsx`).
- **The room names and introductions** were in the owner's voice about her
  machine. See "Rooms a person edits" above.
- **The window's title** is set from `window.APP_META.name` once the page
  loads (`main.tsx`), instead of the fixed word in `index.html`.

### Open — still in the page

- **The home coordinates are baked into the build.** `VITE_HOME_LAT` /
  `VITE_HOME_LNG` / `VITE_HOME_TZ_OFFSET` are read from `frontend/.env.local`
  at build time and written into the JavaScript as plain numbers. The desktop
  app ignores them, but they are still **in the file**. A download must be
  built on a machine, or in a checkout, with no `frontend/.env.local`.
- **The app's name in the phone-app manifest** is the fixed word "Exocortex"
  (`frontend/vite.config.ts`), as is the page title in `frontend/index.html`
  until the page loads. The desktop app has no phone-app install, so the
  manifest's name is not shown anywhere there.
- **The Keeper slot** at the top of the roster is drawn only when a pinned
  session exists, so a new person never sees it — but the code and its wording
  are there, and the create-session sheet still offers a "journal" switch.
- **The sudo popup** (`SudoHost`) still polls on every page. It is harmless
  with an empty list, but the thing it is for — reloading her web service —
  doesn't exist on a desktop.
- **A 401 sends the page to `/login`** (`api/client.ts`). The desktop server
  has no login and should never answer 401, so this only matters if it does.
- **Usage beacons** (`api/usageBeacon.ts`, `usageTracker.ts`) post every tab
  visit and tap to `/api/usage/*`. They stay on the person's own machine, and
  Terrain's Attention room reads them, so they were left on.
- **The map's guide still describes the pond** (the journal's square on the
  map) and says "coding sessions lean left, personal ones right". The first
  waits on the journal arriving; the second is not true of a room a person
  added or renamed.
- **The Setup tab is not pinned** on a wide window: it is in the tab bar's
  menu, not in a starter tab set (those are seeded by `routes/tabsets.py`).
- **The kept pages inside the Observatory** (archive, spinoff tree, swarms) have not been read line by line for
  owner-only wording.

## Tests

`frontend/src/features/observatory/desktopRooms.test.ts` — the room list
through an add, a rename and a delete, and that the site keeps its fixed two.
`frontend/src/shell/standalone.test.ts` — which pages the desktop app holds,
where it sends the rest, and that the tab bar and starter tab sets only name
pages that exist there. `frontend/src/features/setup/setupCheck.test.ts` —
what the first-run check reports for each state of the machine, and when the
screen stands in front of the app.
