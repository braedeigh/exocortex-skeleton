"""When she was looking at what — attention as a timeline, not a daily total.

**The problem this solves.** `feature_usage` already counts dwell honestly:
the frontend runs a clock that only ticks while the page is visible AND
non-idle, and flushes seconds per tab. But it flushes TOTALS — "90 minutes of
observatory on Sunday" — and a total has no clock. It cannot be laid beside
a file write, a commit, or a journal card, so the one question the numbers
are shaped to answer, *what was I doing when this happened*, stays out of
reach. This module gives those seconds a beginning and an end.

A **segment** is one contiguous run of active attention on one (tab,
conversation). It opens when the dwell clock starts and closes when that
clock stops or the destination changes — so a segment is never interrupted
by an idle pause, a hidden tab, or a navigation. That is the whole reason
there is no `seconds` column: within a segment the clock ran the entire time,
so active seconds and `ended - started` are the same number, and storing both
would only give them a chance to disagree.

**Two layers, and which one is the truth.** The record is an append-only
JSONL per day:

    $EXOCORTEX_DATA_DIR/attention/2026-08-10.jsonl
    {"tab": "observatory", "conv": "2026-08-09.030450",
     "started": "2026-08-10T19:02:11", "ended": "2026-08-10T19:38:44"}

That file is the source of truth, and it is in the vault, so the hourly git
commit backs it up with no extra machinery. The `attention_segments` table in
exo.db (the v11 rung in sqlstore.py) is a one-way DERIVED mirror of it —
wipe the table and `rebuild()` walks it back. This is deliberately the shape
`cards` and `commits` have and the shape `job_runs` could not: nothing here
lives only in SQLite.

**The clock.** Segments arrive from the browser as epoch milliseconds and are
converted ONCE, here, to local naive ISO — the clock `cards.ts`,
`session_turns.ts` and `job_runs.started` keep. `session_files.last` is the
odd one out at UTC; drawing this lane against that one without converting
puts an evening five hours into the next morning, which is wrong in a way
that looks entirely plausible.

**Bounds, because the timestamps come from a client.** A segment is refused
if it ends before it starts, runs longer than a day, starts more than a week
ago, or ends more than a few minutes in the future. That is skew tolerance,
not validation theatre: her device clock is the only clock that knows when
she was actually looking, so it is trusted, just not unboundedly.

Touches: `sqlstore.py` (owns the schema + connection factory), `store.py`
(DATA_DIR for the JSONL record), `routes/usage.py` (the endpoint the browser
posts segments to), `routes/sqlab.py` (the rebuild button + table list), and
`frontend/src/api/usageTracker.ts` (which decides where a segment ends).

Prompt that produced this file: "this is going to essentially become a way
for me to visualize when I have what tabs open along with the files being
written."
"""
from datetime import datetime, timedelta
from pathlib import Path
import json

import sqlstore
import store

# How far a client's clock may disagree with this box before its segments are
# refused. Generous in the past (a phone that was offline flushes late on
# reconnect), tight in the future (nothing legitimately reports forward).
_MAX_AGE = timedelta(days=7)
_MAX_SKEW_AHEAD = timedelta(minutes=5)
_MAX_SPAN = timedelta(days=1)


def _dir():
    """Resolved at call time so tests get an isolated data dir, same rule as
    sqlstore._db_path()."""
    return store.DATA_DIR / "attention"


def _local(ms):
    """Epoch milliseconds -> local naive ISO, seconds resolution.

    `fromtimestamp` (not `utcfromtimestamp`) is the whole point: it lands in
    THIS box's local zone, which is the clock every other table here keeps.
    """
    return datetime.fromtimestamp(ms / 1000).replace(microsecond=0)


def clean(segments, now=None):
    """Turn raw client segments into records, dropping any that can't be true.

    Returns (records, rejected_count). Never raises on bad input: a telemetry
    payload is a stranger's data, and one malformed segment must not cost the
    good ones in the same flush.
    """
    now = now or datetime.now()
    out, rejected = [], 0
    for seg in segments if isinstance(segments, list) else []:
        if not isinstance(seg, dict):
            rejected += 1
            continue
        tab, conv = seg.get("tab"), seg.get("conv")
        start_ms, end_ms = seg.get("started"), seg.get("ended")
        if not isinstance(tab, str) or not tab:
            rejected += 1
            continue
        if conv is not None and not isinstance(conv, str):
            rejected += 1
            continue
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                   for v in (start_ms, end_ms)):
            rejected += 1
            continue
        try:
            started, ended = _local(start_ms), _local(end_ms)
        except (ValueError, OSError, OverflowError):
            rejected += 1
            continue
        # A zero-length segment is not a lie, just nothing — sub-second dwell
        # that rounded away. Dropped quietly rather than counted as junk.
        if ended <= started:
            continue
        if (ended - started > _MAX_SPAN
                or started < now - _MAX_AGE
                or ended > now + _MAX_SKEW_AHEAD):
            rejected += 1
            continue
        out.append({"tab": tab, "conv": conv or None,
                    "started": started.isoformat(),
                    "ended": ended.isoformat()})
    return out, rejected


def append(records):
    """Write records to their day's JSONL. Returns how many landed.

    A segment files under the day its START falls in, so one that crosses
    midnight stays whole and stays on the day she began it — the alternative
    (splitting at midnight) invents a boundary her attention didn't have.
    """
    if not records:
        return 0
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    by_day = {}
    for rec in records:
        by_day.setdefault(rec["started"][:10], []).append(rec)
    written = 0
    for day, recs in by_day.items():
        with (d / f"{day}.jsonl").open("a") as fh:
            for rec in recs:
                fh.write(json.dumps(rec, sort_keys=True) + "\n")
                written += 1
    return written


def _read_day(path):
    """Every well-formed record in one day file. A truncated final line — the
    shape a crash mid-append leaves — is skipped, not fatal."""
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
        if isinstance(rec, dict) and rec.get("tab") and rec.get("started") \
                and rec.get("ended"):
            out.append(rec)
    return out


def _insert(conn, records):
    conn.executemany(
        "INSERT INTO attention_segments (tab, conv, started, ended, day)"
        " VALUES (?, ?, ?, ?, ?)",
        [(r["tab"], r.get("conv"), r["started"], r["ended"], r["started"][:10])
         for r in records],
    )


def sync_day(day):
    """Re-derive one day: drop its rows, re-read its file. Idempotent.

    Called right after an append so the table is never staler than the record
    it mirrors. Re-reading the whole day rather than inserting just what
    arrived is what makes it idempotent — a retried flush can't double-count.
    """
    records = _read_day(_dir() / f"{day}.jsonl")
    with sqlstore._connect() as conn:
        conn.execute("DELETE FROM attention_segments WHERE day = ?", (day,))
        _insert(conn, records)
    return len(records)


def rebuild():
    """Wipe the table and re-walk every day file. The undo button."""
    d = _dir()
    files = sorted(d.glob("*.jsonl")) if d.exists() else []
    total = 0
    with sqlstore._connect() as conn:
        conn.execute("DELETE FROM attention_segments")
        for path in files:
            records = _read_day(path)
            _insert(conn, records)
            total += len(records)
    return {"days": len(files), "segments": total}


def record(segments, now=None):
    """The whole write path: clean, append to the record, mirror to the table.

    Returns {"written", "rejected"}. Mirroring failures are swallowed — the
    JSONL is the truth and a lost mirror is one `rebuild()` away, so a sick
    database must never cost a real segment.
    """
    records, rejected = clean(segments, now=now)
    written = append(records)
    if written:
        try:
            for day in {r["started"][:10] for r in records}:
                sync_day(day)
        except Exception:
            pass
    return {"written": written, "rejected": rejected}
