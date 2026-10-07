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
| `tests/test_standalone.py` | the proof |

Settings (all environment variables): `EXOCORTEX_STANDALONE_HELPERS=1` turns the
background helpers on; `EXOCORTEX_STANDALONE_SAMPLE_REPO` is the public address
of the app's own code for a packaged copy; `EXOCORTEX_GIT_BIN` and
`EXOCORTEX_CLAUDE_BIN` name those two programs.

## Projects

A project is one code folder with its own map — the same thing Terrain calls a
build (`buildlist.py`). One project is *current*: the main map draws it and new
sessions stand in it. The app's own code is offered as the first project; the
person's own folder, or a repo downloaded from its address, is another.

| Door | What it does |
|---|---|
| `GET /api/standalone` | is Claude Code there and signed in, is git there, the current project and its state (`none`, `downloading`, `loading`, `ready`, `failed`), every project, running turns, settings |
| `POST /api/standalone/project` | `{"path"}` a folder here, `{"url"}` download one, `{"own": true}` the app's own code, `{"id"}` switch |
| `POST /api/standalone/settings` | `{"ask_first": bool}` — whether new sessions ask before what they can't undo (off: they just act) |
| `GET /api/standalone/folders` | the folders inside a path, for a folder picker |
| `POST /api/standalone/stop-turns` | stop every running agent turn |

The page learns the mode from `window.STANDALONE` (`routes/spa.py`).

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
- **cron** → `standalone_jobs.py`, a thread that runs the same scripts on the
  same cadences, each as its own process: the minute heartbeat (mailbox, dead
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

- Everything that isn't the Observatory or Terrain: its routes answer 404.
- The night crew, the research and Linear rooms, the Keeper and its rollover,
  the Coming up reminders, phone push, the sudo password card (the door
  answers an empty list), the public mirror, the type-into-a-shell terminal.
- The helpers (room, swarm, wake-ups), the auto-titler and the day-idle check
  are **off unless switched on**: each starts Claude calls nobody asked for.
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
  repos only.
- **Claude Code's login on a Mac** lives in the keychain, so `signed_in` is
  `null` (can't tell) there.
- **The journal** is not in the desktop app.

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
