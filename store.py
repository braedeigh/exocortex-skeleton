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
# Receipt images and the recipe pipeline are bulkier, feature-specific stores. They
# default INSIDE the data layer so a fresh install is self-contained, but can be
# relocated to a sibling dir or a separate disk via env — same idea as DATA_DIR /
# CONTENT_DIR. (Defaulting them next to the *code* is what orphaned them on migration.)
RECEIPTS_DIR = Path(os.environ.get("EXOCORTEX_RECEIPTS_DIR", DATA_DIR / "receipts"))
RECIPES_DIR = Path(os.environ.get("EXOCORTEX_RECIPES_DIR", DATA_DIR / "recipes"))
# Archivals: photo files for the things-you-own catalog (imported from the old
# standalone inventory-app). Item metadata lives in archivals.json; the photo
# binaries live here — same relocation story as RECEIPTS_DIR.
ARCHIVALS_DIR = Path(os.environ.get("EXOCORTEX_ARCHIVALS_DIR", DATA_DIR / "archivals"))
# Triage: the "talk to it and it reorders your todos" Claude session works out of
# this folder (its CLAUDE.md is the skill). Defaults to a `triage/` at the
# deployment root (sibling of the data dir), next to recipes/; override via env.
TRIAGE_DIR = Path(os.environ.get("EXOCORTEX_TRIAGE_DIR", DATA_DIR.parent / "triage"))
# Person pages: the "regenerate impression" button opens a Claude session here
# (its CLAUDE.md is the skill) to draft a person's ## Impression with her, live.
# Same idea as TRIAGE_DIR — sibling of the data dir, override via env.
PERSON_SKILL_DIR = Path(os.environ.get("EXOCORTEX_PERSON_DIR", DATA_DIR.parent / "person-summary"))
# The ideas/vision doc that "send to ideas" (dev notes) appends to. Defaults
# inside the content store; point it at an existing ideas doc via env.
IDEAS_FILE = Path(os.environ.get("EXOCORTEX_IDEAS_FILE", CONTENT_DIR / "IDEAS.md"))
# Research library: the markdown corpus the /research page lists read-only.
# Sibling of the data dir (like TRIAGE_DIR), override via env.
RESEARCH_DIR = Path(os.environ.get("EXOCORTEX_RESEARCH_DIR", DATA_DIR.parent / "research"))
# Research filer: the "file the unfiled entries" Claude session works out of
# this folder (its CLAUDE.md is the skill) — same idea as TRIAGE_DIR.
RESEARCH_FILER_DIR = Path(os.environ.get("EXOCORTEX_RESEARCH_FILER_DIR", DATA_DIR.parent / "research-filer"))
# Research runner: the "send flagged entries to Claude" session works out of
# this folder (its CLAUDE.md is the skill) — same idea as RESEARCH_FILER_DIR.
RESEARCH_RUNNER_DIR = Path(os.environ.get("EXOCORTEX_RESEARCH_RUNNER_DIR", DATA_DIR.parent / "research-runner"))
# Research deep: the "deep-research this question" Claude session works out of
# this folder (its CLAUDE.md is the skill) — same idea as RESEARCH_RUNNER_DIR.
RESEARCH_DEEP_DIR = Path(os.environ.get("EXOCORTEX_RESEARCH_DEEP_DIR", DATA_DIR.parent / "research-deep"))
# Research worker: each annotation-batch question spawns its own short-lived
# Claude session here, gets a CLAUDE.md skill telling it to do ONE job then
# call the APPLY command and close its tmux session.
RESEARCH_WORKER_DIR = Path(os.environ.get("EXOCORTEX_RESEARCH_WORKER_DIR", DATA_DIR.parent / "research-worker"))
# Research distiller: a "mode": "distill" worker session (queued via
# POST /api/research/topic/distill, admitted by research_dispatcher.py same
# as any other worker) works out of this folder (its CLAUDE.md is the
# skill) — same idea as RESEARCH_WORKER_DIR, but it synthesizes a topic's
# reviewed answers into research/edge/<topic-id>.md instead of answering one
# question.
RESEARCH_DISTILLER_DIR = Path(os.environ.get("EXOCORTEX_RESEARCH_DISTILLER_DIR", DATA_DIR.parent / "research-distiller"))

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


def file_path(name: str) -> Path:
    """Public alias of _path for sqlstore (mirror-export and seed paths)."""
    return _path(name)


# --- SQLite migration (see sqlstore.py) ---
# Collections listed here are backed by SQLite: reads/writes/mutates route
# through sqlstore, which commits to the database of record and keeps the JSON
# file current as a derived MIRROR (git diffs + external readers keep
# working). Migrate a collection by adding its bare name (no .json) here —
# sqlstore adopts the existing file on first touch. EXOCORTEX_SQL_OFF=1 is the
# kill switch back to pure files (mirrors are always current, so it's safe to
# flip either way).
SQL_COLLECTIONS = frozenset((
    "active_inventory",
    "activity_log",
    "annotations",
    "archivals",
    "budget",
    "buy_list",
    "car_maintenance",
    "car_notes",
    "contacts",
    "deity_profiles",
    "dev_notes",
    "ecosystem",
    "ecosystem_config",
    "expense_receipts",
    "expenses",
    "food_tests",
    "grocery_item_rules",
    "grocery_trips",
    "growth_notes",
    "habit_cadence",
    "habit_meta",
    "habit_settings",
    "habit_start_dates",
    "habits_log",
    "housing",
    "idea_notes",
    "kitchen",
    "kitchen_trips",
    "meal_defaults",
    "meal_notes",
    "media",
    "meditation_log",
    "meditation_notes",
    "merchant_categories",
    "merchant_labels",
    "movement",
    "places",
    "priority_notes",
    "recipes",
    "reminders",
    "research",
    "research_vectors",
    "runs",
    "scheduled_prompts",
    "shrike_applied",
    "streaks",
    "subscriptions",
    "supplements",
    "symptom_definitions",
    "tax_setaside",
    "test_queue",
    "theme_settings",
))
# Deliberately NOT SQL-backed (each needs its writer normalized first):
#   todos, pending_changes — the add-todo Rust binary writes these FILES
#     directly (the "narrow door"); flipping them would make the app read a
#     database the binary doesn't write. They flip when the binary learns
#     SQLite or an ingest watcher lands.
#   sessions — routes/terminal.py does raw file I/O + mtime-watching for the
#     SSE stream; normalize it through store first.
#   shrike_seen / shrike_catches — written directly by the Shrike agent;
#     Flask never writes them (shrike_applied IS Flask-written, so it's in).
#   auth — read directly at startup, deliberately outside the store.
_SQL_OFF = os.environ.get("EXOCORTEX_SQL_OFF", "") == "1"


def _key(name: str) -> str:
    """Canonical collection key: the file name without the .json suffix."""
    return name[:-5] if name.endswith(".json") else name


def _sql_backed(name: str) -> bool:
    return not _SQL_OFF and _key(name) in SQL_COLLECTIONS


def read(name, default=None):
    """Read a collection. SQL-backed collections read from SQLite — what the
    app displays is what's in the database. Everything else reads its JSON
    file. Returns `default` (or {}) if the collection doesn't exist yet."""
    if _sql_backed(name):
        import sqlstore
        return sqlstore.get(_key(name), default)
    path = _path(name)
    if not path.exists():
        return {} if default is None else default
    return json.loads(path.read_text())


def write_file(name, data):
    """Write a JSON data file ATOMICALLY (no SQL dispatch — sqlstore calls
    this for mirror exports; app code should call write()).

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


def write(name, data):
    """Write a collection. SQL-backed collections commit to SQLite first, then
    export the JSON mirror; everything else writes its JSON file atomically."""
    import schemas
    schemas.validate(_key(name), data)
    if _sql_backed(name):
        import sqlstore
        sqlstore.put(_key(name), data)
        return
    write_file(name, data)


@contextmanager
def mutate(name, default=None):
    """Read-modify-write a collection safely, serialized across processes.

        with store.mutate("activity_log", {"entries": []}) as data:
            data["entries"].append(entry)
        # ^ written back atomically when the block exits

    SQL-backed collections run the whole block inside one BEGIN IMMEDIATE
    transaction (sqlstore.mutate). File-backed collections serialize under an
    flock. Either way: two simultaneous updates can't lose each other, and an
    exception inside the block writes nothing.
    """
    if _sql_backed(name):
        import sqlstore
        import schemas
        with sqlstore.mutate(_key(name), default) as data:
            yield data
            schemas.validate(_key(name), data)
        return
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
