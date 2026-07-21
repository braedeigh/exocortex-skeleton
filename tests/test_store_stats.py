"""store.py's per-collection op counters (the "store" key of feature_usage).

The suite-wide kill switch (EXOCORTEX_STORE_STATS_OFF=1, set in conftest.py)
is re-enabled here per test via monkeypatch, against the isolated data_dir.
The one invariant that matters most: telemetry must NEVER break a real op.
"""
import time
from datetime import datetime

import pytest

import store


@pytest.fixture
def stats_on(data_dir, monkeypatch):
    """Counting enabled, fresh counters, a known caller label, and a
    last-flush stamp of 'now' so no piggyback flush fires mid-test."""
    monkeypatch.setenv("EXOCORTEX_STORE_STATS_OFF", "0")
    monkeypatch.setenv("EXOCORTEX_PROC", "testproc")
    monkeypatch.setattr(store, "_stats_counts", {})
    monkeypatch.setattr(store, "_stats_caller_cache", None)
    monkeypatch.setattr(store, "_stats_last_flush", time.monotonic())
    return data_dir


def _today():
    return datetime.now().strftime("%Y-%m-%d")


# --- counting ----------------------------------------------------------------

def test_ops_count_under_caller_collection_and_kind(stats_on):
    store.read("places", {})
    store.write("places", {"p": 1})
    with store.mutate("places", {}) as data:
        data["p"] = 2
    assert store._stats_counts == {
        ("testproc", "places", "reads"): 1,
        ("testproc", "places", "writes"): 2,  # write + mutate; mutate is ONE write
    }


def test_feature_usage_ops_are_never_counted(stats_on):
    store.read("feature_usage.json", {"days": {}})
    store.write("feature_usage.json", {"days": {}})
    with store.mutate("feature_usage.json", {"days": {}}) as data:
        data.setdefault("days", {})
    assert store._stats_counts == {}


def test_kill_switch_suppresses_counting(stats_on, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_STORE_STATS_OFF", "1")
    store.read("places", {})
    store.write("places", {"p": 1})
    assert store._stats_counts == {}


# --- flushing ----------------------------------------------------------------

def test_flush_writes_documented_shape_and_accumulates(stats_on):
    store.read("places", {})
    store.write("places", {"p": 1})
    store._stats_flush()

    day = store.read("feature_usage.json")["days"][_today()]
    assert day["store"] == {"testproc": {"places": {"reads": 1, "writes": 1}}}
    assert store._stats_counts == {}  # counters reset by the flush

    # A second window accumulates with += rather than overwriting.
    store.read("places", {})
    store.read("todos", {})
    store._stats_flush()
    day = store.read("feature_usage.json")["days"][_today()]
    assert day["store"]["testproc"]["places"] == {"reads": 2, "writes": 1}
    assert day["store"]["testproc"]["todos"] == {"reads": 1, "writes": 0}


def test_flush_leaves_other_day_keys_alone(stats_on):
    store.write("feature_usage.json", {"days": {_today(): {"tabs": {"habits": 4}}}})
    store.read("places", {})
    store._stats_flush()
    day = store.read("feature_usage.json")["days"][_today()]
    assert day["tabs"] == {"habits": 4}
    assert day["store"] == {"testproc": {"places": {"reads": 1, "writes": 0}}}


def test_flush_with_kill_switch_is_a_noop(stats_on, monkeypatch):
    store.read("places", {})
    monkeypatch.setenv("EXOCORTEX_STORE_STATS_OFF", "1")
    store._stats_flush()
    assert store.read("feature_usage.json", {"days": {}}) == {"days": {}}
    assert store._stats_counts != {}  # not even reset — flushing was fully off


# --- telemetry can never break a real op -------------------------------------

def test_broken_counting_never_breaks_the_real_op(stats_on, monkeypatch):
    def boom():
        raise RuntimeError("telemetry exploded")
    monkeypatch.setattr(store, "_stats_caller", boom)

    store.write("places", {"p": 1})           # must still persist
    assert store.read("places") == {"p": 1}   # must still read back
    with store.mutate("places", {}) as data:  # must still mutate
        data["p"] = 2
    assert store.read("places") == {"p": 2}
    assert store._stats_counts == {}          # nothing counted, nothing raised


def test_broken_flush_never_breaks_and_loses_only_that_window(stats_on, monkeypatch):
    store.read("places", {})

    def broken_mutate(*a, **k):
        raise RuntimeError("data dir vanished")
    monkeypatch.setattr(store, "mutate", broken_mutate)
    store._stats_flush()  # must swallow, not raise (this is the atexit path)

    # That window's counts were snapshotted before the failure — lost, by design.
    assert store._stats_counts == {}
