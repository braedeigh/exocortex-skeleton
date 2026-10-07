#!/usr/bin/env python3
"""Start the desktop app's server: one command, nothing else to set up.

**What this does, in plain English.** Running this file is the whole of
"start the app" on a machine with no cron, no system service and no password:

    python3 scripts/standalone.py                 # default data folder, port 5123
    python3 scripts/standalone.py --port 0        # any free port
    python3 scripts/standalone.py --data ~/somewhere --exit-with-stdin

In order, it:
  1. picks the data folder (`--data`, else EXOCORTEX_DATA_DIR, else the
     per-user application-data folder) and creates it;
  2. switches standalone mode on and points every folder the app writes to
     INSIDE that data folder — nothing is written beside the code, which in a
     packaged app is read-only. On a data folder that has never been used it
     also copies in the seed, if the app was packaged with one
     (`standalone-seed/`, or EXOCORTEX_STANDALONE_SEED) — a first project
     with its map already read in;
  3. builds the small app (standalone_app.py), starts listening on this
     computer only, and prints ONE line of JSON on stdout:
         {"ready": true, "url": "http://127.0.0.1:5123", "port": 5123, "data_dir": "..."}
     A window wrapping this waits for that line and opens the url;
  4. starts the timed jobs (standalone_jobs.py);
  5. runs until it gets Ctrl-C / SIGTERM, or — with `--exit-with-stdin` — until
     whatever started it closes its end of stdin (so a crashed window never
     leaves a server behind).

Everything else it prints goes to stderr. It uses whichever Python ran it for
every process it starts (`sys.executable`), and never looks for `./venv`.

An agent turn that is running when the server stops keeps running: a turn
lives in its own process (scripts/turn_host.py). POST /api/standalone/stop-turns
stops them first if that's wanted.

Step 2 has to happen BEFORE the app is imported: store.py reads its folders
from the environment once, at import.

Touches: `standalone_app.py`, `standalone_jobs.py`, `config.py`
(`standalone()`), `store.py` (reads the folders set here),
`docs/standalone.md`.

Prompt that produced this file: "one command starts a server with only the
Observatory and Terrain routes, on an empty data folder it creates itself,
with no login wall on the local machine".
"""
import argparse
import json
import os
import shutil
import signal
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 5123
APP_FOLDER = "exocortex-desktop"
# The seed: a ready-made first project (scripts/standalone_seed.py makes it).
SEED_FOLDER = "standalone-seed"
SEED_FILE = "seed.json"


def default_data_dir():
    """The per-user folder applications keep their data in: Application
    Support on a Mac, XDG_DATA_HOME (or ~/.local/share) elsewhere."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_FOLDER
    base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / APP_FOLDER


def prepare_environment(data_dir, environ=os.environ):
    """Switch standalone mode on and point every writable folder inside the
    data folder. Returns the data folder, created.

    Anything the person already set is left alone (`setdefault`), except the
    two that define the mode itself."""
    data_dir = Path(data_dir).expanduser().resolve()
    for folder in (data_dir, data_dir / "content", data_dir / "jobs", data_dir / "kickoffs"):
        folder.mkdir(parents=True, exist_ok=True)
    environ["EXOCORTEX_STANDALONE"] = "1"
    environ["EXOCORTEX_DATA_DIR"] = str(data_dir)
    # Folders that default to somewhere outside the data folder on the live
    # site: the content store (its parent is what the app calls the vault
    # root), detached jobs' logs, and spawn logs.
    environ.setdefault("EXOCORTEX_CONTENT_DIR", str(data_dir / "content"))
    environ.setdefault("EXOCORTEX_JOBS_DIR", str(data_dir / "jobs"))
    environ.setdefault("EXOCORTEX_SPINOFF_KICKOFF_DIR", str(data_dir / "kickoffs"))
    # Don't write compiled .pyc files beside the code, here or in any process
    # started from here.
    environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True
    # The runtime sensor maps which of THIS app's functions ran — a view of
    # the app's own code, which the desktop app doesn't show.
    environ.setdefault("EXOCORTEX_RUNTIME_SENSOR", "0")
    # terminal.py is registered for the roster's /api/sessions only; its
    # type-into-a-shell doors stay off (features.py, `web_terminal`).
    environ.setdefault("EXOCORTEX_FEATURE_WEB_TERMINAL", "0")
    # Use one named git everywhere. Every caller runs plain `git`, so putting
    # the chosen program's folder first on PATH is what points them all at it.
    git = environ.get("EXOCORTEX_GIT_BIN")
    if git and os.sep in git:
        environ["PATH"] = str(Path(git).expanduser().parent) + os.pathsep + environ.get("PATH", "")
    # Find Claude Code once, by full path, so every process started from here
    # (turn hosts, timed jobs) uses the same one whatever its own PATH is.
    claude = shutil.which(environ.get("EXOCORTEX_CLAUDE_BIN") or "claude")
    if claude:
        environ["EXOCORTEX_CLAUDE_BIN"] = claude
    return data_dir


def place_seed(data_dir, seed_dir):
    """Copy the seed into a data folder that has never been used, so the
    first start has a project and its map with no download and no wait.
    True when it was copied.

    Only ever on a brand-new folder — one with no database yet — because the
    seed brings a database of its own, and copying that over a used one would
    throw the person's sessions away. This runs before the app is imported
    (the database is opened at import); standalone_app.adopt_seed then puts
    the project on the list."""
    data_dir, seed_dir = Path(data_dir), Path(seed_dir)
    try:
        seed = json.loads((seed_dir / SEED_FILE).read_text())
        code = seed_dir / "projects" / seed["id"]
    except (OSError, ValueError, KeyError, TypeError):
        return False     # no seed here, or not one this can read
    placed = data_dir / "projects" / seed["id"]
    if (data_dir / "exo.db").exists() or placed.exists():
        return False
    if not code.is_dir() or not (seed_dir / "exo.db").is_file():
        return False
    # The code first and the database last: the database is what marks the
    # folder as used, so a copy cut short is simply tried again next start.
    try:
        shutil.copytree(code, placed, symlinks=True)
        shutil.copyfile(seed_dir / SEED_FILE, data_dir / SEED_FILE)
        shutil.copyfile(seed_dir / "exo.db", data_dir / "exo.db")
    except OSError as problem:
        shutil.rmtree(placed, ignore_errors=True)
        print(f"seed: could not copy it in ({problem})", file=sys.stderr)
        return False
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description="Start the desktop app's server.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port to listen on; 0 picks a free one (default {DEFAULT_PORT})")
    parser.add_argument("--data", help="data folder (default: the per-user app-data folder)")
    parser.add_argument("--exit-with-stdin", action="store_true",
                        help="stop when stdin closes (for a window that started this)")
    parser.add_argument("--no-jobs", action="store_true",
                        help="don't start the timed jobs")
    options = parser.parse_args(argv)

    data_dir = prepare_environment(
        options.data or os.environ.get("EXOCORTEX_DATA_DIR") or default_data_dir())

    place_seed(data_dir, os.environ.get("EXOCORTEX_STANDALONE_SEED") or ROOT / SEED_FOLDER)

    # Only now import the app: store.py reads the folders set above at import.
    sys.path.insert(0, str(ROOT))
    from werkzeug.serving import make_server
    import config
    import standalone_app
    import standalone_jobs

    app = standalone_app.create_app()
    # This computer only. `threaded` gives each request its own thread, which
    # the chat's long-lived follow stream needs.
    server = make_server("127.0.0.1", options.port, app, threaded=True)
    port = server.server_port

    scheduler = standalone_jobs.Scheduler(helpers=config.standalone_helpers())
    if not options.no_jobs and not scheduler.start(data_dir):
        print("timed jobs: another server on this data folder is running them",
              file=sys.stderr)

    # Stop cleanly on Ctrl-C / SIGTERM, and on stdin closing when asked.
    # shutdown() has to be called from a thread other than the serving one.
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if options.exit_with_stdin:
        def wait_for_stdin_to_close():
            try:
                while sys.stdin.buffer.read(4096):
                    pass
            except (OSError, ValueError):
                pass
            stop()
        threading.Thread(target=wait_for_stdin_to_close, daemon=True).start()

    print(json.dumps({"ready": True, "url": f"http://127.0.0.1:{port}", "port": port,
                      "data_dir": str(data_dir)}), flush=True)
    try:
        server.serve_forever()
    finally:
        scheduler.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
