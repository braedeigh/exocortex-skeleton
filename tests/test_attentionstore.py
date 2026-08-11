"""The attention record: what survives the way in, and what the table mirrors.

Two things are being protected here. The JSONL is the source of truth, so
anything that reaches it has to be true — hence the bounds tests. And the
table is a one-way mirror of it, so re-deriving must be idempotent: a retried
flush can't be allowed to double-count a sitting.
"""
from datetime import datetime, timedelta
import json

import pytest

import attentionstore
import sqlstore


def ms(dt):
    return dt.timestamp() * 1000


@pytest.fixture
def now():
    # A fixed "now" well away from midnight so day-bucketing tests don't
    # depend on when the suite happens to run.
    return datetime(2026, 8, 10, 14, 0, 0)


def seg(started, ended, tab="observatory", conv="2026-08-09.030450"):
    return {"tab": tab, "conv": conv, "started": ms(started), "ended": ms(ended)}


def rows():
    with sqlstore._connect() as conn:
        return conn.execute(
            "SELECT tab, conv, started, ended, day FROM attention_segments"
            " ORDER BY started"
        ).fetchall()


# --- clean(): the bounds ------------------------------------------------------

def test_clean_converts_epoch_ms_to_local_naive_iso(data_dir, now):
    out, rejected = attentionstore.clean(
        [seg(now - timedelta(minutes=30), now)], now=now)
    assert rejected == 0
    assert out == [{"tab": "observatory", "conv": "2026-08-09.030450",
                    "started": "2026-08-10T13:30:00",
                    "ended": "2026-08-10T14:00:00"}]


def test_clean_drops_zero_length_segments_without_counting_them_junk(data_dir, now):
    # Sub-second dwell that rounded away is nothing, not a lie.
    out, rejected = attentionstore.clean([seg(now, now)], now=now)
    assert out == [] and rejected == 0


def test_clean_rejects_a_segment_that_ends_in_the_future(data_dir, now):
    out, rejected = attentionstore.clean(
        [seg(now, now + timedelta(hours=1))], now=now)
    assert out == [] and rejected == 1


def test_clean_tolerates_small_clock_skew_ahead(data_dir, now):
    # A device a minute fast is normal; refusing it would lose real sittings.
    out, rejected = attentionstore.clean(
        [seg(now - timedelta(minutes=5), now + timedelta(minutes=1))], now=now)
    assert len(out) == 1 and rejected == 0


def test_clean_rejects_ancient_and_overlong_segments(data_dir, now):
    old = seg(now - timedelta(days=9), now - timedelta(days=9) + timedelta(minutes=5))
    huge = seg(now - timedelta(days=2), now)
    out, rejected = attentionstore.clean([old, huge], now=now)
    assert out == [] and rejected == 2


def test_clean_keeps_good_segments_alongside_bad_ones(data_dir, now):
    # One bad item must not cost the good ones in the same flush — the whole
    # reason segments aren't validated like the counters in routes/usage.py.
    good = seg(now - timedelta(minutes=10), now - timedelta(minutes=5))
    out, rejected = attentionstore.clean(
        [good, {"tab": "", "started": 1, "ended": 2}, "not a dict"], now=now)
    assert len(out) == 1 and rejected == 2


def test_clean_accepts_a_segment_with_no_conversation(data_dir, now):
    out, _ = attentionstore.clean(
        [seg(now - timedelta(minutes=5), now, tab="todos", conv=None)], now=now)
    assert out[0]["conv"] is None


def test_clean_never_raises_on_junk_input(data_dir, now):
    assert attentionstore.clean(None, now=now) == ([], 0)
    assert attentionstore.clean("nope", now=now) == ([], 0)
    out, rejected = attentionstore.clean(
        [{"tab": "todos", "started": "yesterday", "ended": True}], now=now)
    assert out == [] and rejected == 1


# --- record(): file + mirror --------------------------------------------------

def test_record_writes_the_day_file_and_mirrors_it(data_dir, now):
    res = attentionstore.record([seg(now - timedelta(minutes=30), now)], now=now)
    assert res == {"written": 1, "rejected": 0}

    path = data_dir / "attention" / "2026-08-10.jsonl"
    lines = [json.loads(x) for x in path.read_text().splitlines()]
    assert lines[0]["started"] == "2026-08-10T13:30:00"
    assert rows() == [("observatory", "2026-08-09.030450",
                       "2026-08-10T13:30:00", "2026-08-10T14:00:00",
                       "2026-08-10")]


def test_a_segment_files_under_the_day_it_started(data_dir):
    # Crossing midnight keeps the sitting whole rather than inventing a
    # boundary her attention didn't have.
    now = datetime(2026, 8, 11, 0, 30, 0)
    attentionstore.record(
        [seg(datetime(2026, 8, 10, 23, 45), datetime(2026, 8, 11, 0, 20))], now=now)
    assert (data_dir / "attention" / "2026-08-10.jsonl").exists()
    assert not (data_dir / "attention" / "2026-08-11.jsonl").exists()
    assert rows()[0][4] == "2026-08-10"


def test_replaying_the_same_day_does_not_double_count(data_dir, now):
    attentionstore.record([seg(now - timedelta(minutes=30), now)], now=now)
    attentionstore.sync_day("2026-08-10")
    attentionstore.sync_day("2026-08-10")
    assert len(rows()) == 1


def test_appending_a_second_segment_keeps_the_first(data_dir, now):
    attentionstore.record([seg(now - timedelta(minutes=30),
                               now - timedelta(minutes=20))], now=now)
    attentionstore.record([seg(now - timedelta(minutes=10), now)], now=now)
    assert len(rows()) == 2


def test_rebuild_restores_the_table_from_the_files_alone(data_dir, now):
    attentionstore.record([seg(now - timedelta(minutes=30), now)], now=now)
    with sqlstore._connect() as conn:
        conn.execute("DELETE FROM attention_segments")
    assert rows() == []

    assert attentionstore.rebuild() == {"days": 1, "segments": 1}
    assert len(rows()) == 1


def test_rebuild_on_an_empty_install_is_not_an_error(data_dir):
    assert attentionstore.rebuild() == {"days": 0, "segments": 0}


def test_a_truncated_final_line_costs_only_itself(data_dir, now):
    # The shape a crash mid-append leaves.
    attentionstore.record([seg(now - timedelta(minutes=30), now)], now=now)
    path = data_dir / "attention" / "2026-08-10.jsonl"
    with path.open("a") as fh:
        fh.write('{"tab": "todos", "started": "2026-08-1')
    assert attentionstore.rebuild()["segments"] == 1
