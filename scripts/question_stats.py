#!/usr/bin/env python3
"""question_stats.py — how the questions sessions file for the owner are doing,
day by day. Read-only.

Every set of questions a session files (scripts/request_input.py) is a
`questions` line in that session's transcript, `data/bot_chats/<conv>.jsonl`.
This reads every transcript through store.DATA_DIR and prints one row per day:

  - sets   — question sets filed that day; `qs` — questions in them;
  - about  — the share of sets that carried an about line (--about);
  - opts   — the share of sets where at least one question offered options;
  - wait   — how long she took to answer, median and 75th percentile, over
             the sets she answered;
  - repl   — sets replaced by a newer set before she replied;
  - else   — sets the session withdrew because her answer came another way;
  - open   — sets with nothing after them yet: never answered, or still open.

A set's outcome is the next line after it that settles it: another
`questions` line (replaced), a `questions-withdrawn` line (answered
elsewhere), or a `user` line with no `message` key — her own message, as
opposed to claude echoing a tool result (answered). Its wait is that user
line's time minus the set's.

BASELINE, measured 2026-10-14 over every transcript (with jq, before sets
carried an about line or options), so later runs can be compared:
  - 395 sets and 1,041 questions since 2026-09-30, across 145 sessions
    (about 70 questions a day); median question 416 characters;
  - answer wait: median 8 minutes, 75th percentile 129 minutes, 90th
    percentile about 23 hours; 63 waited more than 8 hours;
  - 276 answered by her, 60 replaced before she replied, 4 withdrawn,
    55 never answered;
  - the same fix was asked by three sessions at once.

    ./venv/bin/python3 scripts/question_stats.py [--since 2026-10-14] [--json]

Touches: store.py (DATA_DIR), the transcripts under data/bot_chats/,
tests/test_question_stats.py. Writes nothing.

Prompt: "I think most choices should be questions. I want to learn why
things are the way they are." — this is how we see whether asking that way
made answering faster.
"""
import argparse
import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store  # noqa: E402


def _time(line):
    try:
        return datetime.fromisoformat(str(line.get("ts") or line.get("timestamp") or ""))
    except ValueError:
        return None


def _lines(path):
    """A transcript's lines, parsed; a broken line is skipped."""
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return []
    out = []
    for raw in text.splitlines():
        try:
            line = json.loads(raw)
        except ValueError:
            continue
        if isinstance(line, dict):
            out.append(line)
    return out


def question_sets(chats_dir=None):
    """Every set filed, with how it ended: one dict per `questions` line —
    conv, at, questions, about, options (bool), outcome ('answered',
    'replaced', 'elsewhere' or 'open') and wait_minutes (answered only)."""
    chats_dir = Path(chats_dir or store.DATA_DIR / "bot_chats")
    sets = []
    for path in sorted(chats_dir.glob("*.jsonl")):
        lines = _lines(path)
        for n, line in enumerate(lines):
            if line.get("type") != "questions" or not line.get("questions"):
                continue
            filed = {"conv": path.stem, "at": _time(line), "questions": len(line["questions"]),
                     "about": bool(str(line.get("about") or "").strip()),
                     "options": any(line.get("options") or []),
                     "outcome": "open", "wait_minutes": None}
            # The next line that settles it.
            for later in lines[n + 1:]:
                kind = later.get("type")
                if kind == "questions" and later.get("questions"):
                    filed["outcome"] = "replaced"
                elif kind == "questions-withdrawn":
                    filed["outcome"] = "elsewhere"
                elif kind == "user" and "message" not in later:
                    filed["outcome"] = "answered"
                    answered_at = _time(later)
                    if filed["at"] and answered_at:
                        filed["wait_minutes"] = (answered_at - filed["at"]).total_seconds() / 60
                else:
                    continue
                break
            sets.append(filed)
    return sets


def _percentile(values, share):
    """The value `share` of the way up the sorted list (nearest rank)."""
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(share * len(ordered)) - 1))]


def by_day(sets, since=None):
    """One summary dict per day the sets were filed on, oldest first."""
    days = {}
    for filed in sets:
        if not filed["at"]:
            continue
        day = filed["at"].date().isoformat()
        if since and day < since:
            continue
        days.setdefault(day, []).append(filed)
    rows = []
    for day, filed in sorted(days.items()):
        waits = [f["wait_minutes"] for f in filed if f["wait_minutes"] is not None]
        count = len(filed)
        rows.append({
            "day": day, "sets": count, "questions": sum(f["questions"] for f in filed),
            "about_share": sum(f["about"] for f in filed) / count,
            "options_share": sum(f["options"] for f in filed) / count,
            "wait_median": statistics.median(waits) if waits else None,
            "wait_p75": _percentile(waits, 0.75) if waits else None,
            "answered": sum(f["outcome"] == "answered" for f in filed),
            "replaced": sum(f["outcome"] == "replaced" for f in filed),
            "elsewhere": sum(f["outcome"] == "elsewhere" for f in filed),
            "open": sum(f["outcome"] == "open" for f in filed),
        })
    return rows


def _minutes(value):
    if value is None:
        return "—"
    return f"{value:.0f}m" if value < 120 else f"{value / 60:.1f}h"


def main(arguments=None):
    parser = argparse.ArgumentParser(description="How filed questions are doing, per day.")
    parser.add_argument("--since", help="first day to show, YYYY-MM-DD")
    parser.add_argument("--json", action="store_true", help="print the rows as JSON")
    args = parser.parse_args(arguments)
    rows = by_day(question_sets(), args.since)
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    print(f"{'day':<11}{'sets':>5}{'qs':>5}{'about':>7}{'opts':>6}{'wait½':>8}{'wait¾':>8}"
          f"{'ans':>5}{'repl':>5}{'else':>5}{'open':>5}")
    for row in rows:
        print(f"{row['day']:<11}{row['sets']:>5}{row['questions']:>5}"
              f"{row['about_share']:>7.0%}{row['options_share']:>6.0%}"
              f"{_minutes(row['wait_median']):>8}{_minutes(row['wait_p75']):>8}"
              f"{row['answered']:>5}{row['replaced']:>5}{row['elsewhere']:>5}{row['open']:>5}")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), like the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
