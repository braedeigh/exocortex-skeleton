# Spinoff briefs — kept in the database, not in folders

A brief says what a spun-off session is asked to do. Until 2026-10-02 each job
had a folder of files (`spinoffs/<slug>/BRIEF.md`, `CONTEXT.md`, `HANDOFF.md`).
Now they are rows in `exo.db`, owned by `briefstore.py`.

Prompt: "I need some other organization of the /spinoffs. I don't know why
they're /brief in a folder ... I would rather have some other backend rather
than all these files" — then: "Let's put it in the database and have it auto
inject through whatever backend machinery into the prompt directly?"

## The three tables

| table | one row is | tagged by |
|---|---|---|
| `spinoff_briefs` | a brief: its text, who wrote it, the session started on it, the session it continues | `slug` (the job's name) and `written_at` |
| `spinoff_contexts` | the hidden instructions built for a brief when its session started: the Protocol and the files listed under "Where to look", as they were then | its brief |
| `spinoff_handoffs` | what a session wrote when it filled its context and handed its work on | the session that wrote it, and the one that took over |

A session's entry in `bot_chats/index` carries `spinoff_brief`, the row id of
its brief. A brief with no session yet is a draft: saving the same slug again
replaces it. Once a session has started on a brief the row is never changed.
A continuation is a new row under the SAME slug, with `continues` naming the
session it carries on from, so a job keeps one name however many sessions it
runs through.

Reading them: `scripts/exo_query.py query "select slug, written_at, conv from
spinoff_briefs order by written_at desc limit 20"`.

## How a brief gets in

- **An agent** (the `/spinoff` skill, a room or swarm helper) hands the text
  to `scripts/spinoff_brief.py <slug>` on standard input, as a quoted
  here-document. `--show` prints what is saved. The helper gate
  (`tools/helper_gate.py`) lets a helper run exactly that command; a helper
  writes no files at all.
- **The app's own buttons** call `briefstore.save`: `routes/helpers.py`
  (triage, recipe, receipt, person), `routes/branches.py` (stewards), the fork
  button in `routes/observatory.py`, `scripts/nightly_tests.py`.
- **A continuation**: `continuation.hand_off` keeps the handoff and saves the
  new session's brief. The agent sends its handoff on standard input to
  `scripts/peers.py handoff` (`--file <path>` still works).

## How it reaches the prompt

`routes/spinoff.py` `open_spinoff` reads the newest brief saved under the
slug, refuses it if "Where to look" names a file that doesn't exist, and sends
the brief's text as the session's first message. No file is involved.

The context is the one part that still passes through a file. The `claude`
command takes a large system prompt only by path: one command-line argument
stops at 128 KB and a context runs to 200 KB. So at the start of every turn
`routes/observatory.py` (`begin_turn`) calls `briefstore.context_file`, which
writes the context from the database to `<data dir>/.spinoff_context/<brief
id>.md` and hands that path to the turn. The folder is a cache that is rebuilt
on demand: delete it and the next turn writes its file again.
`EXOCORTEX_SPINOFF_CONTEXT_DIR` moves it. The vault's `.gitignore` keeps it out
of the hourly backup.

## Where she reads one

The "brief" button in a spun-off session's chat opens
`/observatory/brief/<session id>` (`SessionBriefPage.tsx`, fed by
`GET /api/spinoff/brief/<conv>`): the brief, the files that were preloaded,
the hidden instructions whole, and any handoffs.

## Backup and restore

`exo.db` itself is not in the hourly backup (it is past GitHub's file size
limit). The vault's `scripts/git_backup.sh` writes `spinoff_briefs` and
`spinoff_handoffs` out as text every hour, to `data/spinoff_briefs.sql`,
beside the `job_runs` dump. `spinoff_contexts` is left out on purpose: it is
several megabytes of copies of files that were on disk, and a session that has
lost its context still has its brief.

To restore into a database that has the tables but not the rows:
`sqlite3 data/exo.db < data/spinoff_briefs.sql` (the `CREATE TABLE` lines in
the dump fail harmlessly when the tables exist; the `INSERT`s load).

## The old folders

`scripts/import_spinoff_briefs.py` brought every folder in `spinoffs/` and
`spinoff_archive/` into the tables, stamped `spinoff_brief` on each session it
could match, and checks every file against its row word for word
(`--check`). It deletes nothing.

Sessions that were already running keep working:

- An entry whose `system_prompt_file` still exists on disk keeps using that
  file. When the file is gone, the turn is handed the same text from the
  database.
- A brief written the old way, as `spinoffs/<slug>/BRIEF.md`, is taken into
  the database when its session is opened (`briefstore.latest`).
- Closing a session that has a folder still files the folder in
  `spinoff_archive/` (`archive_spinoff`). A session born since has no folder.

`spinoffs/.kickoffs/` is not briefs: it holds each start-up's log (and, for a
moment, the kickoff text on its way to the runner). It stays where it is and
prunes itself after 14 days.
