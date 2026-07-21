# Installing on your own computer

The five-minute local setup — for trying the exocortex on a laptop, yours or a
friend's. (For a public server with a domain and HTTPS, see [DEPLOY.md](DEPLOY.md).
For a Mac — Apple Silicon quirks, plus the optional always-on launchd + Tailscale
build — see [docs/SETUP-MACOS.md](docs/SETUP-MACOS.md).)

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
keep): `/journalstart` and `/endsession` ship as project-level commands
(`.claude/commands/`, committed), so they're available as soon as you open
Claude Code at this repo's root — run `/journalstart` to wake the keeper,
`/endsession` to close the day out. (Restart Claude Code after pulling so it
re-reads the command list.) `install.sh` additionally symlinks them into
`~/.claude/commands/` so they work from any directory (skipping, with a printed
note, any command name you already have — it never overwrites your own), and
writes `.claude/settings.json` in this repo (only if that file doesn't already
exist) wiring the capture hook, `data/_system/keeper_capture.py`. The
`settings.json` wiring is gitignored — local to your machine, never committed.

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

## Usage tracking (self-telemetry — yours, local, opt-in to share)

The app quietly counts its own use, so *you* can see which parts of it earn
their place: tab visits and active time (a dwell clock that pauses when the
page is hidden or idle), taps on tagged controls in the To Do and Journal
tabs, and — on a server install with the cron jobs — which API routes and
data collections actually fire. Everything lands day-by-day in one local
collection (`feature_usage`); nothing is content, nothing leaves your
machine, and nothing records times of day (day-level granularity only).

Three ways to look at it:

- **Usage heat view** (Settings → toggle): on the To Do and Journal tabs,
  tints every tracked control by how often you actually tap it — cool dashed
  ring for never-used through a warm wash for your most-used — with a small
  taps · hours · visits pill. Flip it off, it vanishes without a trace.
- **Weekly architecture pulse** (server installs, Sunday cron): a `[usage]`
  dev note listing top routes, top collections per process, tab hours, and —
  the useful inverse — what got **zero traffic**.
- **Export** (Settings → "Export usage data"): downloads the counts as a
  single self-describing JSON file (`usage-export/1`). It carries no name, no
  domain, no content — tab/control/route names come from the app itself, so
  two people's exports speak the same vocabulary and can be compared
  side-by-side (`scripts/usage_compare.py`). The file lands on your device
  and goes nowhere unless you choose to send it to someone. It's readable
  JSON on purpose: look it over before you share it.
