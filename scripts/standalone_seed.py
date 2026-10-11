#!/usr/bin/env python3
"""Make the desktop app's seed: this app's own code with its map already read
in, so a fresh install shows something the instant it opens.

**What this does, in plain English.** A new copy of the desktop app starts on
an empty data folder. Without a seed, its first project has to be downloaded
and its commit history read — about a minute, and it needs the network. This
script does that work once, when the app is being packaged, and saves the
result as a folder the app copies into place on its first start:

    standalone-seed/
      seed.json            what the project is: {id, name, source, commits, made}
      projects/<id>/       the code itself, a git clone with its full history
      exo.db               a new database holding only that history, read in

    python3 scripts/standalone_seed.py                      # into ./standalone-seed
    python3 scripts/standalone_seed.py --out DIR --from /a/local/checkout

`--from` is where to clone from (default: the published address,
`config.standalone_sample_repo()`). Cloning from a local checkout needs no
network; the clone's `origin` is set to the published address either way.

The seed is as old as the day it was made — the map a new install first sees
is the release's, not today's. `scripts/standalone.py` (`place_seed`) copies
it in; `standalone_app.adopt_seed` puts it on the list of projects.

Touches: `scripts/standalone.py` (reuses its environment setup, and copies
the seed in), `codestore.py` (reads the history), `buildlist.py` (the id and
name), `sqlstore.py` (the database), `docs/standalone.md`.

Prompt that produced this file: the owner, asked whether the app should ship
with the exocortex map already loaded: "correct, no wait and no network for
the first try."
"""
import argparse
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# No compiled .pyc files beside the code — set before the first app import.
sys.dont_write_bytecode = True

from scripts import standalone  # noqa: E402  (stdlib only; sets no environment on import)


def make_seed(out, clone_from=None):
    """Build the seed folder at `out` (replacing one already there) and
    return what seed.json says. Raises RuntimeError with a sentence when the
    clone or the history read fails."""
    out = Path(out).expanduser().resolve()
    with tempfile.TemporaryDirectory(prefix="exo-seed-") as scratch:
        # A throwaway data folder, set up exactly as the app sets up a real
        # one — BEFORE the app's modules are imported, because store.py reads
        # its folders from the environment at import.
        standalone.prepare_environment(Path(scratch) / "data")
        import buildlist
        import codestore
        import config
        import sqlstore

        source = config.standalone_sample_repo()
        parsed = buildlist.parse_github(source)
        if parsed is None:
            raise RuntimeError("no published address for the app's code is set "
                               "(EXOCORTEX_STANDALONE_SAMPLE_REPO)")
        build_id, name = buildlist.slug(parsed[1]), buildlist.display_name(parsed[1])

        # Clone into a scratch folder first, so a failed run leaves the old
        # seed (if any) untouched.
        clone = Path(scratch) / "clone"
        # --no-local: even from a folder on this disk, fetch the way a
        # download does, so the clone is one tight pack (about a seventh the
        # size of a straight copy of a working checkout's .git).
        cloned = subprocess.run(["git", "clone", "--quiet", "--no-local",
                                 str(clone_from or source), str(clone)],
                                capture_output=True, text=True, stdin=subprocess.DEVNULL)
        if cloned.returncode != 0:
            raise RuntimeError(f"git clone failed: {cloned.stderr.strip()[-400:]}")
        # Wherever it was cloned from, later updates come from the published
        # address.
        subprocess.run(["git", "-C", str(clone), "remote", "set-url", "origin", source],
                       check=True, stdin=subprocess.DEVNULL)

        # Read the history into the throwaway database, then copy that
        # database out with SQLite's own backup, which gives one whole file
        # with nothing left behind in a side journal.
        codestore.update([{"id": build_id, "name": name, "root": clone}])
        commits = codestore.repo_summary(build_id)["commits"]
        if not commits:
            raise RuntimeError("the clone has no commits to read")
        if out.exists():
            shutil.rmtree(out)
        (out / "projects").mkdir(parents=True)
        live = sqlite3.connect(sqlstore._db_path())
        saved = sqlite3.connect(out / "exo.db")
        with saved:
            live.backup(saved)
        saved.close()
        live.close()
        shutil.move(str(clone), str(out / "projects" / build_id))
        described = {"id": build_id, "name": name, "source": source, "commits": commits,
                     "made": time.strftime("%Y-%m-%d %H:%M:%S")}
        (out / standalone.SEED_FILE).write_text(json.dumps(described, indent=2) + "\n")
        return described


def main(argv=None):
    parser = argparse.ArgumentParser(description="Make the desktop app's seed folder.")
    parser.add_argument("--out", default=str(ROOT / standalone.SEED_FOLDER),
                        help="where to write it (default: ./standalone-seed)")
    parser.add_argument("--from", dest="clone_from",
                        help="clone from here instead of the published address")
    options = parser.parse_args(argv)
    try:
        described = make_seed(options.out, options.clone_from)
    except RuntimeError as problem:
        print(f"seed not made: {problem}", file=sys.stderr)
        return 1
    print(json.dumps(described))
    return 0


if __name__ == "__main__":
    sys.exit(main())
