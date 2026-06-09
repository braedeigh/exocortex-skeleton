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


def test_mutate_does_not_write_on_exception(data_dir):
    store.write("log", {"entries": ["keep"]})
    with pytest.raises(ValueError):
        with store.mutate("log") as d:
            d["entries"].append("doomed")
            raise ValueError("boom")
    # The failed mutation left the original file untouched.
    assert store.read("log")["entries"] == ["keep"]
