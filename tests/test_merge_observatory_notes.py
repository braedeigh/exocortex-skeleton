"""The observatory → terminal notes merge (scripts/merge_observatory_notes.py).

A data migration over the owner's own words, so the things that could silently
go wrong are pinned here: a note lost, a note doubled, a field stripped, or the
list left out of date order. Runs against the `data_dir` tmp store, never real
data.
"""
import importlib.util
from pathlib import Path

import pytest

import store

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "merge_observatory_notes.py"


@pytest.fixture
def fold(data_dir):
    """Load the script as a module (scripts/ isn't a package). Its merge only
    runs under __main__, so importing it touches nothing."""
    spec = importlib.util.spec_from_file_location("merge_observatory_notes", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.fold_observatory_into_terminal


def _seed(observatory, terminal):
    store.write("dev_notes.json", {"tabs": {"observatory": observatory, "terminal": terminal, "today": [
        {"id": "keep", "text": "untouched", "created": "2026-01-01 09:00"}]}})


def _tabs():
    return store.read("dev_notes.json", {"tabs": {}})["tabs"]


def test_merge_moves_notes_into_date_order_and_empties_observatory(fold):
    _seed(observatory=[{"id": "b", "text": "middle", "created": "2026-02-02 10:00"}],
          terminal=[{"id": "a", "text": "first", "created": "2026-01-01 10:00"},
                    {"id": "c", "text": "last", "created": "2026-03-03 10:00"}])
    assert fold("dev_notes.json") == (1, 3)
    assert [n["id"] for n in _tabs()["terminal"]] == ["a", "b", "c"]
    # A page with no notes left isn't kept as an empty list — notes are rows
    # (notestore.py), so an emptied page simply isn't in the document.
    assert _tabs().get("observatory", []) == []


def test_merge_keeps_every_field_on_a_moved_note(fold):
    note = {"id": "b", "text": "lit", "created": "2026-02-02 10:00",
            "judgments": [{"verdict": "approved"}], "night_questions": "which one?"}
    _seed(observatory=[dict(note)], terminal=[])
    fold("dev_notes.json")
    assert _tabs()["terminal"] == [note]


def test_merge_twice_does_not_duplicate(fold):
    _seed(observatory=[{"id": "b", "text": "once", "created": "2026-02-02 10:00"}], terminal=[])
    fold("dev_notes.json")
    assert fold("dev_notes.json") == (0, 1)


def test_merge_drops_a_note_already_in_terminal(fold):
    same = {"id": "b", "text": "once", "created": "2026-02-02 10:00"}
    _seed(observatory=[dict(same)], terminal=[dict(same)])
    fold("dev_notes.json")
    assert [n["id"] for n in _tabs()["terminal"]] == ["b"]


def test_merge_leaves_other_tabs_alone(fold):
    _seed(observatory=[{"id": "b", "text": "x", "created": "2026-02-02 10:00"}], terminal=[])
    fold("dev_notes.json")
    assert [n["id"] for n in _tabs()["today"]] == ["keep"]


def test_merge_on_a_file_with_no_notes_yet_is_a_no_op(fold):
    assert fold("idea_notes.json") == (0, 0)
