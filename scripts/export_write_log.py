#!/usr/bin/env python3
"""Export the write journal's finished days into small per-day pieces for git.

Plain English: the app's write journal (writelog.py) is one permanent,
ever-growing SQLite file, ``data/write_log.db``. It is too big for GitHub and
gets bigger every day, so git never sees it. Instead this script copies each
FINISHED day (yesterday and earlier — never today, which is still being
written) into its own small file, ``data/write_log/<YYYY-MM-DD>.db``. A
finished day never changes, so git stores each piece exactly once. The pieces
together hold every row the big file holds, and ``--rebuild`` turns them back
into the big file on a fresh machine.

Run nightly from cron (a few minutes after midnight, so yesterday is closed):

    EXOCORTEX_DATA_DIR=/path/to/data venv/bin/python3 scripts/export_write_log.py

Safe to run any time, as often as you like: a day whose piece already exists
with the same row count is skipped; a piece that is missing or has a
different count is rebuilt from the big file (written to a temp file, then
renamed into place, so a half-written piece can never be committed). Nothing
is ever deleted from the big file.

    --rebuild   the reverse direction: when data/write_log.db is absent (a new
                machine restored from git), recreate it from every piece.
                Refuses to touch an existing big file.
    --dry-run   say what would be exported, do nothing.

Built to this brief: "One big file the exocortex functions off of, and commit
the daily pieces to git. The big file is the truth; the pieces are exports."
"""
import argparse
import os
import sqlite3
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store      # noqa: E402  (sys.path above)
import writelog   # noqa: E402

PIECES_DIR = "write_log"
COLS = "ts, caller, collection, verb, patch, truncated, bytes_before, bytes_after"


def _pieces_dir():
    return store.DATA_DIR / PIECES_DIR


def _piece_path(day):
    return _pieces_dir() / f"{day}.db"


def _count(path):
    """Row count of a piece, or -1 if it can't be read (treated as 'rebuild')."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return conn.execute("SELECT COUNT(*) FROM write_events").fetchone()[0]
        finally:
            conn.close()
    except Exception:
        return -1


def export(dry_run=False):
    big = writelog._db_path()
    if not big.exists():
        print(f"nothing to export: {big} does not exist")
        return 0
    src = sqlite3.connect(f"file:{big}?mode=ro", uri=True, timeout=10)
    src.execute("PRAGMA busy_timeout=10000")
    today = date.today().isoformat()
    days = src.execute(
        "SELECT substr(ts, 1, 10) AS day, COUNT(*) FROM write_events"
        " WHERE substr(ts, 1, 10) < ? GROUP BY day ORDER BY day",
        (today,),
    ).fetchall()
    _pieces_dir().mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    for day, n in days:
        piece = _piece_path(day)
        if piece.exists() and _count(piece) == n:
            skipped += 1
            continue
        if dry_run:
            print(f"would export {day}: {n} rows")
            continue
        tmp = piece.with_name(piece.name + ".tmp")
        for p in (tmp, tmp.with_name(tmp.name + "-wal"), tmp.with_name(tmp.name + "-shm")):
            if p.exists():
                p.unlink()
        dst = sqlite3.connect(tmp, isolation_level=None)
        try:
            # Same schema as the live db, but no WAL: a piece is written once
            # and then only ever read, so plain rollback journal keeps it to
            # one file with no sidecars to ignore.
            writelog._ensure_schema(dst)
            dst.execute("BEGIN")
            rows = src.execute(
                f"SELECT {COLS} FROM write_events WHERE substr(ts, 1, 10) = ? ORDER BY ts, id",
                (day,),
            )
            dst.executemany(
                f"INSERT INTO write_events ({COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows,
            )
            dst.execute("COMMIT")
            dst.execute("VACUUM")
        finally:
            dst.close()
        os.replace(tmp, piece)
        written += 1
        print(f"exported {day}: {n} rows -> {piece.name}")
    src.close()
    print(f"done: {written} written, {skipped} already current, today ({today}) left open")
    return 0


def rebuild():
    big = writelog._db_path()
    if big.exists():
        print(f"refusing: {big} already exists (delete or move it first if you really mean this)")
        return 1
    pieces = sorted(p for p in _pieces_dir().glob("*.db") if writelog_day(p.name))
    if not pieces:
        print(f"no pieces under {_pieces_dir()}")
        return 1
    dst = writelog._connect()
    try:
        total = 0
        for p in pieces:
            dst.execute("ATTACH DATABASE ? AS piece", (str(p),))
            dst.execute("BEGIN")
            dst.execute(f"INSERT INTO write_events ({COLS}) SELECT {COLS} FROM piece.write_events ORDER BY ts, id")
            dst.execute("COMMIT")
            n = dst.execute("SELECT COUNT(*) FROM piece.write_events").fetchone()[0]
            dst.execute("DETACH DATABASE piece")
            total += n
            print(f"restored {p.name}: {n} rows")
    finally:
        dst.close()
    print(f"rebuilt {big} from {len(pieces)} pieces, {total} rows")
    return 0


def writelog_day(name):
    """True for names like 2026-09-17.db — the only files a piece may be called."""
    stem = name[:-3] if name.endswith(".db") else None
    if not stem or len(stem) != 10:
        return False
    try:
        date.fromisoformat(stem)
        return True
    except ValueError:
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rebuild", action="store_true", help="recreate write_log.db from the pieces")
    ap.add_argument("--dry-run", action="store_true", help="report only")
    args = ap.parse_args()
    if args.rebuild:
        return rebuild()
    return export(dry_run=args.dry_run)


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, so only the standalone run counts as a process.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
