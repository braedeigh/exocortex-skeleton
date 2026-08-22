"""Tests for the write journal (writelog.py) — the standalone SQLite log that
store.write()/mutate() feed on every persisted change.

Mirrors tests/test_store_stats.py's shape: a `wl_on` fixture flips the kill
switch on for one test at a time, against the isolated data_dir, and resets
store's cached caller label so the caller column is deterministic. The
diff_values() tests need no store/data_dir at all — it's a pure function.
"""
import json
from datetime import datetime, timedelta

import pytest

import store
import writelog


@pytest.fixture
def wl_on(data_dir, monkeypatch):
    """Capture enabled, against the isolated data_dir, with a known caller."""
    monkeypatch.setenv("EXOCORTEX_WRITE_LOG_OFF", "0")
    monkeypatch.setattr(store, "_stats_caller_cache", None)
    monkeypatch.setenv("EXOCORTEX_PROC", "testproc")
    return data_dir


# --- diff_values: pure structural diff ----------------------------------------

def test_dict_add_key():
    ops, truncated = writelog.diff_values({"a": 1}, {"a": 1, "b": 2})
    assert ops == [{"op": "add", "path": "b", "to": 2}]
    assert truncated is False


def test_dict_remove_key():
    ops, truncated = writelog.diff_values({"a": 1, "b": 2}, {"a": 1})
    assert ops == [{"op": "remove", "path": "b", "from": 2}]
    assert truncated is False


def test_dict_replace_scalar():
    ops, truncated = writelog.diff_values({"a": 1}, {"a": 2})
    assert ops == [{"op": "replace", "path": "a", "from": 1, "to": 2}]


def test_nested_dict_recurses():
    before = {"items": {"status": "open"}}
    after = {"items": {"status": "done"}}
    ops, _ = writelog.diff_values(before, after)
    assert ops == [{"op": "replace", "path": "items/status", "from": "open", "to": "done"}]


def test_unchanged_dict_produces_no_ops():
    ops, truncated = writelog.diff_values({"a": 1, "b": [1, 2]}, {"a": 1, "b": [1, 2]})
    assert ops == []
    assert truncated is False


def test_id_list_matches_by_id_and_recurses_change():
    before = {"items": [{"id": "a", "status": "open"}, {"id": "b", "status": "open"}]}
    after = {"items": [{"id": "a", "status": "done"}, {"id": "b", "status": "open"}]}
    ops, truncated = writelog.diff_values(before, after)
    assert ops == [{"op": "replace", "path": "items/0/status", "from": "open", "to": "done"}]
    assert truncated is False


def test_id_list_add_and_remove_dont_look_like_every_item_changed():
    before = {"items": [{"id": "a"}]}
    after = {"items": [{"id": "a"}, {"id": "b"}]}
    ops, _ = writelog.diff_values(before, after)
    assert ops == [{"op": "add", "path": "items/1", "note": "id=b added"}]

    before2 = {"items": [{"id": "a"}, {"id": "b"}]}
    after2 = {"items": [{"id": "a"}]}
    ops2, _ = writelog.diff_values(before2, after2)
    assert ops2 == [{"op": "remove", "path": "items/1", "note": "id=b removed"}]


def test_id_list_reorder_only_is_not_reported_as_changes():
    before = {"items": [{"id": "a", "status": "open"}, {"id": "b", "status": "open"}]}
    after = {"items": [{"id": "b", "status": "open"}, {"id": "a", "status": "open"}]}
    ops, _ = writelog.diff_values(before, after)
    assert ops == []


def test_scalar_list_short_reports_setwise_add_remove():
    ops, truncated = writelog.diff_values({"tags": ["a", "b"]}, {"tags": ["a", "c"]})
    assert {"op": "remove", "path": "tags", "from": "b"} in ops
    assert {"op": "add", "path": "tags", "to": "c"} in ops
    assert len(ops) == 2
    assert truncated is False


def test_long_scalar_list_summarizes_instead_of_itemizing():
    before = {"items": list(range(40))}
    after = {"items": list(range(35))}
    ops, _ = writelog.diff_values(before, after)
    assert ops == [{"op": "replace", "path": "items", "note": "list changed, len 40 -> 35"}]


def test_none_before_is_a_single_created_marker():
    ops, truncated = writelog.diff_values(None, {"a": 1, "b": [1, 2, 3]})
    assert ops == [{"op": "add", "path": "", "note": "created"}]
    assert truncated is False


def test_none_after_is_a_single_deleted_marker():
    ops, truncated = writelog.diff_values({"a": 1}, None)
    assert ops == [{"op": "remove", "path": "", "note": "deleted"}]
    assert truncated is False


def test_op_cap_truncates_and_flags():
    before = {str(i): i for i in range(150)}
    after = {str(i): i + 1 for i in range(150)}
    ops, truncated = writelog.diff_values(before, after)
    assert len(ops) == 100
    assert truncated is True


def test_long_string_scalar_is_capped_in_the_op():
    long_val = "x" * 500
    ops, _ = writelog.diff_values({"a": "short"}, {"a": long_val})
    assert ops[0]["to"] != long_val
    assert len(ops[0]["to"]) <= writelog._MAX_STR + 1  # + the ellipsis char


# --- record()/recent(): round-trip against a tmp db ---------------------------

def test_record_and_recent_round_trip(wl_on):
    writelog.record("places", "write", None, {"a": 1})
    writelog.record("places", "write", {"a": 1}, {"a": 2})

    events = writelog.recent("places")
    assert len(events) == 2
    latest = events[0]  # newest first
    assert latest["collection"] == "places"
    assert latest["verb"] == "write"
    assert latest["caller"] == "testproc"
    assert latest["patch"] == [{"op": "replace", "path": "a", "from": 1, "to": 2}]
    assert latest["truncated"] is False
    assert latest["bytes_before"] == len(json.dumps({"a": 1}))
    assert latest["bytes_after"] == len(json.dumps({"a": 2}))

    oldest = events[1]
    assert oldest["patch"] == [{"op": "add", "path": "", "note": "created"}]


def test_recent_filters_by_collection(wl_on):
    writelog.record("places", "write", None, {"a": 1})
    writelog.record("todos", "write", None, {"b": 1})
    assert [e["collection"] for e in writelog.recent("places")] == ["places"]
    assert {e["collection"] for e in writelog.recent()} == {"places", "todos"}


def test_capturing_since_returns_oldest_ts(wl_on):
    assert writelog.capturing_since() is None
    writelog.record("places", "write", None, {"a": 1})
    since = writelog.capturing_since()
    assert since is not None
    writelog.record("places", "write", {"a": 1}, {"a": 2})
    assert writelog.capturing_since() == since  # unchanged by a later event


def test_capturing_since_none_when_kill_switch_on(data_dir, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_WRITE_LOG_OFF", "1")
    assert writelog.capturing_since() is None


def test_record_truncates_large_patch_to_byte_cap(wl_on):
    before = {str(i): "x" * 80 for i in range(90)}
    after = {str(i): "y" * 80 for i in range(90)}
    writelog.record("places", "write", before, after)
    event = writelog.recent("places")[0]
    assert event["truncated"] is True
    assert len(json.dumps(event["patch"]).encode("utf-8")) <= writelog._MAX_PATCH_BYTES


# --- kill switch ---------------------------------------------------------------

def test_kill_switch_creates_no_db_file(data_dir, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_WRITE_LOG_OFF", "1")
    store.write("places", {"p": 1})
    store.write("places", {"p": 2})
    with store.mutate("places", {}) as d:
        d["p"] = 3
    assert not (data_dir / writelog.DB_NAME).exists()


def test_kill_switch_off_is_the_suite_default(data_dir):
    """No explicit monkeypatch here — conftest's setdefault must already have
    the switch on, or every other test in the suite would be capturing."""
    store.write("places", {"p": 1})
    assert not (data_dir / writelog.DB_NAME).exists()


# --- fail-open: capture can never break a real store op ------------------------

def test_broken_connect_never_breaks_store_write(wl_on, monkeypatch):
    # A non-SQL-backed collection ("log") is essential here: "places" is
    # SQL-backed, and store.write's own persistence for it ALSO goes through
    # sqlite3.connect (sqlstore._connect) — this test wants to break only the
    # journal's connection, not the real write's.
    def boom(*a, **k):
        raise RuntimeError("disk full")
    monkeypatch.setattr(writelog.sqlite3, "connect", boom)

    store.write("log", {"p": 1})
    assert store.read("log") == {"p": 1}
    assert writelog.recent("log") == []  # the reader fails open too


def test_broken_diff_never_breaks_store_write(wl_on, monkeypatch):
    def boom(before, after):
        raise RuntimeError("diff exploded")
    monkeypatch.setattr(writelog, "diff_values", boom)

    store.write("log", {"p": 1})
    assert store.read("log") == {"p": 1}


def test_broken_deepcopy_never_breaks_mutate(wl_on, monkeypatch):
    def boom(data):
        raise RuntimeError("deepcopy exploded")
    monkeypatch.setattr(store.copy, "deepcopy", boom)

    store.write("log", {"entries": []})
    with store.mutate("log") as d:
        d["entries"].append("first")
    assert store.read("log")["entries"] == ["first"]
    # Capture was skipped for the mutate (ok=False) — only the seed write()
    # (which doesn't deepcopy) made it into the journal.
    assert [e["verb"] for e in writelog.recent("log")] == ["write"]


# --- mutate() captures a diff ---------------------------------------------------

def test_mutate_captures_a_diff(wl_on):
    store.write("log", {"entries": []})  # this seed write is journaled too
    with store.mutate("log") as d:
        d["entries"].append("first")

    mutate_events = [e for e in writelog.recent("log") if e["verb"] == "mutate"]
    assert len(mutate_events) == 1
    assert mutate_events[0]["patch"] == [{"op": "add", "path": "entries", "to": "first"}]


def test_mutate_records_nothing_when_block_raises(wl_on):
    store.write("log", {"entries": ["keep"]})
    with pytest.raises(ValueError):
        with store.mutate("log") as d:
            d["entries"].append("doomed")
            raise ValueError("boom")
    # Only the seed write() shows up — the raised mutate journaled nothing.
    assert [e["verb"] for e in writelog.recent("log")] == ["write"]


# --- retention: pruned opportunistically, never on a timer ---------------------

def test_prune_removes_events_older_than_the_retention_window(wl_on):
    conn = writelog._connect()
    old_ts = (datetime.now() - timedelta(days=writelog._RETENTION_DAYS + 10)).isoformat(timespec="seconds")
    fresh_ts = datetime.now().isoformat(timespec="seconds")
    for ts in (old_ts, fresh_ts):
        conn.execute(
            "INSERT INTO write_events"
            " (ts, caller, collection, verb, patch, truncated, bytes_before, bytes_after)"
            " VALUES (?, 'x', 'places', 'write', '[]', 0, 0, 0)",
            (ts,),
        )
    writelog._prune(conn)
    conn.close()

    remaining = [e["ts"] for e in writelog.recent("places", limit=100)]
    assert old_ts not in remaining
    assert fresh_ts in remaining
