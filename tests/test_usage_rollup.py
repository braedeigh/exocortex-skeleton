"""scripts/usage_rollup.py — the access-log → feature_usage.json fold.

Two layers: the pure line parser (no store), and the idempotent writer
(against the isolated data_dir store, since feature_usage is SQL-backed).
"""
import store
from scripts.usage_rollup import parse_lines, write_days


# --- parse_lines (pure) ------------------------------------------------------

def test_dated_lines_bucket_by_date_feature_and_kind():
    out = parse_lines([
        "2026-07-18 09:00:00 GET /api/habits/log → 200",
        "2026-07-18 09:00:01 GET /api/habits → 200",
        "2026-07-18 09:00:02 POST /api/habits/log → 200",
        "2026-07-19 12:00:00 GET /api/kitchen → 200",
    ])
    assert out == {
        "2026-07-18": {"habits": {"reads": 2, "writes": 1}},
        "2026-07-19": {"kitchen": {"reads": 1, "writes": 0}},
    }


def test_old_dateless_lines_are_skipped():
    out = parse_lines([
        "18:18:19 GET /api/habits/log → 200",
        "18:22:37 POST /api/terminal/refresh → 200",
        "",
        "not a log line at all",
    ])
    assert out == {}


def test_excluded_features_drop_reads_but_count_writes():
    out = parse_lines([
        "2026-07-19 10:00:00 GET /api/pending → 200",
        "2026-07-19 10:00:01 GET /api/version → 200",
        "2026-07-19 10:00:02 GET /api/data/today → 200",
        "2026-07-19 10:00:03 GET /api/sessions → 200",
        "2026-07-19 10:00:04 GET /api/usage → 200",
        "2026-07-19 10:00:05 POST /api/usage/tab → 200",
        "2026-07-19 10:00:06 POST /api/sessions → 200",
    ])
    assert out == {"2026-07-19": {
        "usage": {"reads": 0, "writes": 1},
        "sessions": {"reads": 0, "writes": 1},
    }}


def test_terminal_polling_gets_dropped_but_send_and_real_reads_count():
    out = parse_lines([
        "2026-07-19 10:00:00 GET /api/terminal/capture → 200",
        "2026-07-19 10:00:01 GET /api/terminal/needs-input → 200",
        "2026-07-19 10:00:02 GET /api/terminal/recaps → 200",
        "2026-07-19 10:00:03 GET /api/terminal/schedule → 200",
        "2026-07-19 10:00:04 POST /api/terminal/send → 200",
    ])
    assert out == {"2026-07-19": {"terminal": {"reads": 1, "writes": 1}}}


def test_error_status_lines_are_dropped():
    out = parse_lines([
        "2026-07-19 10:00:00 GET /api/habits → 404",
        "2026-07-19 10:00:01 POST /api/habits/log → 500",
        "2026-07-19 10:00:02 GET /api/habits → 401",
        "2026-07-19 10:00:03 GET /api/habits → 200",
    ])
    assert out == {"2026-07-19": {"habits": {"reads": 1, "writes": 0}}}


# --- write_days (idempotent writer) ------------------------------------------

def test_writer_skips_rolled_up_days_and_today(data_dir, capsys):
    store.write("feature_usage.json", {"days": {
        "2026-07-18": {"api": {"habits": {"reads": 1, "writes": 0}},
                       "tabs": {"habits": 2}},
    }})
    counts = {
        "2026-07-18": {"habits": {"reads": 99, "writes": 99}},  # must NOT overwrite
        "2026-07-19": {"kitchen": {"reads": 3, "writes": 1}},
        "2026-07-20": {"habits": {"reads": 5, "writes": 0}},    # today: still growing
    }
    written, skipped = write_days(counts, today="2026-07-20")
    assert written == ["2026-07-19"]
    assert skipped == ["2026-07-18"]
    days = store.read("feature_usage.json")["days"]
    assert days["2026-07-18"]["api"] == {"habits": {"reads": 1, "writes": 0}}
    assert days["2026-07-18"]["tabs"] == {"habits": 2}   # tabs never touched
    assert days["2026-07-19"]["api"] == {"kitchen": {"reads": 3, "writes": 1}}
    assert "2026-07-20" not in days
    out = capsys.readouterr().out
    assert "2026-07-19" in out and "2026-07-18" in out


def test_writer_adds_api_beside_existing_time_and_clicks(data_dir):
    store.write("feature_usage.json", {"days": {
        "2026-07-19": {"time": {"journal": 84},
                       "clicks": {"journal": {"card-edit": 3}}},
    }})
    counts = {"2026-07-19": {"habits": {"reads": 2, "writes": 1}}}
    written, skipped = write_days(counts, today="2026-07-20")
    assert written == ["2026-07-19"]
    assert store.read("feature_usage.json")["days"]["2026-07-19"] == {
        "time": {"journal": 84},                      # untouched
        "clicks": {"journal": {"card-edit": 3}},      # untouched
        "api": {"habits": {"reads": 2, "writes": 1}}, # added
    }


# --- seal_yesterday: the ordering that makes retention safe -----------------
#
# job_runs, filer_nominations and filer_verdicts are the tables in exo.db that
# aren't derived from anything. jobstore.prune() drops runs past
# RETENTION_DAYS, and that is ONLY safe because the JSON mirror was written
# first. These tests pin the ordering, because getting it backwards turns a
# retention policy into a six-month data-loss fuse and nothing would notice
# until someone went looking for a decision that no longer exists.

import pytest

import filerstore
import jobstore
import sqlstore
from scripts.usage_rollup import seal_yesterday


@pytest.fixture
def db(data_dir):
    sqlstore.open_db().close()
    return data_dir


def test_seal_mirrors_both_ledgers_for_the_day(db):
    with jobstore.run("a_job") as r:
        r.acted(1)
    nid = filerstore.nominate(path="x.png", proposal={"destination": "housing"})
    filerstore.rule(nid, "accepted")

    conn = sqlstore.open_db()
    day = conn.execute("SELECT started FROM job_runs LIMIT 1").fetchone()[0][:10]
    conn.close()

    runs, filed, _ = seal_yesterday(day=day)
    assert runs == 1
    assert filed == 2          # one nomination + one verdict
    assert (store.DATA_DIR / jobstore.MIRROR_DIR / f"{day}.json").exists()
    assert (store.DATA_DIR / filerstore.MIRROR_DIR / f"{day}.json").exists()


def test_a_failed_export_stops_the_prune(db, monkeypatch):
    """The fuse. If the mirror can't be written, the rows must stay in the
    database — a too-large db is a nuisance, six months of deleted provenance
    is not recoverable."""
    pruned = []
    monkeypatch.setattr(jobstore, "export_day",
                        lambda day: (_ for _ in ()).throw(OSError("disk full")))
    monkeypatch.setattr(jobstore, "prune", lambda *a, **k: pruned.append(True))

    with pytest.raises(OSError):
        seal_yesterday(day="2026-08-21")
    assert pruned == [], "pruned despite the export failing"


def test_prune_runs_only_after_both_exports(db, monkeypatch):
    order = []
    monkeypatch.setattr(jobstore, "export_day",
                        lambda day: order.append("export_runs") or 0)
    monkeypatch.setattr(filerstore, "export_day",
                        lambda day: order.append("export_filer") or 0)
    monkeypatch.setattr(jobstore, "prune", lambda *a, **k: order.append("prune") or 0)

    seal_yesterday(day="2026-08-21")
    assert order == ["export_runs", "export_filer", "prune"]


def test_filer_provenance_is_never_pruned(db):
    """job_runs ages out at 180 days because it is operational telemetry. The
    filer tables are a training set and only get more valuable with age, so
    there is deliberately no prune for them to call."""
    assert not hasattr(filerstore, "prune")
