"""Every tap and every page open, as events — the click counter with a clock.

**The problem this solves.** `feature_usage` counts clicks per control per
page per DAY, written by the same frontend flush that carries dwell. A
count can say "card-edit was tapped 12 times on Tuesday" and nothing more:
not when, not in which conversation, not what she was looking at just
before. This module keeps the taps themselves, one row each, and the page
opens beside them, so the day's counts become a sum over rows instead of
the only thing known.

**Two layers, and which one is the truth** — the shape attentionstore.py
set, copied on purpose so there is one pattern to learn:

    $EXOCORTEX_DATA_DIR/ui_events/2026-09-24.jsonl
    {"kind": "click", "tab": "todos", "conv": null, "control": "card-edit",
     "at": "2026-09-24T12:56:29.403"}

That file is the record, and it is in the vault, so the hourly git commit
backs it up with no extra machinery. The `ui_events` table in exo.db is a
one-way DERIVED mirror: wipe it and `rebuild()` walks it back.

**The clock.** Events arrive from the browser as epoch milliseconds and are
converted ONCE, here, to local naive ISO with milliseconds — the clock the
other event tables keep (see sqlstore.py rung 19). Bounds are the same as
attention's: refused if more than a week old or more than a few minutes in
the future, because her device clock is trusted, just not unboundedly.

Touches: `sqlstore.py` (the schema), `store.py` (DATA_DIR), `routes/usage.py`
(the endpoint the browser posts to), `routes/sqlab.py` (the rebuild button),
and `frontend/src/api/usageTracker.ts` (which emits the events).

Prompt that produced this file: "I'm trying to figure out how to record my
usage as granularly as possible ... I wanna turn it all into sql."
"""
import json
import re
from datetime import datetime, timedelta

import sqlstore
import store

_MAX_AGE = timedelta(days=7)
_MAX_SKEW_AHEAD = timedelta(minutes=5)
_KINDS = ("click", "open")
_TAB_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
_CONTROL_RE = re.compile(r"^[a-z0-9:._-]{1,60}$")
_CONV_RE = re.compile(r"^[0-9A-Za-z._-]{1,64}$")


def _dir():
    """Resolved at call time so tests get an isolated data dir."""
    return store.DATA_DIR / "ui_events"


def _local(ms):
    """Epoch milliseconds -> local naive ISO with milliseconds."""
    return datetime.fromtimestamp(ms / 1000).isoformat(timespec="milliseconds")


def clean(events, now=None):
    """Turn raw client events into records, dropping any that can't be true.

    Returns (records, rejected_count). Never raises on bad input: one
    malformed event must not cost the good ones in the same flush.
    """
    now = now or datetime.now()
    out, rejected = [], 0
    for ev in events if isinstance(events, list) else []:
        if not isinstance(ev, dict):
            rejected += 1
            continue
        kind, tab, conv, control, at_ms = (ev.get("kind"), ev.get("tab"),
                                           ev.get("conv"), ev.get("control"),
                                           ev.get("at"))
        ok = (kind in _KINDS
              and isinstance(tab, str) and _TAB_RE.match(tab)
              and (conv is None or (isinstance(conv, str) and _CONV_RE.match(conv)))
              and isinstance(at_ms, (int, float)) and not isinstance(at_ms, bool))
        # A click names its control; an open doesn't have one.
        if ok and kind == "click":
            ok = isinstance(control, str) and bool(_CONTROL_RE.match(control))
        if ok and kind == "open":
            control = None
        if not ok:
            rejected += 1
            continue
        try:
            at = datetime.fromtimestamp(at_ms / 1000)
        except (ValueError, OSError, OverflowError):
            rejected += 1
            continue
        if at < now - _MAX_AGE or at > now + _MAX_SKEW_AHEAD:
            rejected += 1
            continue
        out.append({"kind": kind, "tab": tab, "conv": conv or None,
                    "control": control,
                    "at": at.isoformat(timespec="milliseconds")})
    return out, rejected


def append(records):
    """Write records to their day's JSONL. Returns how many landed."""
    if not records:
        return 0
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    by_day = {}
    for rec in records:
        by_day.setdefault(rec["at"][:10], []).append(rec)
    written = 0
    for day, recs in by_day.items():
        with (d / f"{day}.jsonl").open("a") as fh:
            for rec in recs:
                fh.write(json.dumps(rec, sort_keys=True) + "\n")
                written += 1
    return written


def _read_day(path):
    """Every well-formed record in one day file; a truncated last line is
    skipped, not fatal."""
    out = []
    try:
        text = path.read_text()
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (isinstance(rec, dict) and rec.get("kind") in _KINDS
                and rec.get("tab") and rec.get("at")):
            out.append(rec)
    return out


def _insert(conn, records):
    conn.executemany(
        "INSERT INTO ui_events (kind, tab, conv, control, at, day)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        [(r["kind"], r["tab"], r.get("conv"), r.get("control"), r["at"],
          r["at"][:10]) for r in records])


def sync_day(day):
    """Re-derive one day: drop its rows, re-read its file. Idempotent, so a
    retried flush can't double-count."""
    records = _read_day(_dir() / f"{day}.jsonl")
    with sqlstore._connect() as conn:
        conn.execute("DELETE FROM ui_events WHERE day = ?", (day,))
        _insert(conn, records)
    return len(records)


def rebuild():
    """Wipe the table and re-walk every day file. The undo button."""
    d = _dir()
    with sqlstore._connect() as conn:
        conn.execute("DELETE FROM ui_events")
    total = 0
    try:
        files = sorted(d.glob("*.jsonl"))
    except OSError:
        files = []
    for path in files:
        total += sync_day(path.stem)
    return {"events": total, "days": len(files)}


def record(events, now=None):
    """The endpoint's one call: clean, append, mirror the touched days.
    Returns {"stored", "rejected"}."""
    records, rejected = clean(events, now)
    stored = append(records)
    for day in sorted({r["at"][:10] for r in records}):
        sync_day(day)
    return {"stored": stored, "rejected": rejected}
