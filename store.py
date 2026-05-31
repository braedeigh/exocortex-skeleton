"""The single read/write path for all JSON data.

Every piece of app data is a JSON file in data/. This module is the ONLY place
that should touch those files directly. Routing all access through here buys us:

  - ATOMIC writes — a crash or collision mid-write can never corrupt or truncate
    a file (and these files are the only copy of the data).
  - SAFE read-modify-write — `mutate()` serializes concurrent updates so two
    gunicorn workers can't clobber each other.
  - ONE seam for multi-user — when we add per-user data later, only `_path()`
    changes, not the 250+ call sites scattered across the route modules.
"""
from pathlib import Path
from contextlib import contextmanager
import json
import os
import tempfile
import fcntl

# --- Where everything lives (the lowest layer; other modules import these) ---
# Code path is fixed (it's wherever this file sits). DATA path is overridable via
# the EXOCORTEX_DATA_DIR env var, so the data can physically live somewhere else
# than the code — a mounted drive, a synced folder, a different disk on the Pi.
# That's "separate the data from the structure" with zero code changes: point the
# env var at the data, the code doesn't care where it is.
BUILD_DIR = Path(__file__).parent
DATA_DIR = Path(os.environ.get("EXOCORTEX_DATA_DIR", BUILD_DIR / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"  # personal uploads live in the data layer, not the code dir
# Markdown content (habits, journal, meetings, intro). Defaults to the data dir so a new
# user is self-contained; override with EXOCORTEX_CONTENT_DIR to point at an existing
# content store (e.g. a separate journaling system that also reads/writes these files).
CONTENT_DIR = Path(os.environ.get("EXOCORTEX_CONTENT_DIR", DATA_DIR))

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _path(name: str) -> Path:
    """Resolve a data-file name to its path. The '.json' suffix is optional.

    This is the multi-user seam: the day we add users, this is the ONE function
    that changes — e.g. `return DATA_DIR / user_id / name`. Nothing else moves.
    """
    if not name.endswith(".json"):
        name += ".json"
    return DATA_DIR / name


def read(name, default=None):
    """Read a JSON data file. Returns `default` (or {} ) if it doesn't exist yet."""
    path = _path(name)
    if not path.exists():
        return {} if default is None else default
    return json.loads(path.read_text())


def write(name, data):
    """Write a JSON data file ATOMICALLY.

    We write to a temp file in the same directory, fsync it, then os.replace()
    it over the target. os.replace() is atomic on Linux: any reader sees either
    the complete old file or the complete new file — never a half-written one.
    If the process dies mid-write, the original is left untouched.
    """
    path = _path(name)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


@contextmanager
def mutate(name, default=None):
    """Read-modify-write a file safely, under a cross-process lock.

        with store.mutate("activity_log", {"entries": []}) as data:
            data["entries"].append(entry)
        # ^ written back atomically when the block exits

    The flock serializes the whole read->modify->write against other workers, so
    two simultaneous updates can't lose each other. The write itself is atomic.
    """
    path = _path(name)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        data = read(name, default)
        yield data
        write(name, data)


# --- Backward-compatible aliases ---
# data_helpers.py historically exposed these names; keep them so the existing
# `from data_helpers import load_json, save_json` call sites keep working — and
# now get atomic writes for free.
def load_json(filename, default=None):
    return read(filename, default)


def save_json(filename, data):
    write(filename, data)
