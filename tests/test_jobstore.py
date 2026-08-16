"""jobstore.py — the job_runs provenance table.

Isolated per-test via the `data_dir` fixture (store.DATA_DIR -> tmp_path), so
each test gets its own exo.db, same as the other store-layer tests.

The most important test in this file is
`test_recording_never_breaks_the_job`: 19 cron jobs are wrapped in this
recorder, and a bookkeeping bug that takes them down is far worse than a
missing row.
"""
from datetime import datetime, timedelta
import json

import pytest

import jobstore
import sqlstore
import store


@pytest.fixture
def db(data_dir):
    """A migrated database in the isolated data dir."""
    sqlstore.open_db().close()
    return data_dir


def rows():
    conn = sqlstore.open_db()
    try:
        cols = ["id", "job", "started", "finished", "status", "ticks",
                "looked", "acted", "failed", "note"]
        return [dict(zip(cols, r)) for r in conn.execute(
            f"SELECT {', '.join(cols)} FROM job_runs ORDER BY id").fetchall()]
    finally:
        conn.close()


# --- the status writes itself ---------------------------------------------

def test_a_run_that_changes_nothing_is_a_noop(db):
    with jobstore.run("quiet"):
        pass
    assert [r["status"] for r in rows()] == ["noop"]


def test_looking_without_acting_is_still_a_noop(db):
    """A dispatcher that examines three queued runs and admits none has done
    nothing — promoting that to `ok` would defeat the hourly collapsing."""
    with jobstore.run("dispatcher") as r:
        r.looked(3)
    got = rows()[0]
    assert got["status"] == "noop"
    assert got["looked"] == 3


def test_acting_makes_it_ok(db):
    with jobstore.run("sorter") as r:
        r.looked(10)
        r.acted(4)
    got = rows()[0]
    assert (got["status"], got["looked"], got["acted"]) == ("ok", 10, 4)


def test_any_error_count_makes_it_failed_even_when_it_also_acted(db):
    """A swarm that tagged 5 cards and blew up on 35 is not a success."""
    with jobstore.run("swarm") as r:
        r.acted(5)
        r.failed(35, "cricket 'threads' errored")
    got = rows()[0]
    assert got["status"] == "failed"
    assert (got["acted"], got["failed"]) == (5, 35)
    assert "threads" in got["note"]


def test_skip_is_not_a_failure(db):
    with jobstore.run("paused") as r:
        r.skip("disabled in scheduled_runs.json")
    got = rows()[0]
    assert got["status"] == "skipped"
    assert "disabled" in got["note"]


def test_an_exception_is_recorded_and_still_raised(db):
    with pytest.raises(ValueError):
        with jobstore.run("boom"):
            raise ValueError("no transcripts")
    got = rows()[0]
    assert got["status"] == "failed"
    assert "no transcripts" in got["note"]
    assert got["finished"] is not None


def test_the_note_holds_one_line_not_a_traceback(db):
    with pytest.raises(RuntimeError):
        with jobstore.run("boom"):
            raise RuntimeError("x" * 5000)
    assert len(rows()[0]["note"]) <= 500


# --- the row exists from the START ----------------------------------------

def test_the_row_is_written_before_the_work_runs(db):
    """A run that dies mid-flight leaves an open row — the only way a job that
    never came back can announce itself."""
    seen = []
    with jobstore.run("slow"):
        seen = rows()
    assert len(seen) == 1
    assert seen[0]["status"] == "running"
    assert seen[0]["finished"] is None


# --- no-op collapsing ------------------------------------------------------

def test_noops_in_the_same_hour_collapse_onto_one_heartbeat(db):
    for _ in range(5):
        with jobstore.run("every_minute"):
            pass
    got = rows()
    assert len(got) == 1
    assert got[0]["ticks"] == 5
    assert got[0]["status"] == "noop"


def test_collapsing_leaves_no_orphaned_running_rows(db):
    for _ in range(3):
        with jobstore.run("every_minute"):
            pass
    assert [r["status"] for r in rows()] == ["noop"]


def test_a_real_run_never_collapses(db):
    """The heartbeat is one row per job per clock hour, and a real run in the
    middle doesn't start a new one: the second no-op rejoins the SAME
    heartbeat. So an idle hour with one piece of work in it is two rows — the
    work, kept whole and separate, and the tick count around it."""
    with jobstore.run("j"):
        pass
    with jobstore.run("j") as r:
        r.acted(1)
    with jobstore.run("j"):
        pass
    got = rows()
    assert [r["status"] for r in got] == ["noop", "ok"]
    assert got[0]["ticks"] == 2
    assert got[1]["acted"] == 1


def test_different_jobs_do_not_share_a_heartbeat(db):
    with jobstore.run("a"):
        pass
    with jobstore.run("b"):
        pass
    assert sorted(r["job"] for r in rows()) == ["a", "b"]


# --- recording can never break the job ------------------------------------

def test_recording_never_breaks_the_job(db, monkeypatch):
    """The rule store.py's op counters follow, for the same reason: 19 cron
    jobs run inside this context manager."""
    def explode(*a, **kw):
        raise sqlstore.sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(sqlstore, "open_db", explode)

    ran = []
    with jobstore.run("resilient") as r:
        r.looked(1)
        r.acted(1)
        r.note("still did the work")
        ran.append(True)
    assert ran == [True]


def test_the_jobs_own_exception_still_propagates_when_recording_is_broken(db, monkeypatch):
    monkeypatch.setattr(sqlstore, "open_db",
                        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("db gone")))
    with pytest.raises(ValueError):
        with jobstore.run("j"):
            raise ValueError("the real failure")


def test_a_broken_registry_write_does_not_break_the_job(db, monkeypatch):
    def explode(*a, **kw):
        raise OSError("read-only file system")
    monkeypatch.setattr(store, "mutate", explode)
    with jobstore.run("j") as r:
        r.acted(1)
    assert rows()[0]["status"] == "ok"


def test_detail_survives_an_unserializable_payload(db):
    with jobstore.run("j") as r:
        r.detail({"fn": lambda: None})
        r.acted(1)
    assert rows()[0]["status"] == "ok"


# --- the Automations registry ---------------------------------------------

def test_a_real_run_lands_on_the_automations_registry(db):
    with jobstore.run("newjob") as r:
        r.acted(1)
    entry = store.read("scheduled_runs.json")["runs"][0]
    assert entry["id"] == "newjob"
    assert entry["last_status"] == "ok"
    assert entry["last_run"]
    assert entry["enabled"] is True


def test_the_registry_upsert_never_clobbers_a_hand_written_description(db):
    store.write("scheduled_runs.json", {"runs": [{
        "id": "spark_morning", "name": "Morning Spark",
        "description": "hand written", "schedule": "0 5 * * *",
        "enabled": False, "last_status": "ok"}]})
    with jobstore.run("spark_morning") as r:
        r.failed(1)
    entry = store.read("scheduled_runs.json")["runs"][0]
    assert entry["description"] == "hand written"
    assert entry["schedule"] == "0 5 * * *"
    assert entry["enabled"] is False      # the toggle is hers, not ours
    assert entry["last_status"] == "failed"


def test_collapsed_noop_ticks_do_not_touch_the_registry(db):
    """A job idling all night takes one flock an hour, not sixty."""
    with jobstore.run("quiet"):
        pass
    first = store.read("scheduled_runs.json")["runs"][0]["last_run"]
    for _ in range(4):
        with jobstore.run("quiet"):
            pass
    assert store.read("scheduled_runs.json")["runs"][0]["last_run"] == first
    assert rows()[0]["ticks"] == 5


# --- reading it back -------------------------------------------------------

def test_recent_filters_by_job_and_returns_newest_first(db):
    with jobstore.run("a") as r:
        r.acted(1)
    with jobstore.run("b") as r:
        r.acted(1)
    with jobstore.run("a") as r:
        r.acted(2)
    got = jobstore.recent(job="a")
    assert [g["job"] for g in got] == ["a", "a"]
    assert got[0]["acted"] == 2


def test_summary_counts_outcomes_and_flags_stuck_runs(db):
    with jobstore.run("j") as r:
        r.acted(3)
    with pytest.raises(ValueError):
        with jobstore.run("j"):
            raise ValueError("nope")
    with jobstore.run("j"):
        pass
    # A run that opened six hours ago and never closed.
    stuck = (datetime.now() - timedelta(hours=9)).replace(
        microsecond=0).isoformat(sep="T")
    conn = sqlstore.open_db()
    conn.execute("INSERT INTO job_runs (job, started, status)"
                 " VALUES ('j', ?, 'running')", (stuck,))
    conn.close()

    s = {row["job"]: row for row in jobstore.summary()}["j"]
    assert (s["ok"], s["failed"], s["noop_ticks"]) == (1, 1, 1)
    assert s["open_runs"] == 1
    assert s["acted"] == 3


# --- retention and the mirror ---------------------------------------------

def test_export_day_writes_a_readable_mirror(db):
    with jobstore.run("j") as r:
        r.acted(2)
        r.note("did a thing")
    today = datetime.now().strftime("%Y-%m-%d")
    assert jobstore.export_day(today) == 1
    path = store.DATA_DIR / jobstore.MIRROR_DIR / f"{today}.json"
    payload = json.loads(path.read_text())
    assert payload["day"] == today
    assert payload["runs"][0]["note"] == "did a thing"
    assert payload["runs"][0]["acted"] == 2


def test_prune_drops_old_runs_and_keeps_recent_ones(db):
    old = (datetime.now() - timedelta(days=400)).replace(
        microsecond=0).isoformat(sep="T")
    conn = sqlstore.open_db()
    conn.execute("INSERT INTO job_runs (job, started, status)"
                 " VALUES ('j', ?, 'ok')", (old,))
    conn.close()
    with jobstore.run("j") as r:
        r.acted(1)

    assert jobstore.prune(180) == 1
    assert [r["status"] for r in rows()] == ["ok"]


def test_job_runs_is_not_in_the_rebuild_list():
    """Every other typed table can be wiped and re-derived from its source.
    This one cannot — a rebuild here would delete history that exists nowhere
    else, so it must never appear on the SQL page's rebuild button."""
    import routes.sqlab as sqlab
    assert "job_runs" not in sqlab.TYPED_TABLES
