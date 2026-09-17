"""Shared higher-level data utilities (health CSV, todos, markdown, validation).

The low-level pieces — path constants and JSON read/write — now live in store.py.
We re-export them here so the many existing `from data_helpers import DATA_DIR`
and `from data_helpers import load_json, save_json` call sites keep working
unchanged (and now get atomic writes for free)."""
from pathlib import Path
from datetime import datetime, timedelta
import json
import uuid
import pandas as pd

from store import (  # noqa: F401  (re-exported for backward compatibility)
    BUILD_DIR, DATA_DIR, CONTENT_DIR, UPLOAD_DIR, RECEIPTS_DIR, RECIPES_DIR,
    load_json, save_json, read, write, mutate,
)


# --- Markdown parsing (for HABITS.md) ---

def parse_md_sections(filepath):
    """Parse markdown sections with checkbox items."""
    sections = []
    current = None
    for line in filepath.read_text().split("\n"):
        stripped = line.strip()
        if stripped.startswith("## "):
            current = {"name": stripped[3:].strip(), "items": []}
            sections.append(current)
        elif stripped.startswith("- [x] ") and current is not None:
            current["items"].append({"text": stripped[6:], "done": True})
        elif stripped.startswith("- [ ] ") and current is not None:
            current["items"].append({"text": stripped[6:], "done": False})
    return sections


def add_item_to_file(item, section_name, filepath):
    text = filepath.read_text()
    target = f"## {section_name}"
    idx = text.find(target)
    if idx >= 0:
        insert_at = text.find("\n", idx) + 1
        lines = text[insert_at:].split("\n")
        offset = 0
        for line in lines:
            if line.strip().startswith("- [ ] ") or line.strip().startswith("- [x] "):
                offset += len(line) + 1
            else:
                break
        insert_at += offset
        text = text[:insert_at] + f"- [ ] {item}\n" + text[insert_at:]
        _store.write_text_file(filepath, text)


def remove_item_from_file(item, filepath):
    text = filepath.read_text()
    text = text.replace(f"- [ ] {item}\n", "", 1)
    text = text.replace(f"- [x] {item}\n", "", 1)
    _store.write_text_file(filepath, text)


# --- Uploads hygiene ---

import shutil as _shutil
import time as _time
import store as _store

_UPLOAD_SWEEP_INTERVAL = 3600   # throttle: sweep at most once an hour
_last_upload_sweep = 0.0


def _file_into(src, archive_dir):
    """Move one file into `archive_dir` without ever clobbering what's there.

    Same shape as routes/spinoff.archive_spinoff, deliberately: numbered suffix
    on collision, rename first (atomic, and the same filesystem in every normal
    install because both roots derive from DATA_DIR), shutil as the fallback for
    an archive env-pointed at another disk. Returns where it filed to. Raises on
    failure — the caller decides whether a failed file is fatal.
    """
    archive_dir.mkdir(parents=True, exist_ok=True)
    dest = archive_dir / src.name
    n = 2
    while dest.exists():
        dest = archive_dir / f"{src.stem}-{n}{src.suffix}"
        n += 1
    try:
        src.rename(dest)
    except OSError:
        _shutil.move(str(src), str(dest))
    return dest


def sweep_uploads(upload_dir, archive_dir, max_age_hours=24):
    """FILE terminal uploads older than `max_age_hours`. Never deletes.

    Prompt this came from: "the sweep should FILE, not DELETE: move aged uploads
    into the archive instead of unlink. uploads/ becomes a 24h inbox; the archive
    is complete by construction."

    `uploads/` is an inbox, not a wastebasket. This used to unlink, on the stated
    premise that "anything worth keeping gets moved out by whoever consumed it" —
    but there is no whoever. Nothing in the system consumes an upload, so that
    premise was false and the sweep was the only thing that ever touched them:
    it deleted 100% of what came through. Filing them instead is what makes the
    archive total — everything ever handed to the terminal is in it, because
    nothing else was ever a possible destination.

    BOTH DIRECTORIES ARE REQUIRED and neither is resolved from the store here.
    That is a safety property, not ceremony: with a default, a test that passes
    only `upload_dir` still resolves a real archive and quietly moves its fixture
    files into it — and every assertion still passes, because "the file left the
    temp folder" stays true. A green test doing that is worse than a red one, so
    the signature makes it impossible to leave the destination unsaid. The live
    roots get resolved in exactly one place, sweep_uploads_throttled below.

    Returns the number of files filed.
    """
    target = Path(upload_dir)
    if not target.is_dir():
        return 0
    archive = Path(archive_dir)
    cutoff = _time.time() - max_age_hours * 3600
    filed = 0
    for f in target.iterdir():
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                _file_into(f, archive)
                filed += 1
        except OSError:
            # Vanished mid-sweep, unreadable, or the archive is unwritable —
            # never break a request over housekeeping. Failure now leaves the
            # file sitting in the inbox, which is the safe direction: a failed
            # move loses nothing, where a failed unlink already had.
            continue
    return filed


def sweep_uploads_throttled():
    """The one production door. Hourly-throttled, cheap enough for a hot path.

    Both call sites (the dashboard's /api/data/today and the upload route) come
    through here, so the live roots are resolved in exactly one place — and
    resolved AT CALL TIME off the `_store` module, not bound at import, so a test
    that re-points store.UPLOAD_DIR is honoured.

    Note `_last_upload_sweep` lives in memory and starts at zero, so the first
    call after any restart sweeps immediately: the throttle is a ceiling on how
    OFTEN this runs, never a guarantee of how long a file has to sit.
    """
    global _last_upload_sweep
    now = _time.time()
    if now - _last_upload_sweep < _UPLOAD_SWEEP_INTERVAL:
        return 0
    _last_upload_sweep = now
    return sweep_uploads(_store.UPLOAD_DIR, _store.UPLOAD_ARCHIVE_DIR)


# --- Health data ---

def load_health_data():
    csv_path = CONTENT_DIR / "habits.csv"
    if not csv_path.exists():
        return []
    df = pd.read_csv(csv_path)
    df["date"] = pd.to_datetime(df["date"], format="mixed")
    df = df.sort_values("date")

    if not df.empty:
        full_range = pd.date_range(df["date"].min(), datetime.now().strftime("%Y-%m-%d"))
        df = df.set_index("date").reindex(full_range).rename_axis("date").reset_index()

    quality_map = {"poor": 1, "light": 2, "foggy": 2, "better than usual": 3, "deeper than usual": 4}

    rows = []
    for _, row in df.iterrows():
        d = {"date": row["date"].strftime("%Y-%m-%d")}
        d["date_short"] = row["date"].strftime("%b %d")
        d["day_name"] = row["date"].strftime("%a")

        # Sleep
        sq = str(row.get("sleep_quality", "")).lower().strip() if pd.notna(row.get("sleep_quality")) else None
        d["sleep_quality"] = row.get("sleep_quality") if pd.notna(row.get("sleep_quality")) else None
        d["sleep_score"] = None
        if sq:
            for key, score in quality_map.items():
                if key in sq:
                    d["sleep_score"] = score
                    break

        # Wakeups
        d["wakeups"] = row.get("wakeups") if pd.notna(row.get("wakeups")) else None
        d["wakeup_notes"] = row.get("wakeup_notes") if pd.notna(row.get("wakeup_notes")) else None

        # Exercise
        ex = str(row.get("exercise", "")).strip().lower() if pd.notna(row.get("exercise")) else ""
        d["exercised"] = ex == "yes"
        d["exercise_type"] = row.get("exercise_type") if pd.notna(row.get("exercise_type")) else None
        d["exercise_minutes"] = int(row["exercise_minutes"]) if pd.notna(row.get("exercise_minutes")) and row.get("exercise_minutes", 0) > 0 else None

        # Flare
        fl = str(row.get("histamine_flare", "")).strip().lower() if pd.notna(row.get("histamine_flare")) else ""
        d["flare"] = fl == "yes"
        d["flare_trigger"] = row.get("flare_trigger") if pd.notna(row.get("flare_trigger")) else None

        # Food
        d["food_notes"] = row.get("food_notes") if pd.notna(row.get("food_notes")) else None
        d["food_spend"] = row.get("food_spend") if pd.notna(row.get("food_spend")) else None

        # Symptoms
        for col in ["nose_congestion", "brain_fog", "abdominal_pain", "hand_pain", "headache", "energy"]:
            val = row.get(col)
            d[col] = int(val) if pd.notna(val) else None

        # Nose spray
        ns = row.get("nose_spray") if "nose_spray" in row.index else None
        d["nose_spray"] = bool(int(ns)) if pd.notna(ns) else None

        rows.append(d)
    return rows


# --- Meetings ---

def load_meetings():
    """Load all meetings from tulku/meetings/, sorted by date (newest first)."""
    meetings_dir = CONTENT_DIR / "meetings"
    if not meetings_dir.exists():
        return []
    meetings = []
    for f in sorted(meetings_dir.glob("*.md"), reverse=True):
        text = f.read_text()
        lines = text.strip().split("\n")
        title = lines[0].lstrip("# ").strip() if lines else f.stem
        subtitle = ""
        if len(lines) > 1:
            sub = lines[1].strip().strip("*")
            if sub:
                subtitle = sub
        stem = f.stem
        has_audio = any((meetings_dir / f"{stem}{ext}").exists() for ext in [".m4a", ".mp3", ".wav"])
        has_transcript = (meetings_dir / f"{stem}-transcript.txt").exists()
        meetings.append({
            "filename": f.name,
            "title": title,
            "subtitle": subtitle,
            "has_audio": has_audio,
            "has_transcript": has_transcript,
        })
    return meetings


# --- Habits log ---

def habit_log_key(section, text):
    """Done-state key for a habit: 'section|text' (section lowercased). Keyed
    per-section so the same habit text can live in Morning AND Evening without
    sharing a checkbox — the reason for the old 'chew food m/n/e' suffix hacks."""
    return f"{(section or '').strip().lower()}|{text}"


def load_habits_log():
    """Read habits_log.json, migrating any legacy bare-text keys to the
    section-qualified form ('morning|Water upon waking') using each habit's
    current section in HABITS.md. Texts that no longer exist anywhere keep
    their bare key — dead history, harmless. Persists once, like the todos
    id back-fill."""
    log = read("habits_log.json", {})
    days = [d for d in log.values() if isinstance(d, dict)]
    if not any("|" not in k for day in days for k in day):
        return log
    habits_path = _store.CONTENT_DIR / "HABITS.md"
    text_to_sec = {}
    if habits_path.exists():
        for sec in parse_md_sections(habits_path):
            for item in sec["items"]:
                text_to_sec.setdefault(item["text"], sec["name"])
    changed = False
    for day in days:
        for k in list(day.keys()):
            if "|" in k:
                continue
            sec = text_to_sec.get(k)
            if sec:
                day[habit_log_key(sec, k)] = day.pop(k)
                changed = True
    if changed:
        write("habits_log.json", log)
    return log


# --- Todos ---

TODOS_PATH = DATA_DIR / "todos.json"

TODO_SECTIONS = [
    ("now", "Now"),
    ("up_next", "Up Next"),
    ("later", "Later"),
    ("someday", "Someday"),
    ("done", "Done"),
]


def _ensure_todo_ids(data):
    """Assign a stable short id to any to-do item that lacks one. Returns True if
    anything changed, so the caller can persist the one-time migration."""
    changed = False
    for sec in data.values():
        if not isinstance(sec, dict):
            continue
        for item in sec.get("items", []):
            if isinstance(item, dict) and not item.get("id"):
                item["id"] = uuid.uuid4().hex[:8]
                changed = True
    return changed


def _sweep_done_todos(data):
    """Archive completed items the morning after they were checked off.

    A to-do checked off today carries `done_at == today`; it lingers struck-through
    in its bucket for the rest of the day (the satisfaction + "it persisted" feel).
    Once `done_at` is before today (or it's a legacy done item with no date), this
    sweeps it into the Done bucket so the active ladder doesn't silently pile up.
    Returns True if anything moved, so the caller can persist the change."""
    today = datetime.now().strftime("%Y-%m-%d")
    done_sec = data.setdefault("done", {"items": []})
    done_sec.setdefault("items", [])
    moved = False
    for key, sec in data.items():
        if key == "done" or not isinstance(sec, dict):
            continue
        kept = []
        for item in sec.get("items", []):
            if isinstance(item, dict) and item.get("done"):
                done_at = item.get("done_at")
                if done_at is None or done_at < today:
                    done_sec["items"].append(item)
                    moved = True
                    continue
            kept.append(item)
        if "items" in sec:
            sec["items"] = kept
    return moved


def load_todos():
    """Read todos through the atomic store layer, back-filling stable ids on the
    way out so every item is addressable by id (text is no longer the identity),
    and sweeping yesterday's completed items into Done."""
    data = read("todos", {})
    changed = _ensure_todo_ids(data)
    changed = _sweep_done_todos(data) or changed
    if changed:
        write("todos", data)
    return data


def save_todos(data):
    write("todos", data)


def roll_todos(data):
    """No-op: the priority-ladder model (Now/Up Next/Later/Someday) is fully
    manual — items only move when the user moves them, so there's no daily roll."""
    return data


def todos_to_sections(data):
    """Convert todos.json structure to the section list the frontend expects.

    Buckets auto-sort: not-done before done, dated before undated, due date
    ascending (overdue/soonest first), then created date *descending* (newest
    first, so a just-added item lands at the top of its group). A bucket that's
    been manually dragged carries `manual_order` and keeps its stored order
    verbatim (toggle already sinks done items to the bottom there)."""
    sections = []
    for key, label in TODO_SECTIONS:
        sec = data.get(key, {})
        items = sec.get("items", [])
        manual = bool(sec.get("manual_order", False))
        if manual:
            ordered = list(items)
        else:
            # Two-pass stable sort: newest-first within each group, then the
            # primary keys on top (stability preserves the created order).
            ordered = sorted(items, key=lambda x: x.get("created") or "", reverse=True)
            ordered = sorted(ordered, key=lambda x: (
                x.get("done", False),
                0 if x.get("due_by") else 1,
                x.get("due_by") or "",
            ))
        sections.append({"name": label, "items": ordered, "manual_order": manual})
    return sections


def todos_for_tab(tab, data=None):
    """Not-done to-dos category-tagged for a tab — surfaced in a strip at the
    top of that tab. Category values mirror the tab keys (set in the to-do
    detail modal). Done items drop out; ladder order is preserved."""
    if data is None:
        data = read("todos", {})
    out = []
    for key, sec in data.items():
        if key == "done" or not isinstance(sec, dict):
            continue
        for item in sec.get("items", []):
            if not isinstance(item, dict) or item.get("done"):
                continue
            if item.get("category") == tab:
                out.append({
                    "id": item.get("id"),
                    "text": item.get("text", ""),
                    "due_by": item.get("due_by", ""),
                })
    return out


def find_section_key(name):
    """Map a frontend section name back to a todos.json key."""
    name_lower = name.lower().split("—")[0].strip()
    for key, label in TODO_SECTIONS:
        if label.lower() == name_lower:
            return key
    return None


# --- Startup validation ---

def validate_on_startup(app):
    """Check that data files exist and are well-formed. Logs warnings -- doesn't crash."""
    problems = []

    if not DATA_DIR.exists():
        problems.append(f"Directory missing: {DATA_DIR}")

    json_files = list(DATA_DIR.glob("*.json"))
    for jf in json_files:
        try:
            data = json.loads(jf.read_text())
        except (json.JSONDecodeError, Exception) as e:
            problems.append(f"Bad JSON in {jf.name}: {e}")
            continue

        if jf.name == "todos.json" and isinstance(data, dict):
            for section_key, section in data.items():
                if not isinstance(section, dict):
                    continue
                for i, item in enumerate(section.get("items", [])):
                    if isinstance(item, dict) and "done" not in item:
                        problems.append(
                            f'todos.json [{section_key}] item {i} missing "done": '
                            f'{item.get("text", "???")[:50]}'
                        )
                        item["done"] = False

            if any("todos.json" in p and 'missing "done"' in p for p in problems):
                jf.write_text(json.dumps(data, indent=2, ensure_ascii=False))
                problems.append("todos.json: auto-fixed missing done fields")

    csv_path = CONTENT_DIR / "habits.csv"
    if csv_path.exists():
        try:
            pd.read_csv(csv_path, nrows=1)
        except Exception as e:
            problems.append(f"habits.csv unreadable: {e}")

    if problems:
        for p in problems:
            app.logger.warning(f"STARTUP: {p}")
        print(f"\n\u26a0  Startup validation found {len(problems)} issue(s):")
        for p in problems:
            print(f"   \u2022 {p}")
        print()
    else:
        print("\u2713 Startup validation passed \u2014 all data files OK")

    return problems
