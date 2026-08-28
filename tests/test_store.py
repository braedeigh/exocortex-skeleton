"""Tests for the atomic JSON store (store.py).

These guard the single read/write path the whole app depends on: round-tripping,
default-on-missing, and that ``mutate`` persists changes but does NOT write when
the block raises (so a mid-update error can't leave a partial file).
"""
import pytest

import store


def test_write_read_roundtrip(data_dir):
    store.write("thing", {"a": 1, "b": ["x", "y"]})
    assert store.read("thing") == {"a": 1, "b": ["x", "y"]}


def test_read_missing_returns_default(data_dir):
    assert store.read("does_not_exist", {"fallback": True}) == {"fallback": True}
    assert store.read("also_missing") == {}


def test_json_suffix_optional(data_dir):
    store.write("noext", {"ok": 1})
    assert (data_dir / "noext.json").exists()
    assert store.read("noext.json") == {"ok": 1}


def test_mutate_persists_changes(data_dir):
    store.write("log", {"entries": []})
    with store.mutate("log") as d:
        d["entries"].append("first")
    assert store.read("log")["entries"] == ["first"]


def test_write_text_file_roundtrip(data_dir):
    path = data_dir / "note.md"
    store.write_text_file(path, "# hello\n\n- [ ] thing\n")
    assert path.read_text() == "# hello\n\n- [ ] thing\n"


def test_write_text_file_creates_parent_dirs(data_dir):
    path = data_dir / "Journal" / "Daily" / "2026-07-24.md"
    store.write_text_file(path, "a day")
    assert path.read_text() == "a day"


def test_write_text_file_overwrites_atomically_no_tmp_left(data_dir):
    path = data_dir / "note.md"
    store.write_text_file(path, "first")
    store.write_text_file(path, "second")
    assert path.read_text() == "second"
    # the temp file used for the atomic replace must not linger
    assert list(data_dir.glob("*.tmp")) == []


def test_write_text_file_leaves_original_intact_on_write_error(data_dir):
    path = data_dir / "note.md"
    store.write_text_file(path, "original")
    # a non-string content raises inside the with-block, after mkstemp — the
    # existing file must survive untouched and no temp file may be left behind.
    with pytest.raises(TypeError):
        store.write_text_file(path, 12345)  # f.write(int) → TypeError
    assert path.read_text() == "original"
    assert list(data_dir.glob("*.tmp")) == []


def test_mutate_does_not_write_on_exception(data_dir):
    store.write("log", {"entries": ["keep"]})
    with pytest.raises(ValueError):
        with store.mutate("log") as d:
            d["entries"].append("doomed")
            raise ValueError("boom")
    # The failed mutation left the original file untouched.
    assert store.read("log")["entries"] == ["keep"]


# --- the unchanged-write guard -------------------------------------------------
# A mutate block that changes nothing writes nothing. Pollers open a mutate just
# to look (the run dispatcher checks the queue every tick), and before this guard
# each of those looks rewrote the whole file with byte-identical content —
# measured at 2,756 of the dispatcher's 2,796 queue writes over 23 hours.

def test_mutate_that_changes_nothing_does_not_touch_the_file(data_dir):
    store.write("queue", {"runs": [{"id": "a", "status": "running"}]})
    path = data_dir / "queue.json"
    before_mtime = path.stat().st_mtime_ns

    with store.mutate("queue") as d:
        # A poller LOOKING at the queue and finding nothing to settle.
        [r for r in d["runs"] if r["status"] == "running"]

    assert path.stat().st_mtime_ns == before_mtime, "no-op mutate rewrote the file"
    assert store.read("queue")["runs"][0]["status"] == "running"


def test_mutate_still_writes_when_something_actually_changes(data_dir):
    store.write("queue", {"runs": [{"id": "a", "status": "running"}]})
    with store.mutate("queue") as d:
        d["runs"][0]["status"] = "done"
    assert store.read("queue")["runs"][0]["status"] == "done"


def test_mutate_detects_a_nested_change_not_just_a_top_level_one(data_dir):
    """The guard compares by value, all the way down — a change buried in a
    nested dict must still count as a change."""
    store.write("deep", {"a": {"b": {"c": [1, 2, 3]}}})
    with store.mutate("deep") as d:
        d["a"]["b"]["c"].append(4)
    assert store.read("deep")["a"]["b"]["c"] == [1, 2, 3, 4]


def test_a_skipped_write_is_not_counted_as_a_write(data_dir, monkeypatch):
    """The op counters feed the usage page and the creek's traffic map, so a
    write that didn't happen must not be reported as one — that would put the
    exact fiction back that the traffic map exists to remove."""
    store.write("queue", {"runs": []})
    counted = []
    monkeypatch.setattr(store, "_stats_count", lambda n, k: counted.append((n, k)))

    with store.mutate("queue") as d:
        d.get("runs")
    assert counted == [], "a no-op mutate was counted as a write"

    with store.mutate("queue") as d:
        d["runs"].append({"id": "x"})
    assert ("queue", "writes") in counted


def test_guard_fails_open_and_writes_when_the_before_copy_fails(data_dir, monkeypatch):
    """It may never skip a write it isn't certain is redundant: if the
    before-image can't be taken, it writes exactly as it did before."""
    store.write("queue", {"runs": []})
    monkeypatch.setattr(store, "_writelog_snapshot_copy", lambda data: (None, False))
    path = data_dir / "queue.json"
    before_mtime = path.stat().st_mtime_ns

    with store.mutate("queue") as d:
        d.get("runs")  # changes nothing, but the guard can't prove it

    assert path.stat().st_mtime_ns != before_mtime, "guard skipped a write it couldn't verify"


def test_a_no_op_mutate_writes_no_journal_entry(data_dir, monkeypatch):
    """The journal is a record of what changed; 23% of its rows recording
    nothing was the other half of this waste. The suite runs with capture off
    (see conftest), so this one turns it back on the way test_writelog.py
    does — the guard itself is exercised in BOTH states, since every other
    test here runs with the journal off."""
    monkeypatch.setenv("EXOCORTEX_WRITE_LOG_OFF", "0")
    import writelog
    store.write("queue", {"runs": []})
    before = len(writelog.recent(collection="queue", limit=500))

    with store.mutate("queue") as d:
        d.get("runs")
    assert len(writelog.recent(collection="queue", limit=500)) == before

    with store.mutate("queue") as d:
        d["runs"].append({"id": "y"})
    assert len(writelog.recent(collection="queue", limit=500)) == before + 1


def test_a_no_op_mutate_still_materializes_a_missing_file(data_dir):
    """The one thing the redundant writes were quietly doing: a no-op mutate
    against a collection that doesn't exist yet used to create it with its
    default. Something that only ever polls — the dispatcher against an empty
    queue — is exactly what would otherwise leave the file absent forever, so
    the guard preserves this. It costs one write per collection, ever."""
    path = data_dir / "fresh.json"
    assert not path.exists()

    with store.mutate("fresh", {"runs": []}) as d:
        d.get("runs")  # changes nothing

    assert path.exists(), "a missing collection was never materialized"
    assert store.read("fresh") == {"runs": []}

    # ...and the SECOND no-op, now that the file is there, writes nothing.
    before_mtime = path.stat().st_mtime_ns
    with store.mutate("fresh", {"runs": []}) as d:
        d.get("runs")
    assert path.stat().st_mtime_ns == before_mtime
