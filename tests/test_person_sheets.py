"""Person sheets — the stack of short current-facts sheets kept for each person.

These go through the door a session really uses (`scripts/person_sheet.py`)
against a small made-up vault, and read the result back through the store.
"""
import importlib.util
from pathlib import Path

import pytest

import personsheets
import sqlstore
import store

_spec = importlib.util.spec_from_file_location(
    "person_sheet", Path(__file__).resolve().parents[1] / "scripts" / "person_sheet.py")
door = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(door)

SHEET = ("Who: A neighbour who lends tools.\nPronouns: not on record\n"
         "Tied to: The street garden.\nNow: Away until spring.\nLast contact: 2026-03-08")
NEWER = SHEET.replace("Away until spring.", "Back from travel.")


@pytest.fixture
def vault(data_dir, tmp_path, monkeypatch):
    content = tmp_path / "content"
    (content / "people").mkdir(parents=True)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    (content / "people" / "pat-example.md").write_text("---\nname: Pat Example\n---\n")
    return content


def add(*extra, slug="pat-example", author="cricket:housekeep", body=SHEET):
    return door.main(["add", "--slug", slug, "--author", author, "--body", body, *extra])


def test_each_sheet_lands_on_top_and_the_older_ones_stay_as_written(vault):
    assert add("--based-on", "2026-03-08", "2026-03-10.0900b", "--written-at", "2026-03-10T21:00:00") == 0
    # Blank lines between the five lines are dropped.
    assert add("--written-at", "2026-03-11T02:00:00",
               author="cricket:other", body=NEWER.replace("\n", "\n\n")) == 0
    stack = personsheets.for_person("pat-example")
    assert [(row["author"], row["body"]) for row in stack] == [
        ("cricket:other", NEWER), ("cricket:housekeep", SHEET)]
    assert stack[1]["based_on"] == ["2026-03-08", "2026-03-10.0900b"]
    assert personsheets.newest("pat-example")["body"] == NEWER
    # Saying the same thing again does not grow the stack.
    assert add(body=NEWER) == 0
    assert len(personsheets.for_person("pat-example")) == 2


def test_the_door_refuses_what_does_not_belong_in_the_stack(vault, capsys):
    too_long = SHEET.replace("A neighbour", "word " * personsheets.MAX_WORDS)
    assert add(body=too_long) == 2
    assert "at most 100 words" in capsys.readouterr().err
    assert add(slug="no-such-person") == 2
    assert add(author="someone") == 2
    assert add(author="keeper") == 2            # the Keeper does not write sheets
    assert add("--based-on", "last tuesday") == 2
    assert add(body=SHEET.replace("Now: ", "Currently: ")) == 2
    assert add(body="\n".join(SHEET.splitlines()[:4])) == 2
    assert personsheets.for_person("pat-example") == []


def test_the_database_itself_refuses_to_rewrite_a_sheet(vault):
    add()
    conn = sqlstore.open_db()
    try:
        with pytest.raises(Exception, match="never rewritten"):
            conn.execute("UPDATE person_sheets SET body = 'something else'")
    finally:
        conn.close()
    assert personsheets.for_person("pat-example")[0]["body"] == SHEET
