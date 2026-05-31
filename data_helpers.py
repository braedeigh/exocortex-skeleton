"""Shared higher-level data utilities (health CSV, todos, markdown, validation).

The low-level pieces — path constants and JSON read/write — now live in store.py.
We re-export them here so the many existing `from data_helpers import DATA_DIR`
and `from data_helpers import load_json, save_json` call sites keep working
unchanged (and now get atomic writes for free)."""
from pathlib import Path
from datetime import datetime, timedelta
import json
import pandas as pd

from store import (  # noqa: F401  (re-exported for backward compatibility)
    BUILD_DIR, DATA_DIR, CONTENT_DIR, UPLOAD_DIR,
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
        filepath.write_text(text)


def remove_item_from_file(item, filepath):
    text = filepath.read_text()
    text = text.replace(f"- [ ] {item}\n", "", 1)
    text = text.replace(f"- [x] {item}\n", "", 1)
    filepath.write_text(text)


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


# --- Todos ---

TODOS_PATH = DATA_DIR / "todos.json"

TODO_SECTIONS = [
    ("today", "Today"),
    ("tomorrow", "Tomorrow"),
    ("this_week", "This Week"),
    ("soon", "Soon"),
    ("longer_term", "Longer Term"),
    ("done", "Done"),
]


def load_todos():
    if TODOS_PATH.exists():
        return json.loads(TODOS_PATH.read_text())
    return {}


def save_todos(data):
    TODOS_PATH.write_text(json.dumps(data, indent=2))


def roll_todos(data):
    """Roll the todo list forward if the date has changed."""
    today = datetime.now()
    today_str = today.strftime("%Y-%m-%d")
    tomorrow = today + timedelta(days=1)
    tomorrow_str = tomorrow.strftime("%Y-%m-%d")

    today_sec = data.get("today", {})
    if today_sec.get("date") == today_str:
        return data

    old_items = today_sec.get("items", [])
    carry = [i for i in old_items if not i.get("done", False)]
    newly_done = [i for i in old_items if i.get("done", False)]
    old_date = today_sec.get("date", today_str)

    done_sec = data.get("done", {"items": []})
    for item in newly_done:
        item["completed"] = old_date
    done_sec["items"] = newly_done + done_sec.get("items", [])

    tomorrow_sec = data.get("tomorrow", {"items": []})
    data["today"] = {
        "date": today_str,
        "label": today.strftime("%A %B %-d"),
        "items": carry + tomorrow_sec.get("items", []),
    }
    data["tomorrow"] = {
        "date": tomorrow_str,
        "label": tomorrow.strftime("%A %B %-d"),
        "items": [],
    }
    data["done"] = done_sec
    save_todos(data)
    return data


def todos_to_sections(data):
    """Convert todos.json structure to the section list the frontend expects."""
    sections = []
    for key, label in TODO_SECTIONS:
        sec = data.get(key, {})
        items = sec.get("items", [])
        items = sorted(items, key=lambda x: x.get("done", False))
        name = label
        if key in ("today", "tomorrow") and sec.get("label"):
            name = f"{label} — {sec['label']}"
        sections.append({"name": name, "items": items})
    return sections


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
