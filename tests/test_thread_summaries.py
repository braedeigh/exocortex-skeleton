"""Thread summaries — the stack of short summaries kept beside each thread.

These go through the door a session really uses (`scripts/thread_summary.py`)
against a small made-up vault, and read the result back through the store.
The night pass's own writing is covered in test_thread_tending.py.
"""
import importlib.util
import json
from pathlib import Path

import pytest

import sqlstore
import store
import threadsummaries

_spec = importlib.util.spec_from_file_location(
    "thread_summary", Path(__file__).resolve().parents[1] / "scripts" / "thread_summary.py")
door = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(door)


@pytest.fixture
def vault(data_dir, tmp_path, monkeypatch):
    content = tmp_path / "content"
    (content / "Threads").mkdir(parents=True)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    (content / "Threads" / "garden.md").write_text(
        "---\nname: Garden\naliases: []\nfronts: [health]\nstatus: active\n---\n")
    return content


def add(*extra, slug="garden", author="keeper", body="The beans are in."):
    return door.main(["add", "--slug", slug, "--author", author, "--body", body, *extra])


def test_each_summary_lands_on_top_and_the_older_ones_stay_as_written(vault):
    assert add("--based-on", "2026-03-08", "2026-03-10.0900b", "--written-at", "2026-03-10T21:00:00") == 0
    assert add(author="cricket:thread-helper", body="The beans sprouted.",
               *["--written-at", "2026-03-11T02:00:00"]) == 0
    stack = threadsummaries.for_thread("garden")
    assert [(row["author"], row["body"]) for row in stack] == [
        ("cricket:thread-helper", "The beans sprouted."), ("keeper", "The beans are in.")]
    assert stack[1]["based_on"] == ["2026-03-08", "2026-03-10.0900b"]
    # Saying the same thing again does not grow the stack.
    assert add(author="cricket:thread-helper", body="The beans sprouted.") == 0
    assert len(threadsummaries.for_thread("garden")) == 2


def test_the_door_refuses_what_does_not_belong_in_the_stack(vault, capsys):
    too_long = "word " * (threadsummaries.MAX_WORDS + 1)
    assert add(body=too_long) == 2
    assert add(slug="no-such-thread") == 2
    assert add(author="someone") == 2
    assert add("--based-on", "last tuesday") == 2
    assert threadsummaries.for_thread("garden") == []
    assert "at most 120 words" in capsys.readouterr().err


def test_the_database_itself_refuses_to_rewrite_a_summary(vault):
    add()
    conn = sqlstore.open_db()
    try:
        with pytest.raises(Exception, match="never rewritten"):
            conn.execute("UPDATE thread_summaries SET body = 'something else'")
    finally:
        conn.close()
    assert threadsummaries.for_thread("garden")[0]["body"] == "The beans are in."


def test_importing_the_old_nights_adds_each_once_and_skips_trial_runs(vault):
    def night(day, applied, summary):
        folder = store.DATA_DIR / "thread_tending" / day
        folder.mkdir(parents=True)
        (folder / "outcome.json").write_text(json.dumps({
            "target": day, "applied": applied, "movement": [
                {"slug": "garden", "summary": summary,
                 "movement": [{"text": "x", "sources": [f"{day}.0900b"]}]},
                {"slug": "gone-thread", "summary": "Its file was removed.", "movement": []}]}))
    night("2026-03-09", False, "A trial run.")
    night("2026-03-10", True, "Beans in.")
    night("2026-03-11", True, "Beans up.")
    assert door.main(["import-nights"]) == 0
    assert door.main(["import-nights"]) == 0
    stack = threadsummaries.for_thread("garden")
    assert [(row["written_at"][:10], row["body"]) for row in stack] == [
        ("2026-03-11", "Beans up."), ("2026-03-10", "Beans in.")]
    assert stack[0]["based_on"] == ["2026-03-11.0900b"]
