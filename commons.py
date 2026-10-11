"""The commons — where public reference data lives, and its manifest.

**What this is.** Some data the app uses isn't anyone's life data: government
residue surveys, diet studies, health-risk reference doses, the PDFs they come
in. It is public, it is big, and the point of keeping it is that anyone can
re-check a calculation against the very file it came from. So it lives in a
third place, the COMMONS, apart from both the code (this repo) and the owner's
private vault. The commons is a folder — ideally its own git repo — holding
every file exactly as its publisher released it, sorted by source
(`<commons>/<source>/<file>`), plus `manifest.json`, one entry per file: where
it came from, when it was fetched, how big it is, and its sha256 checksum.

**Where the folder is**, first hit wins (the same order features.py uses):
    1. env var  EXOCORTEX_COMMONS_DIR
    2. `commons.json` in the data dir, e.g. {"dir": "/srv/commons"} — so an
       install can move it without touching the service's environment
    3. `<data dir>/commons` as the default

Anything built FROM the files (a `commons.db` of parsed rows) is derived and
rebuildable, so the commons repo ignores it; the files and the manifest are
the record.

Touches: `store.py` (the data dir), `scripts/commons_fetch.py` (the only door
files come in through), `tests/test_commons.py`, and `docs/projects.md`.

Prompt that produced this file: public reference data ("USDA PDP sample rows,
FDA Total Diet Study results, downloaded source PDFs, EPA reference doses")
"isn't storing my life data … could even maybe go in the skeleton" — decided:
save all the files and PDFs "for people to comb through if they want", in a
commons outside both repos.
"""
import hashlib
import json
import os
from pathlib import Path

import store

MANIFEST = "manifest.json"
SETTING_FILE = "commons.json"

# GitHub refuses any single file over 100 MB, and one refused file blocks the
# whole push. Stay under it with room to spare.
MAX_FILE_BYTES = 95 * 1024 * 1024


def commons_dir():
    """Where the commons lives. Resolved at call time so tests can re-point it."""
    # Take the env var first, then the data-dir setting, then the default.
    env = os.environ.get("EXOCORTEX_COMMONS_DIR")
    if env:
        return Path(env)
    try:
        setting = json.loads((store.DATA_DIR / SETTING_FILE).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        setting = {}
    if isinstance(setting, dict) and setting.get("dir"):
        return Path(setting["dir"])
    return store.DATA_DIR / "commons"


def read_manifest(root=None):
    """Every file in the commons, as the manifest lists them (empty if none yet)."""
    root = Path(root or commons_dir())
    try:
        data = json.loads((root / MANIFEST).read_text())
    except FileNotFoundError:
        return {"files": []}
    data.setdefault("files", [])
    return data


def write_manifest(data, root=None):
    """Save the manifest atomically — a temp file renamed into place."""
    root = Path(root or commons_dir())
    root.mkdir(parents=True, exist_ok=True)
    # Sort by path so the file diffs cleanly in git no matter the fetch order.
    data["files"] = sorted(data.get("files", []), key=lambda entry: entry["path"])
    temp = root / (MANIFEST + ".tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    os.replace(temp, root / MANIFEST)


def sha256_of(path):
    """The file's checksum, read in 1 MB chunks so a big file never sits in memory."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(root=None):
    """Re-check every manifest entry against the file on disk.

    Returns a list of problems, each a (path, what's wrong) pair — empty means
    every file is present and still the exact bytes that were fetched.
    """
    root = Path(root or commons_dir())
    problems = []
    for entry in read_manifest(root)["files"]:
        path = root / entry["path"]
        if not path.exists():
            problems.append((entry["path"], "missing"))
        elif sha256_of(path) != entry["sha256"]:
            problems.append((entry["path"], "checksum changed"))
    return problems
