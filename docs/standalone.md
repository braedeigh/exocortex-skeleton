# Standalone mode — the desktop app's server

Plain English: the live site is a web server with cron, a system service and a
password around it. Standalone mode is the same Observatory and Terrain, started
by one command on a computer that has none of that. It is what a desktop window
wraps.

Off by default. The live site never sets it, and `server.py` never imports any
of it.

```
python3 scripts/standalone.py                     # default data folder, port 5123
python3 scripts/standalone.py --port 0 --data DIR --exit-with-stdin
```

It prints one JSON line on stdout when it is listening
(`{"ready": true, "url": …, "port": …, "data_dir": …}`); everything else goes to
stderr. It stops on Ctrl-C / SIGTERM, or when stdin closes with
`--exit-with-stdin`.

## The parts

| File | What it is |
|---|---|
| `config.standalone()` | the one switch (`EXOCORTEX_STANDALONE=1`) |
| `scripts/standalone.py` | the start command: picks the data folder, points every writable folder inside it, serves on 127.0.0.1 |
| `standalone_app.py` | the small app: which route modules it serves, the no-other-site guard, the projects, `/api/standalone` |
| `standalone_jobs.py` | the timed jobs cron would have run |
| `standalone_journal.py` | the journal's folder and waking the Keeper |
| `scripts/standalone_seed.py` | run when packaging: makes the seed, a ready-made first project |
| `tests/test_standalone.py` | the proof |

Settings (all environment variables): `EXOCORTEX_STANDALONE_HELPERS=1` turns the
background helpers on; `EXOCORTEX_STANDALONE_SAMPLE_REPO` names a different
public address for the app's own code (a fork), or blank takes the offer away;
`EXOCORTEX_GIT_BIN` and
`EXOCORTEX_CLAUDE_BIN` name those two programs.

## Projects

A project is one code folder with its own map — the same thing Terrain calls a
build (`buildlist.py`). One project is *current*: the main map draws it and new
sessions stand in it. The app's own code is offered as the first project; the
person's own folder, or a repo downloaded from its address, is another.

Every project is a folder of its own. "The app's own code" is always a fresh
download of the published repo (`config.STANDALONE_SAMPLE_REPO`) into the data
folder, never the copy of the app that is running — even on a developer's git
checkout — so an agent working on it can't change the app underneath itself.

| Door | What it does |
|---|---|
| `GET /api/standalone` | is Claude Code there and signed in, is git there, the current project and its state (`none`, `downloading`, `loading`, `ready`, `failed`), every project, running turns, settings |
| `POST /api/standalone/project` | `{"path"}` a folder here, `{"url"}` download one, `{"own": true}` the app's own code, `{"id"}` switch |
| `POST /api/standalone/settings` | `{"ask_first": bool}` — whether new sessions ask before what they can't undo (off: they just act); `{"idle_check": bool}` — whether a session idle for a day is asked if it is done (on) |
| `GET /api/standalone/folders` | the folders inside a path, for a folder picker |
| `GET /api/standalone/github-repos?user=` | that GitHub account's public repos, to pick one to download |
| `GET`/`POST /api/standalone/rooms`, `POST`/`DELETE /api/standalone/rooms/<id>` | the rooms: list, add `{"name"}`, rename `{"name"}`, remove |
| `POST /api/standalone/stop-turns` | stop every running agent turn |

The page learns the mode from `window.STANDALONE` (`routes/spa.py`).

## The seed: something to look at on first open

A new install would otherwise wait about a minute, online, for its first
project to download and its history to be read. So the app is packaged with a
**seed** — `scripts/standalone_seed.py` clones the app's own code, reads its
history into a new database, and saves both (about 39 MB, 18 MB compressed).
On the first start on a never-used data folder, `scripts/standalone.py` copies
the seed in and `standalone_app.adopt_seed` makes it the current project: the
map draws at once, with no network. The seed lives in `standalone-seed/`
beside the code, or wherever `EXOCORTEX_STANDALONE_SEED` points. It is as old
as the release it shipped in. With no seed the app starts empty, as before.

## The journal and the Keeper

The journal is in the desktop app whole: the Journal page, the card engine
under it, and the Keeper — the agent that keeps it.

- **Its folder** is the content folder inside the data folder.
  `standalone_journal.prepare` runs at every start: it makes the folders, puts
  the seed Keeper manifest (`content-scaffold/CLAUDE.md`) there if there is
  none, and writes small launchers at `_system/*.py` that run the app's own
  card engine (`tools/stream/`). It never overwrites what the person or their
  Keeper wrote.
- **Waking it:** `POST /api/standalone/keeper` opens the one pinned journaling
  session, in the Personal room, standing in that folder, and sends
  `/journalstart` (the command file is written into the folder's
  `.claude/commands/`). `GET` says whether one is open and whether setup is done.
- **The first prompt:** until the manifest's "Who you're keeping for" section
  is filled in, the wake command carries a setup section — the Keeper explains
  itself, asks who it is keeping for, and writes the answers into `CLAUDE.md`
  and `context/about.md`. After that the section is gone.
- **Capture** needs no hook: the server records every message sent in a
  journaling session before the model sees it.
- **Doors:** `routes/journal_days.py`, `cards`, `journal_search`, `entities`,
  `threads`, `keeper`, plus `todos`, `devnotes` and `photos` for the page's
  side panels, and a one-line `/api/data` (today's date).
- **Timed:** `scripts/update_cards.py` hourly (no Claude calls).

Checked for real once (2026-10-06): on an empty folder the Keeper woke, asked
its first question, a typed reply was saved as a card, and it filled in the
manifest and `context/about.md`.

- **The nightly rollover** is on, with a switch (`{"keeper_rollover": bool}`
  on the settings door): once a night after 3am the heartbeat starts
  `scripts/keeper_rollover.py`, which sends `/endsession` to the open Keeper
  and wakes a fresh one. Only for a Keeper opened before today that has been
  talked to; a computer that was off at 3am rolls when the app is next open.
  Run for real once (2026-10-07) on a throwaway folder: the heartbeat started
  it unasked, the old Keeper wrote its diary entry and was archived, and a
  new pinned Keeper woke standing in the content folder.

Not in: thread tending, timed reminders, and "Talk about this" on a thread
(it needs tmux). The transcript reconciler isn't run
either; it only matters for someone typing into a terminal `claude`.

## Rooms

On the live site the rooms are a fixed six. Here they are a list the person
edits, starting as Personal and Code (`lanes.standalone_rooms`, kept in the
data folder's `standalone` file). A session's room is the room's id. Personal
stands in the journal's folder (the content folder); every other room stands
in the current project. Removing a room moves its sessions to the first room
left; the last room can't be removed.

## No login, so: only this computer

The server listens on 127.0.0.1 and refuses any request whose `Host` is not
this computer, or that a browser marks as coming from another site
(`standalone_app._guard`). Without that, a web page the person merely visits
could post to these doors — and these doors start agents that run commands.

## What the Observatory and Terrain lean on, and what happens to each

**Works as is**

- The route modules themselves — each registers on any Flask app.
- The data layer (`store.py`, `sqlstore.py`): makes `exo.db` and every file it
  needs on an empty folder.
- A turn's own process (`scripts/turn_host.py`): never needed the web server.
- Detached background jobs (`scripts/run_detached.py`), with their folder moved
  into the data folder.
- The Builds list and its clone (`buildlist.py`), the commit-history reader
  (`codestore.py`).
- The frontend build (`frontend/dist/`), served by `routes/spa.py`.

**Replaced in standalone mode**

- **gunicorn + systemd + reload** → one Python process (`scripts/standalone.py`).
  There is nothing to reload; closing and opening the app is the deploy.
- **cron** → `standalone_jobs.py`, which runs the same scripts on the same
  cadences, each as its own process, in two lanes (the once-a-minute jobs,
  and the slower ones) so a slow job never holds up the heartbeat — the first
  tool-calls pass reads every Claude Code transcript on the computer and
  takes minutes. The jobs: the minute heartbeat (mailbox, dead
  turns, closing done sessions, follow-ups, interrupted jobs, file overlaps),
  the run queue, footprints, code history, tool calls and chat search, slash
  commands, the usage ledger.
- **The password page and the auth gate** → the this-computer-only guard above.
- **The two hard-wired folders** (the app's code, the vault) → projects.
- **Where things are written** → all inside the data folder (job logs, spawn
  logs, downloads, the content folder), because a packaged app's code folder
  is read-only.
- **The service worker** → none; a cached shell on localhost only goes stale.

**Dropped**

- Everything that isn't the Observatory, Terrain or the journal: its routes
  answer 404.
- The night crew, the research and Linear rooms, the Coming up reminders, phone push, the sudo password card (the door
  answers an empty list), the public mirror, the type-into-a-shell terminal.
- The helpers (room, swarm, wake-ups) and the auto-titler are **off unless
  switched on**: each starts Claude calls nobody asked for. The day-idle check
  ("are you done?" after a day) is **on, with a switch in the app** to turn
  it off.
- The runtime sensor ("which of the app's functions ran").

**Needs the person's machine to have**

- **Claude Code**, installed and signed in. Every turn is a `claude -p` process.
- **git**. Terrain's history, blame and the download all run it.

## Not done yet

- **Mac.** About six spots read Linux's `/proc`: `routes/observatory.py`
  (`_boot_id`, `_proc_stat`, `_children`, `_is_detached_watcher` — noticing a
  dead turn and stopping a turn's child processes), `scripts/run_detached.py`
  (`_boot_id`, `_is_watcher`), `routes/kitchen/shared.py` (the memory floor,
  which already skips itself when it can't read). Windows is further: file
  locks (`fcntl`), detached processes (`setsid`), `sh`.
- **Downloads take GitHub addresses only** (`buildlist.parse_github`), public
  repos only. The repo list is GitHub's public one for a username: no sign-in,
  first hundred repos, and GitHub allows about 60 lookups an hour per network.
- **Claude Code's login on a Mac** lives in the keychain, so `signed_in` is
  `null` (can't tell) there.

## Where the agent layer is tied to the `claude` program

For sizing a later "other models" job. All of these speak Claude Code's own
formats:

- `routes/observatory.py` `_build_cmd` — its flags (`-p`, `--resume`,
  `--allowedTools`, `--settings`, `--append-system-prompt`, stream-json in/out).
- `routes/observatory.py` `_run_turn` — reads its stream-json events line by
  line into the transcript; session ids, cost and errors come from them.
- `_session_settings` — the gates and the background-job rewrite are Claude
  Code hooks (`tools/act_ask_gate.py`, `tools/helper_gate.py`,
  `scripts/run_detached.py --hook`).
- `scripts/extract_footprints.py`, `toolcallstore.py` — read tool calls out of
  its `tool_use` blocks.
- `scripts/command_rollup.py`, `scripts/usage_events.py`, `scripts/usage_ledger.py`
  — read `~/.claude/projects` transcripts.
- `swarm_helper.py`, `recap_summary.py`, `scripts/sort_bot_chats.py` — run
  `claude` themselves for summaries and titles.
- Continuity is `--resume` plus Claude Code's per-folder conversation store.
