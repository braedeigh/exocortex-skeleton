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
from datetime import datetime
import atexit
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
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
# The journaling seed tree (engine code under _system/, a seed keeper CLAUDE.md, and
# empty Journal/keeper-diary dirs — see seed_content_scaffold() below) ships as code,
# next to this file, not as data.
CONTENT_SCAFFOLD_DIR = BUILD_DIR / "content-scaffold"
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
# Recordings: the audio + transcript files for routes/recordings.py. The
# metadata (title, date, tags, which files belong to which recording) lives in
# recordings.json; the bulky parts — audio blobs and full transcript text —
# live here as loose files. Audio is the biggest thing this app stores, so this
# is the root most likely to get pointed at a different disk: same env-override
# story as RECEIPTS_DIR / ARCHIVALS_DIR.
RECORDINGS_DIR = Path(os.environ.get("EXOCORTEX_RECORDINGS_DIR", DATA_DIR / "recordings"))
# Triage: the "talk to it and it reorders your todos" Claude session works out of
# this folder (its CLAUDE.md is the skill). Defaults to a `triage/` at the
# deployment root (sibling of the data dir), next to recipes/; override via env.
TRIAGE_DIR = Path(os.environ.get("EXOCORTEX_TRIAGE_DIR", DATA_DIR.parent / "triage"))
# Spinoff: the shared spawn door for /spinoff — briefs live one per slug at
# SPINOFF_DIR/<slug>/BRIEF.md. Under DATA_DIR (not a sibling like TRIAGE_DIR):
# briefs are personal data and should ride the vault's hourly git backup.
SPINOFF_DIR = Path(os.environ.get("EXOCORTEX_SPINOFF_DIR", DATA_DIR / "spinoffs"))
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


def seed_content_scaffold():
    """Populate a fresh CONTENT_DIR with the whole journaling seed tree — the engine
    (stream.py + keeper_capture.py + reconcile_transcripts.py under `_system/`), a
    generic seed keeper `CLAUDE.md`, and empty `Journal/Daily/`, `Journal/Weekly/`,
    `keeper-diary/`, and `_system/data/cards/` dirs — see content-scaffold/ next to
    this file. Without this, a fresh install's journal (routes/cards.py, which shells
    out to CONTENT_DIR/_system/stream.py) has nothing to talk to and 404s.

    Gated on CONTENT_DIR/_system/stream.py already existing: an install whose
    CONTENT_DIR points at a pre-existing engine (e.g. the author's own vault, wired in
    via EXOCORTEX_CONTENT_DIR) is left completely untouched. Copies file by file and
    skips anything already present, so it's idempotent and safe to call on every boot —
    it can only ever ADD the scaffold's files, never overwrite one.
    """
    if (CONTENT_DIR / "_system" / "stream.py").exists():
        return
    if not CONTENT_SCAFFOLD_DIR.exists():
        return  # scaffold missing (e.g. a stripped-down deploy) — nothing to seed
    for src in sorted(CONTENT_SCAFFOLD_DIR.rglob("*")):
        if src.is_dir():
            continue
        dst = CONTENT_DIR / src.relative_to(CONTENT_SCAFFOLD_DIR)
        if dst.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    (CONTENT_DIR / "_system" / "data" / "cards").mkdir(parents=True, exist_ok=True)


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
    "feature_usage",
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
    "recordings",
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


# --- Per-collection op counters (architecture telemetry) ---------------------
# Every read()/write()/mutate() bumps an in-process counter keyed by
# (caller, collection, kind); roughly once a minute the counters fold into
# today's days[<date>]["store"][<caller>][<collection>] = {"reads", "writes"}
# in feature_usage.json (ONE mutate, += accumulate — the fifth writer, see
# routes/usage.py), piggybacked on whatever counted op happens to be passing
# through (no timer thread), plus a best-effort atexit flush. This is the
# hottest path in the app, so the rules are strict:
#   - telemetry can NEVER break a real op — every hook swallows everything;
#   - feature_usage itself is never counted (the flush writes it: no
#     recursion, no self-counting), and a thread-local re-entry guard keeps
#     the flush's own mutate from counting or re-triggering a flush;
#   - a flush is deferred while this thread is inside a mutate() block (a
#     nested feature_usage mutate would stall on SQLite's write lock) — it
#     just waits for the next counted op outside one;
#   - EXOCORTEX_STORE_STATS_OFF=1 kills counting AND flushing entirely,
#     checked per op (a dict lookup — cheap, and monkeypatchable in tests;
#     tests/conftest.py sets it for the whole suite).

_STATS_FLUSH_EVERY = 60.0            # seconds between piggybacked flushes
_STATS_EXCLUDED = "feature_usage"    # the collection the flush itself writes
_stats_lock = threading.Lock()
_stats_counts = {}                   # (caller, collection, kind) -> n
_stats_last_flush = time.monotonic()
_stats_caller_cache = None           # computed once, lazily; tests reset to None
_stats_tls = threading.local()       # .in_flush (re-entry), .mutate_depth


def _stats_off():
    return os.environ.get("EXOCORTEX_STORE_STATS_OFF", "") == "1"


def _stats_caller():
    """This process's label: EXOCORTEX_PROC if set, else argv[0]'s basename
    minus a trailing .py; sanitized to lowercase [a-z0-9_-], max 40 chars,
    empty -> 'unknown'. Computed once, lazily."""
    global _stats_caller_cache
    if _stats_caller_cache is None:
        raw = os.environ.get("EXOCORTEX_PROC") or ""
        if not raw:
            raw = os.path.basename(sys.argv[0] or "")
            if raw.endswith(".py"):
                raw = raw[:-3]
        raw = re.sub(r"[^a-z0-9_-]", "-", raw.lower())[:40]
        _stats_caller_cache = raw or "unknown"
    return _stats_caller_cache


def _stats_count(name, kind):
    """Count one op ('reads' or 'writes'); maybe piggyback a flush. Any
    exception is swallowed — the real operation must never notice."""
    try:
        if _stats_off() or getattr(_stats_tls, "in_flush", False):
            return
        collection = _key(name)
        if collection == _STATS_EXCLUDED:
            return
        key = (_stats_caller(), collection, kind)
        with _stats_lock:
            _stats_counts[key] = _stats_counts.get(key, 0) + 1
            due = (time.monotonic() - _stats_last_flush) >= _STATS_FLUSH_EVERY
        if due and not getattr(_stats_tls, "mutate_depth", 0):
            _stats_flush()
    except Exception:
        pass


def _stats_flush():
    """Fold the counters into today's ["store"] key via ONE mutate, then
    reset them. Best-effort: any failure (data dir gone at interpreter exit,
    SQLite locked, ...) is swallowed and that window's counts are lost.
    Registered with atexit; tests call store._stats_flush() directly."""
    global _stats_last_flush
    try:
        if _stats_off() or getattr(_stats_tls, "in_flush", False):
            return
        with _stats_lock:
            _stats_last_flush = time.monotonic()
            if not _stats_counts:
                return
            counts = dict(_stats_counts)
            _stats_counts.clear()
        _stats_tls.in_flush = True
        try:
            today = datetime.now().strftime("%Y-%m-%d")
            with mutate("feature_usage.json", {"days": {}}) as data:
                day = data.setdefault("days", {}).setdefault(today, {})
                seam = day.setdefault("store", {})
                for (caller, collection, kind), n in counts.items():
                    c = seam.setdefault(caller, {}).setdefault(
                        collection, {"reads": 0, "writes": 0})
                    c[kind] = c.get(kind, 0) + n
        finally:
            _stats_tls.in_flush = False
    except Exception:
        pass


def _stats_enter_mutate():
    try:
        _stats_tls.mutate_depth = getattr(_stats_tls, "mutate_depth", 0) + 1
    except Exception:
        pass


def _stats_exit_mutate():
    try:
        _stats_tls.mutate_depth = max(0, getattr(_stats_tls, "mutate_depth", 1) - 1)
    except Exception:
        pass


atexit.register(_stats_flush)
# --- end op counters ---------------------------------------------------------


def read(name, default=None):
    """Read a collection. SQL-backed collections read from SQLite — what the
    app displays is what's in the database. Everything else reads its JSON
    file. Returns `default` (or {}) if the collection doesn't exist yet."""
    _stats_count(name, "reads")
    return _read(name, default)


def _read(name, default=None):
    """read() minus the telemetry hook — mutate()'s internal read path (a
    mutate counts as ONE write, not a read + two writes)."""
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


def write_text_file(path, content):
    """Write arbitrary text to `path` ATOMICALLY — for markdown/plain-text files
    (journal entries, HABITS.md, person docs) that aren't JSON collections and so
    can't go through write()/write_file().

    Same guarantee as write_file(): temp file in the same directory, fsync, then
    os.replace() over the target. A reader sees either the whole old file or the
    whole new one — never a truncated half-write — and if the process dies
    mid-write the original is left untouched. Creates parent dirs if missing.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write(name, data):
    """Write a collection. SQL-backed collections commit to SQLite first, then
    export the JSON mirror; everything else writes its JSON file atomically."""
    _stats_count(name, "writes")
    _write(name, data)


def _write(name, data):
    """write() minus the telemetry hook — mutate()'s internal write path."""
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
    _stats_count(name, "writes")
    if _sql_backed(name):
        import sqlstore
        import schemas
        with sqlstore.mutate(_key(name), default) as data:
            _stats_enter_mutate()
            try:
                yield data
            finally:
                _stats_exit_mutate()
            schemas.validate(_key(name), data)
        return
    path = _path(name)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        data = _read(name, default)
        _stats_enter_mutate()
        try:
            yield data
        finally:
            _stats_exit_mutate()
        _write(name, data)


# --- Backward-compatible aliases ---
# data_helpers.py historically exposed these names; keep them so the existing
# `from data_helpers import load_json, save_json` call sites keep working — and
# now get atomic writes for free.
def load_json(filename, default=None):
    return read(filename, default)


def save_json(filename, data):
    write(filename, data)
