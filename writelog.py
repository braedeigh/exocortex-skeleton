"""The write journal: a standalone log of every store.write()/mutate() call.

This file answers "what got written, by whom, when" for the whole app. It logs
every write the store layer makes — timestamp, which process made it, which
collection, whether it was a plain write() or a read-modify-write mutate(),
and a structural diff of what changed — into its own small SQLite db
(``write_log.db``, lazily created beside the app's other data). It never
touches the real data files; store.py calls ``record()`` around its own
write/mutate paths, and this module answers back with ``recent()`` /
``capturing_since()`` for anyone who wants to read the log.

Built to this brief: "Every store.write() and store.mutate() should journal a
write EVENT — timestamp, caller process, collection, verb, and a structural
diff of what changed — into a small standalone SQLite db, so the owner can
see exactly what was written, by whom, when. This sits at the hottest seam in
the system, so: fail-open, always — no exception can ever break or slow a
real write beyond negligibly. Kill switch: env EXOCORTEX_WRITE_LOG_OFF=1
disables capture entirely. Bounded: patches capped at 100 ops / ~8KB
serialized (truncated flag). Retention: events older than 30 days pruned
opportunistically — never a background thread."

Touches: store.py (the only caller of ``record()``) and this module's own
``write_log.db`` under ``store.DATA_DIR`` — nothing else reads or writes that
db. ``diff_values()`` is a pure function, exercised directly by
tests/test_writelog.py.
"""
from collections import Counter
from datetime import datetime, timedelta
import json
import os
import random
import sqlite3

import store

DB_NAME = "write_log.db"
_BUSY_MS = 2000
_MAX_OPS = 100
_MAX_STR = 200               # cap on an embedded scalar's repr, in characters
_MAX_PATCH_BYTES = 8192      # cap on the serialized patch, in bytes
_RETENTION_DAYS = 30
_PRUNE_CHANCE = 1 / 200      # opportunistic prune odds on a given append


# --- kill switch ---------------------------------------------------------

def _off():
    """Checked fresh on every call (like store._stats_off()) so tests can
    flip it per-test with monkeypatch.setenv, no caching to invalidate."""
    return os.environ.get("EXOCORTEX_WRITE_LOG_OFF", "") == "1"


# --- db plumbing -----------------------------------------------------------

def _db_path():
    """Resolved lazily per call (not at import time) so tests that
    monkeypatch store.DATA_DIR get an isolated db, same as the JSON files."""
    return store.DATA_DIR / DB_NAME


def _connect():
    """One short-lived connection per operation — same shape as sqlstore's
    _connect(): WAL + busy_timeout so concurrent workers share the file
    safely, schema created lazily (CREATE TABLE IF NOT EXISTS, cheap and
    idempotent) so there's no separate install step."""
    conn = sqlite3.connect(_db_path(), timeout=_BUSY_MS / 1000, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(f"PRAGMA busy_timeout={_BUSY_MS}")
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn):
    conn.execute(
        "CREATE TABLE IF NOT EXISTS write_events ("
        "  id INTEGER PRIMARY KEY,"
        "  ts TEXT NOT NULL,"
        "  caller TEXT NOT NULL,"
        "  collection TEXT NOT NULL,"
        "  verb TEXT NOT NULL,"
        "  patch TEXT,"
        "  truncated INTEGER NOT NULL DEFAULT 0,"
        "  bytes_before INTEGER,"
        "  bytes_after INTEGER"
        ")"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_write_events_coll_ts"
        " ON write_events (collection, ts)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_write_events_ts ON write_events (ts)"
    )


# --- the diff ----------------------------------------------------------------
# A pure, unit-testable function: (before, after) -> (ops, truncated). JSON-
# Patch-flavored ops, from/to only on scalar-ish values (so a giant nested
# value never gets dumped whole into the log), capped at 100 ops total.

def _is_scalar(v):
    return v is None or isinstance(v, (str, int, float, bool))


def _cap_scalar(v):
    """Cap an embedded scalar at ~200 chars — long strings get truncated,
    everything else (numbers, bools, None, short strings) rides as-is."""
    if isinstance(v, str) and len(v) > _MAX_STR:
        return v[:_MAX_STR] + "…"
    return v


def _join(path, key):
    return str(key) if path == "" else f"{path}/{key}"


def _typename(v):
    if v is None:
        return "null"
    return type(v).__name__


class _Collector:
    """Accumulates ops, stopping just past the cap so the caller can tell
    real truncation (more ops existed) apart from landing exactly at 100."""

    __slots__ = ("ops",)

    def __init__(self):
        self.ops = []

    def add(self, op):
        if len(self.ops) <= _MAX_OPS:
            self.ops.append(op)

    @property
    def full(self):
        return len(self.ops) > _MAX_OPS


def diff_values(before, after):
    """Structural diff of two JSON-ish python values.

    Returns (ops, truncated). `before is None` (a collection that didn't
    exist yet) is special-cased to one op — the whole new value is never
    dumped — and same for `after is None` (the collection going away).
    """
    if before is None and after is None:
        return [], False
    if before is None:
        return [{"op": "add", "path": "", "note": "created"}], False
    if after is None:
        return [{"op": "remove", "path": "", "note": "deleted"}], False
    c = _Collector()
    _diff(c, "", before, after)
    return c.ops[:_MAX_OPS], c.full


def _diff(c, path, before, after):
    if c.full:
        return
    if before == after:
        return
    if isinstance(before, dict) and isinstance(after, dict):
        _diff_dict(c, path, before, after)
    elif isinstance(before, list) and isinstance(after, list):
        _diff_list(c, path, before, after)
    else:
        op = {"op": "replace", "path": path}
        if _is_scalar(before) and _is_scalar(after):
            op["from"] = _cap_scalar(before)
            op["to"] = _cap_scalar(after)
        else:
            op["note"] = f"type changed: {_typename(before)} -> {_typename(after)}"
        c.add(op)


def _diff_dict(c, path, before, after):
    for key in before:
        if c.full:
            return
        p = _join(path, key)
        if key not in after:
            op = {"op": "remove", "path": p}
            if _is_scalar(before[key]):
                op["from"] = _cap_scalar(before[key])
            c.add(op)
        else:
            _diff(c, p, before[key], after[key])
    for key in after:
        if c.full:
            return
        if key not in before:
            p = _join(path, key)
            op = {"op": "add", "path": p}
            if _is_scalar(after[key]):
                op["to"] = _cap_scalar(after[key])
            c.add(op)


def _all_id_dicts(lst):
    return len(lst) > 0 and all(isinstance(x, dict) and "id" in x for x in lst)


def _diff_list(c, path, before, after):
    if before == after:
        return
    if _all_id_dicts(before) and _all_id_dicts(after):
        _diff_id_list(c, path, before, after)
        return
    if (
        all(_is_scalar(x) for x in before)
        and all(_is_scalar(x) for x in after)
        and len(before) <= 30
        and len(after) <= 30
    ):
        _diff_scalar_list(c, path, before, after)
        return
    c.add({
        "op": "replace", "path": path,
        "note": f"list changed, len {len(before)} -> {len(after)}",
    })


def _diff_id_list(c, path, before, after):
    """Both sides are lists of dicts carrying 'id' — match by id rather than
    position, so reordering doesn't look like every item changed."""
    before_by_id = {item.get("id"): (i, item) for i, item in enumerate(before)}
    after_by_id = {item.get("id"): (i, item) for i, item in enumerate(after)}
    for iid, (idx, _item) in after_by_id.items():
        if c.full:
            return
        if iid not in before_by_id:
            c.add({"op": "add", "path": _join(path, idx),
                   "note": f"id={_cap_scalar(iid)} added"})
    for iid, (idx, _item) in before_by_id.items():
        if c.full:
            return
        if iid not in after_by_id:
            c.add({"op": "remove", "path": _join(path, idx),
                   "note": f"id={_cap_scalar(iid)} removed"})
    for iid, (idx, item) in after_by_id.items():
        if c.full:
            return
        if iid in before_by_id:
            _, b_item = before_by_id[iid]
            _diff(c, _join(path, idx), b_item, item)


def _diff_scalar_list(c, path, before, after):
    """Short, all-scalar lists on both sides: report the set-ish difference
    (by count, so a duplicate value that appears twice needs two ops)
    rather than a position-by-position replace."""
    removed = Counter(before) - Counter(after)
    added = Counter(after) - Counter(before)
    for val, n in removed.items():
        for _ in range(n):
            if c.full:
                return
            c.add({"op": "remove", "path": path, "from": _cap_scalar(val)})
    for val, n in added.items():
        for _ in range(n):
            if c.full:
                return
            c.add({"op": "add", "path": path, "to": _cap_scalar(val)})


# --- recording -----------------------------------------------------------

_MISSING = object()


def record(collection, verb, before, after):
    """Journal one write event. The single fail-open guard: the kill switch
    is checked first (cheap), then everything else — the diff, the byte
    cap, the insert, the opportunistic prune — is wrapped so nothing here
    can ever raise back into the caller. Mirrors store.py's `_stats_count`.
    """
    if _off():
        return
    try:
        _record(collection, verb, before, after)
    except Exception:
        pass


def _record(collection, verb, before, after):
    ops, truncated = diff_values(before, after)
    patch_json = json.dumps(ops, ensure_ascii=False)
    if len(patch_json.encode("utf-8")) > _MAX_PATCH_BYTES:
        # Drop ops from the end until the serialized patch fits the byte cap
        # (separate from, and on top of, the 100-op cap above).
        while ops and len(json.dumps(ops, ensure_ascii=False).encode("utf-8")) > _MAX_PATCH_BYTES:
            ops.pop()
        truncated = True
        patch_json = json.dumps(ops, ensure_ascii=False)

    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO write_events"
            " (ts, caller, collection, verb, patch, truncated, bytes_before, bytes_after)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                datetime.now().isoformat(timespec="seconds"),
                store._stats_caller(),
                collection,
                verb,
                patch_json,
                1 if truncated else 0,
                _safe_len(before),
                _safe_len(after),
            ),
        )
        if random.random() < _PRUNE_CHANCE:
            _prune(conn)
    finally:
        conn.close()


def _safe_len(value):
    try:
        return len(json.dumps(value, ensure_ascii=False))
    except Exception:
        return None


def _prune(conn):
    """Delete events older than the retention window. Called opportunistically
    (~1-in-200 appends — see _PRUNE_CHANCE) rather than on a timer thread, so
    retention costs nothing on the (overwhelming) majority of writes."""
    cutoff = (datetime.now() - timedelta(days=_RETENTION_DAYS)).isoformat(timespec="seconds")
    conn.execute("DELETE FROM write_events WHERE ts < ?", (cutoff,))


# --- reading -----------------------------------------------------------------
# Both readers fail open too: the kill switch is checked first (so a read
# never creates a db file while capture is off), and any other error —
# corrupt row, locked db — returns the empty/None shape rather than raising.

def recent(collection=None, limit=50):
    """Newest-first list of recorded write events, each:

        {"ts", "caller", "collection", "verb", "patch": <parsed list|None>,
         "truncated": bool, "bytes_before", "bytes_after"}
    """
    try:
        if _off():
            return []
        conn = _connect()
        try:
            if collection is None:
                rows = conn.execute(
                    "SELECT ts, caller, collection, verb, patch, truncated,"
                    " bytes_before, bytes_after FROM write_events"
                    " ORDER BY ts DESC, id DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT ts, caller, collection, verb, patch, truncated,"
                    " bytes_before, bytes_after FROM write_events"
                    " WHERE collection = ? ORDER BY ts DESC, id DESC LIMIT ?",
                    (collection, limit),
                ).fetchall()
        finally:
            conn.close()
    except Exception:
        return []

    out = []
    for ts, caller, coll, verb, patch, truncated, bytes_before, bytes_after in rows:
        try:
            parsed = json.loads(patch) if patch is not None else None
        except Exception:
            parsed = None
        out.append({
            "ts": ts, "caller": caller, "collection": coll, "verb": verb,
            "patch": parsed, "truncated": bool(truncated),
            "bytes_before": bytes_before, "bytes_after": bytes_after,
        })
    return out


def capturing_since():
    """Oldest retained event's timestamp, or None when off/empty/unavailable."""
    try:
        if _off():
            return None
        conn = _connect()
        try:
            row = conn.execute("SELECT MIN(ts) FROM write_events").fetchone()
        finally:
            conn.close()
        return row[0] if row else None
    except Exception:
        return None


def last_writes():
    """Per-collection freshness: {collection: newest event ts}. The creek's
    Today mode reads this to fade ribbons by how recently each pool was
    actually written. Fail-open to {} — same rule as every reader here."""
    try:
        if _off():
            return {}
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT collection, MAX(ts) FROM write_events GROUP BY collection"
            ).fetchall()
        finally:
            conn.close()
        return {r[0]: r[1] for r in rows if r[0] and r[1]}
    except Exception:
        return {}
