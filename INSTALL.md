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
