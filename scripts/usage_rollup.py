#!/usr/bin/env python3
"""scripts/usage_rollup.py — fold the access log into feature_usage.json.

server.py's access logger writes one line per /api/ request:

    2026-07-20 18:18:19 GET /api/habits/log → 200

This script parses access.log + access.log.1 (the RotatingFileHandler pair
beside server.py; either may be missing) and, for each PAST day it finds,
writes per-feature read/write counts under days[<date>]["api"] in the
feature_usage.json collection — the same collection whose "tabs" key the
/api/usage/tab beacon (routes/usage.py) writes live. Rules:

  - Feature = first path segment after /api/ (/api/habits/log → habits).
  - GET/HEAD are reads; POST/PUT/PATCH/DELETE are writes; only status < 400
    counts (a 401/404 isn't usage).
  - Polling/ambient endpoints are excluded from READS (their writes still
    count): the pending/version/data/sessions/usage features fire on timers
    or on every page load, and the terminal pane-poll GETs below fire every
    few seconds while the Chat tab is open — counting them would just
    measure "the app was open", not "she used the feature".
  - Old-format dateless lines (`18:18:19 GET ...`, from before the access
    formatter carried a date) are skipped silently.
  - Idempotent per day: a day that already has an "api" key is never
    overwritten — log rotation may have eaten lines since the first rollup,
    so the first write for a day is the best one. Today is never written
    (its log is still growing). The "tabs" key is never touched.

    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/usage_rollup.py

Meant for a daily cron tick; running it more often is harmless.
"""
import os
import re
import sys
from datetime import date

# Make the skeleton root importable regardless of where the script is invoked
# from (mirrors scripts/research_doctor.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402

# One access-log line, new (dated) format only. Old dateless lines start with
# a bare HH:MM:SS and simply don't match — that's the skip.
_LINE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2} ([A-Z]+) (/\S+) → (\d{3})$")

_READ_METHODS = {"GET", "HEAD"}
_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# Features whose GETs are pure polling/ambient noise (timers, page loads, the
# tracker reading itself) — excluded from reads; their writes still count.
EXCLUDED_READ_FEATURES = {"data", "pending", "sessions", "usage", "version"}

# Terminal GETs that are polling, not use (see routes/terminal.py): the Chat
# tab polls capture (pane snapshot) and needs-input (waiting-on-you flag), and
# the /sessions page polls recaps. Exact paths, not the whole feature — other
# terminal GETs (e.g. /api/terminal/schedule) are real reads, and
# POST /api/terminal/send is a real write.
EXCLUDED_READ_PATHS = {
    "/api/terminal/capture",
    "/api/terminal/needs-input",
    "/api/terminal/recaps",
}


def parse_lines(lines):
    """Pure fold: access-log lines → {date: {feature: {"reads": n, "writes": m}}}.

    Applies every counting rule (dated lines only, status < 400, read/write
    classification, polling exclusions) so callers and tests share one truth.
    """
    out = {}
    for line in lines:
        m = _LINE_RE.match(line.strip())
        if not m:
            continue  # old dateless format, blank line, or junk
        day, method, path, status = m.group(1), m.group(2), m.group(3), int(m.group(4))
        if status >= 400 or not path.startswith("/api/"):
            continue
        feature = path[len("/api/"):].split("/", 1)[0]
        if not feature:
            continue
        if method in _READ_METHODS:
            if feature in EXCLUDED_READ_FEATURES or path in EXCLUDED_READ_PATHS:
                continue
            kind = "reads"
        elif method in _WRITE_METHODS:
            kind = "writes"
        else:
            continue
        counts = out.setdefault(day, {}).setdefault(feature, {"reads": 0, "writes": 0})
        counts[kind] += 1
    return out


def write_days(counts_by_day, today):
    """Write each past day's counts under days[<date>]["api"], skipping any
    day already rolled up (never overwrite — rotation may have eaten lines
    since) and any date >= today (still accumulating). Never touches "tabs".
    Returns (written, skipped) date lists; prints one line per date."""
    eligible = sorted(d for d in counts_by_day if d < today)
    written, skipped = [], []
    if eligible:
        with store.mutate("feature_usage.json", {"days": {}}) as data:
            days = data.setdefault("days", {})
            for d in eligible:
                day = days.setdefault(d, {})
                if "api" in day:
                    skipped.append(d)
                else:
                    day["api"] = counts_by_day[d]
                    written.append(d)
    for d in written:
        n = sum(c["reads"] + c["writes"] for c in counts_by_day[d].values())
        print(f"{d}: wrote api counts for {len(counts_by_day[d])} features ({n} requests)")
    for d in skipped:
        print(f"{d}: skipped (already rolled up)")
    return written, skipped


def main():
    lines = []
    for name in ("access.log.1", "access.log"):  # oldest first, for tidy reading
        path = store.BUILD_DIR / name
        if path.exists():
            lines.extend(path.read_text(errors="replace").splitlines())
    write_days(parse_lines(lines), date.today().isoformat())


if __name__ == "__main__":
    main()
