# Installing on your own computer

The five-minute local setup — for trying the exocortex on a laptop, yours or a
friend's. (For a public server with a domain and HTTPS, see [DEPLOY.md](DEPLOY.md).)

## You need
- **Python 3.11+** and **Node 20+** (mac: `brew install python node`)
- The code. Either `git clone` this repo (it's private — you need collaborator
  access), or just copy the whole folder from another machine — it's only files.
  A copied folder works exactly like a clone.

## Install and run

```bash
./install.sh                      # creates venv, installs deps, builds the frontend
./venv/bin/python3 server.py      # starts it on http://localhost:5000
```

Open http://localhost:5000, log in with the password **`exocortex`**, and
**change it in Settings right away**.

> **Mac note:** if it says *Address already in use*, that's AirPlay Receiver
> squatting on port 5000. Start on another port instead:
> `PORT=5050 ./venv/bin/python3 server.py` → http://localhost:5050.

That's the whole thing. Re-running `install.sh` is always safe.

## Where your data lives

Everything you enter is stored in `data/` inside this folder — plain JSON plus
a SQLite database, no cloud, no accounts. **Back up `data/` and you've backed
up everything.** (To keep data somewhere else, set `EXOCORTEX_DATA_DIR` to a
directory of your choice before starting the server.)

## What won't work on a laptop (expected)

- **Terminal and Research tabs** — these drive Claude Code sessions over tmux
  on the author's server. On a fresh install they're inert, not broken.
- The app ships with the author's defaults (symptom list, food guide, activity
  types). Usable as-is; personalizing them is ongoing work — see
  [SHARE_TODO.md](SHARE_TODO.md).

## Everyday use

- Start it again any time with `./venv/bin/python3 server.py`.
- After pulling new code, re-run `./install.sh` (it picks up new deps and
  rebuilds the frontend).

## Journaling

The journal ("cards" — the day-view tab) works out of the box: the first time the
server boots against an empty `data/` dir, it seeds `data/_system/` with a small,
deterministic engine (`stream.py`) plus a generic seed keeper persona
(`data/CLAUDE.md`) and empty `Journal/Daily/`, `Journal/Weekly/`, and
`keeper-diary/` folders. Nothing to configure — add, edit, and delete cards
right away. (If you've pointed `EXOCORTEX_CONTENT_DIR` at an existing journal
of your own, seeding is skipped entirely — it never touches a directory that
already has a `_system/stream.py`.)

**Talking to it through Claude Code** (optional, but where the journal earns its
keep): `install.sh` symlinks `claude-commands/journalstart.md` and
`claude-commands/endsession.md` into `~/.claude/commands/` (skipping, with a
printed note, any command name you already have — it never overwrites your own)
and writes `.claude/settings.json` in this repo (only if that file doesn't
already exist) wiring the capture hook, `data/_system/keeper_capture.py`. Open
Claude Code at this repo's root and run `/journalstart` to wake the keeper;
`/endsession` closes the day out. `.claude/` is gitignored — that wiring is
local to your machine, never committed.

**Optional: the reconciler cron.** The hook captures everything typed directly
into an armed terminal session the instant it's sent; a per-minute cron job is
a safety net underneath it, in case a hook ever goes stale mid-session:

```
* * * * * cd /path/to/this/repo && ./venv/bin/python3 data/_system/reconcile_transcripts.py
```

Without the cron, capture still works — it's just entirely dependent on the
hook firing every time, with no automatic catch-up if it doesn't.

**Making the keeper yours.** `data/CLAUDE.md` is a seed manifest — it explains
the recording mechanics and a starting voice, but the bottom section ("Who
you're keeping for — fill this in") is intentionally blank. Fill it in, and
start `data/context/about.md` as the living record of what's current in your
life, the first time you sit down with it.
