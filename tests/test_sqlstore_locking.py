"""Two writers at once must both land — the gevent lock trap.

The app runs under gunicorn's gevent worker and sqlite3 is a C extension gevent
cannot patch, so a greenlet parked in SQLite's busy handler freezes its whole
worker — including the greenlet holding the transaction it is waiting for. That
turned every concurrent write pair into a five-second stall with one
`database is locked`, however trivial the work, and it was quietly costing the
usage beacons about five writes a day.

So the property under test is not "writes serialize" — they always did. It is
**where the waiting happens**: in Python, where it yields, and never inside
SQLite, where it does not.
"""
import sqlite3
import subprocess
import sys
import textwrap
import threading
import time

import pytest

import sqlstore
import store


def test_busy_timeout_stays_short_enough_to_not_stall_the_worker():
    """The C-level wait is a floor for incidental contention, not the strategy.
    Raise this and the hub-blocking bug comes straight back."""
    assert sqlstore._BUSY_MS <= 500


def test_begin_immediate_is_uncontended_fast(data_dir):
    conn = sqlstore._connect()
    try:
        t = time.monotonic()
        sqlstore.begin_immediate(conn)
        conn.execute("ROLLBACK")
        assert time.monotonic() - t < 0.5
    finally:
        conn.close()


def test_waiting_for_the_lock_happens_in_python_not_in_sqlite(data_dir, monkeypatch):
    """The load-bearing assertion: while blocked, it calls time.sleep.

    Under gevent that call is monkey-patched and yields the hub, which is the
    only reason the holder can reach its COMMIT. If a future change pushes the
    waiting back down into SQLite's busy handler this fails, and it should.
    """
    holder = sqlstore._connect()
    waiter = sqlstore._connect()
    slept = []

    real_sleep = time.sleep

    def recording_sleep(seconds):
        slept.append(seconds)
        # Let the holder go on the first wait, so the retry can succeed.
        if len(slept) == 1:
            holder.execute("COMMIT")
        real_sleep(0.001)

    try:
        sqlstore.begin_immediate(holder)
        holder.execute(
            "INSERT INTO docs (name, data) VALUES ('probe', '{}')"
            " ON CONFLICT(name) DO NOTHING"
        )
        monkeypatch.setattr(sqlstore.time, "sleep", recording_sleep)

        sqlstore.begin_immediate(waiter)
        waiter.execute("ROLLBACK")

        assert slept, "took the lock without ever yielding — the wait is back in C"
    finally:
        for conn in (holder, waiter):
            try:
                conn.execute("ROLLBACK")
            except sqlite3.OperationalError:
                pass
            conn.close()


def test_a_lock_that_never_clears_still_raises(data_dir, monkeypatch):
    """A stuck database must surface, not hang forever."""
    holder = sqlstore._connect()
    waiter = sqlstore._connect()
    try:
        sqlstore.begin_immediate(holder)
        holder.execute(
            "INSERT INTO docs (name, data) VALUES ('probe', '{}')"
            " ON CONFLICT(name) DO NOTHING"
        )
        monkeypatch.setattr(sqlstore.time, "sleep", lambda s: None)
        with pytest.raises(sqlite3.OperationalError):
            sqlstore.begin_immediate(waiter, budget=0.05)
    finally:
        for conn in (holder, waiter):
            try:
                conn.execute("ROLLBACK")
            except sqlite3.OperationalError:
                pass
            conn.close()


def test_many_connections_can_migrate_a_fresh_database_at_once(data_dir):
    """The ladder is not re-entrant across connections.

    v9 DROPs and recreates `session_turns` with a bare CREATE, so two
    connections climbing an unmigrated database together used to race into
    `table session_turns already exists` about half the time. Fresh installs
    only — an already-migrated database never reaches the ladder — which is
    how it stayed hidden.
    """
    errors = []

    def connect():
        try:
            sqlstore._connect().close()
        except Exception as exc:  # pragma: no cover - the failure we're pinning
            errors.append(exc)

    threads = [threading.Thread(target=connect) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    conn = sqlstore._connect()
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == sqlstore._SCHEMA_VERSION
        assert sqlstore._tables_present(conn)
    finally:
        conn.close()


def test_concurrent_mutates_from_real_threads_both_land(data_dir):
    """Cheap sanity check that the retry didn't break plain serialization."""
    errors = []

    def bump():
        try:
            with sqlstore.mutate("counter", {"n": 0}) as data:
                data["n"] = data.get("n", 0) + 1
        except Exception as exc:  # pragma: no cover - the failure we're pinning
            errors.append(exc)

    threads = [threading.Thread(target=bump) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert sqlstore.get("counter")["n"] == 8


# The real thing: gevent monkey-patching has to happen before anything else is
# imported, so this runs in its own interpreter. Under the old code the waiter
# failed with `database is locked` after ~5s while the holder needed 0.2s.
_GEVENT_REPRO = textwrap.dedent(
    """
    from gevent import monkey; monkey.patch_all()
    import sys, gevent, tempfile, pathlib
    sys.path.insert(0, {repo!r})
    import store
    store.DATA_DIR = pathlib.Path(tempfile.mkdtemp())
    import sqlstore

    results = []

    def writer(hold):
        try:
            with sqlstore.mutate("probe", {{"n": 0}}) as d:
                d["n"] += 1
                if hold:
                    gevent.sleep(0.2)   # any yield while holding the lock
            results.append("ok")
        except Exception as exc:
            results.append("FAIL %s" % exc)

    gevent.joinall([gevent.spawn(writer, True), gevent.spawn(writer, False)])
    print(",".join(results))
    """
)


def test_two_greenlets_in_one_worker_both_commit(tmp_path):
    gevent = pytest.importorskip("gevent")  # noqa: F841 - availability check only
    repo = str(store.BUILD_DIR)
    proc = subprocess.run(
        [sys.executable, "-c", _GEVENT_REPRO.format(repo=repo)],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().endswith("ok,ok"), proc.stdout + proc.stderr
