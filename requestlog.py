"""Every /api/ request the web app serves, one row each — the access log
that can't lose lines.

**Why not the access log.** server.py already writes one line per request
to access.log through a size-rotating handler. Two things make that
unusable as a record: it rotates every few hours at 500 KB, and gunicorn
runs several workers that each rotate it on their own schedule, so lines
get dropped and duplicated (both access.log and access.log.1 were found
spanning the same fifteen hours). The daily rollup that reads it counts
what survives. This module writes the row itself, from the request path,
into the `requests` table in exo.db, so what is kept is what happened.

**Fail-open, batched, no thread** — the discipline store.py's op counters
keep, because this sits on every request:
  - the after-request hook appends to an in-memory list and returns; it
    never touches SQLite itself unless a flush is due;
  - a flush is piggybacked on whichever request happens to pass when the
    batch is old enough (_FLUSH_EVERY) or big enough (_FLUSH_ROWS), plus a
    best-effort flush at interpreter exit, so a worker that gets recycled
    still writes its last minute down;
  - every hook swallows every exception — telemetry can never break or
    slow a real request beyond negligibly;
  - EXOCORTEX_REQUEST_LOG_OFF=1 disables it entirely.

**Not derived.** Unlike tool_calls or ui_events there is no file underneath
this table; the row is the only copy, which is why `requests` is kept off
the SQL Lab's rebuild button. exo.db is too big for a git backup, so the
backup job writes each finished day of this table out as a gzipped TSV
beside it instead (the vault's `scripts/git_backup.sh`).

Touches: `server.py` (installs the hooks), `sqlstore.py` (the schema).

Prompt that produced this file: "I'm trying to figure out how to record my
usage as granularly as possible ... I wanna turn it all into sql."
"""
import atexit
import os
import threading
import time
from datetime import datetime

import sqlstore

_FLUSH_EVERY = 30.0      # seconds between piggybacked flushes
_FLUSH_ROWS = 200        # or sooner, once the batch is this big
_lock = threading.Lock()
_pending = []
_last_flush = time.monotonic()


def _off():
    return os.environ.get("EXOCORTEX_REQUEST_LOG_OFF", "") == "1"


def feature_of(path):
    """The first segment after /api/, the same 'feature' the daily rollup
    used, so the two agree: /api/habits/log -> habits."""
    parts = path.split("/")
    return parts[2] if len(parts) > 2 and parts[1] == "api" and parts[2] else None


def record(method, path, status, started_monotonic=None):
    """Queue one request; flush if due. Swallows everything."""
    try:
        if _off():
            return
        now = datetime.now()
        duration = None
        if started_monotonic is not None:
            duration = int((time.monotonic() - started_monotonic) * 1000)
        row = (now.isoformat(timespec="milliseconds"), now.strftime("%Y-%m-%d"),
               now.hour, method, path, feature_of(path), int(status), duration,
               os.getpid())
        with _lock:
            _pending.append(row)
            due = (len(_pending) >= _FLUSH_ROWS
                   or time.monotonic() - _last_flush >= _FLUSH_EVERY)
        if due:
            flush()
    except Exception:
        pass


def flush():
    """Write the batch in one transaction. Best-effort: a failure loses that
    batch and nothing else. Tests call this directly."""
    global _last_flush
    try:
        with _lock:
            _last_flush = time.monotonic()
            if not _pending:
                return 0
            rows = list(_pending)
            _pending.clear()
        conn = sqlstore.open_db()
        try:
            sqlstore.begin_immediate(conn)
            conn.executemany(
                "INSERT INTO requests (at, day, hour, method, path, feature,"
                " status, duration_ms, pid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows)
            conn.execute("COMMIT")
        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return len(rows)
    except Exception:
        return 0


def install(app):
    """Hook a Flask app: time each /api/ request and queue a row for it."""
    from flask import g, request

    @app.before_request
    def _request_log_start():
        try:
            g._request_log_started = time.monotonic()
        except Exception:
            pass

    @app.after_request
    def _request_log_record(response):
        try:
            if request.path.startswith("/api/"):
                record(request.method, request.path, response.status_code,
                       getattr(g, "_request_log_started", None))
        except Exception:
            pass
        return response


atexit.register(flush)
