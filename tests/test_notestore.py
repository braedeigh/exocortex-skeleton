"""Notes as rows, and the document they come back as (notestore.py).

These tables are the first in exo.db that are the DESTINATION rather than a
report rebuilt from a blob, so the thing worth testing is not "does a write
land" but "does anything get lost on the way through". Every test here is a
round trip: a document goes in, rows come out, a document comes back, and the
two are compared as bytes wherever key order is part of the answer.

What's checked:
  - a document survives the trip exactly, judgments and key order included
  - the two agreed losses, and ONLY those two: an empty page disappears and
    pages come back alphabetical
  - list order survives even where `created` cannot supply it — two notes in
    the same minute (the case that earned the `position` column)
  - a key with no column of its own rides along in `extra` instead of being
    dropped
  - `updated_at` moves for the note that changed and for no other
  - deleting a note takes its judgments with it, by the foreign key
  - the same id can be a dev note and an idea note at once (the undo overlap
    routes/devnotes.py really produces), and moving a kind keeps id + created
  - the mirror file is written from the rows, and an exception inside mutate()
    writes nothing at all

The real proof that the live data survives is not here and cannot be: her notes
are personal and this repo is shareable. That check was run once against the
real files — export byte-identical to the original once empty pages are dropped
and pages sorted — and these tests are the standing version of the same
question, asked with invented notes.
"""
import json

import pytest

import notestore
import store


def _doc(tabs):
    return {"tabs": tabs}


def _note(nid, text, created="2026-01-01 09:00", **extra):
    note = {"id": nid, "text": text, "created": created}
    note.update(extra)
    return note


def test_document_survives_the_round_trip(data_dir):
    doc = _doc({
        "kitchen": [_note("a1", "one"), _note("a2", "two")],
        "today": [_note("b1", "three")],
    })
    notestore.put("dev_notes", doc)
    assert notestore.get("dev_notes") == doc


def test_key_order_inside_a_note_is_reproduced(data_dir):
    """Key order is what the JSON file shows, so it is part of the answer —
    a reordered file is a diff the owner has to read for no reason."""
    doc = _doc({"kitchen": [
        _note("a1", "one", judgments=[{"verdict": "approved", "at": "2026-01-02 10:00",
                                       "by": "her", "note": "yes"}],
              night_questions="which one did you mean?"),
    ]})
    notestore.put("dev_notes", doc)
    back = notestore.get("dev_notes")
    assert list(back["tabs"]["kitchen"][0]) == [
        "id", "text", "created", "judgments", "night_questions"]
    assert list(back["tabs"]["kitchen"][0]["judgments"][0]) == [
        "verdict", "at", "by", "note"]


def test_a_judgment_keeps_every_field(data_dir):
    doc = _doc({"kitchen": [_note("a1", "one", judgments=[
        {"verdict": "approved", "at": "2026-01-02 10:00", "by": "her"},
        {"verdict": "denied", "at": "2026-01-03 10:00", "by": "her",
         "note": "changed my mind", "reason": "outdated"},
    ])]})
    notestore.put("dev_notes", doc)
    assert notestore.get("dev_notes") == doc


def test_empty_pages_are_dropped_and_pages_come_back_sorted(data_dir):
    """The two agreed losses, stated as a test so neither can grow quietly."""
    doc = _doc({"today": [_note("a1", "one")], "money": [], "kitchen": [_note("a2", "two")]})
    notestore.put("dev_notes", doc)
    back = notestore.get("dev_notes")
    assert list(back["tabs"]) == ["kitchen", "today"]


def test_order_survives_two_notes_in_the_same_minute(data_dir):
    """The case `created` cannot answer, and the reason `position` exists: the
    second note here refers to the first one, so swapping them is not cosmetic."""
    doc = _doc({"global": [
        _note("a1", "change to light and dark only", created="2026-05-31 21:42"),
        _note("a2", "^until I fix the daytime runway", created="2026-05-31 21:42"),
    ]})
    notestore.put("dev_notes", doc)
    assert [n["id"] for n in notestore.get("dev_notes")["tabs"]["global"]] == ["a1", "a2"]


def test_a_key_with_no_column_is_kept_not_dropped(data_dir):
    """A blob took any shape for free. Dropping a field a later feature adds
    would be data loss that nothing announces, so it rides in `extra`."""
    doc = _doc({"kitchen": [_note("a1", "one", pinned=True, colour="blue")]})
    notestore.put("dev_notes", doc)
    back = notestore.get("dev_notes")["tabs"]["kitchen"][0]
    assert back["pinned"] is True and back["colour"] == "blue"


def test_updated_at_moves_only_for_the_note_that_changed(data_dir):
    """`updated_at` answers "when did this note last change". A write that
    restamped every row would make it say "just now" about everything."""
    notestore.put("dev_notes", _doc({"kitchen": [_note("a1", "one"), _note("a2", "two")]}))
    before = dict(_stamps())
    notestore.put("dev_notes", _doc({"kitchen": [_note("a1", "one EDITED"), _note("a2", "two")]}))
    after = dict(_stamps())
    assert after["a1"] != before["a1"]
    assert after["a2"] == before["a2"]


def _stamps():
    conn = notestore.sqlstore.open_db()
    try:
        return list(conn.execute("SELECT id, updated_at FROM notes"))
    finally:
        conn.close()


def test_deleting_a_note_takes_its_judgments_with_it(data_dir):
    notestore.put("dev_notes", _doc({"kitchen": [
        _note("a1", "one", judgments=[{"verdict": "approved", "at": "x", "by": "her"}]),
        _note("a2", "two"),
    ]}))
    notestore.put("dev_notes", _doc({"kitchen": [_note("a2", "two")]}))
    conn = notestore.sqlstore.open_db()
    try:
        assert conn.execute("SELECT COUNT(*) FROM note_judgments").fetchone()[0] == 0
    finally:
        conn.close()


def test_the_same_id_can_be_a_dev_note_and_an_idea_note(data_dir):
    """Undoing a send-to-ideas saves the dev document BEFORE removing the note
    from ideas (routes/devnotes.py), so for one write the id is genuinely both."""
    note = _note("a1", "one")
    notestore.put("idea_notes", _doc({"kitchen": [note]}))
    notestore.put("dev_notes", _doc({"kitchen": [note]}))
    assert notestore.get("dev_notes")["tabs"]["kitchen"][0]["id"] == "a1"
    assert notestore.get("idea_notes")["tabs"]["kitchen"][0]["id"] == "a1"


def test_moving_a_note_between_kinds_keeps_id_and_created(data_dir):
    note = _note("a1", "one", created="2026-02-03 11:00")
    notestore.put("dev_notes", _doc({"kitchen": [note]}))
    notestore.put("dev_notes", _doc({"kitchen": []}))
    notestore.put("idea_notes", _doc({"kitchen": [note]}))
    moved = notestore.get("idea_notes")["tabs"]["kitchen"][0]
    assert moved["id"] == "a1" and moved["created"] == "2026-02-03 11:00"


def test_the_mirror_file_is_written_from_the_rows(data_dir):
    """The file and a read go through the SAME function, so they cannot
    disagree — writing the mirror from the input would hide exactly that bug."""
    doc = _doc({"today": [_note("a1", "one")], "money": []})
    notestore.put("dev_notes", doc)
    mirror = json.loads((data_dir / "dev_notes.json").read_text())
    assert mirror == notestore.get("dev_notes")
    assert "money" not in mirror["tabs"]


def test_mutate_writes_the_whole_block_or_nothing(data_dir):
    notestore.put("dev_notes", _doc({"kitchen": [_note("a1", "one")]}))
    with pytest.raises(RuntimeError):
        with notestore.mutate("dev_notes") as data:
            data["tabs"]["kitchen"][0]["text"] = "clobbered"
            raise RuntimeError("boom")
    assert notestore.get("dev_notes")["tabs"]["kitchen"][0]["text"] == "one"


def test_mutate_persists_a_change(data_dir):
    notestore.put("dev_notes", _doc({"kitchen": [_note("a1", "one")]}))
    with notestore.mutate("dev_notes") as data:
        data["tabs"]["kitchen"][0]["text"] = "edited"
    assert notestore.get("dev_notes")["tabs"]["kitchen"][0]["text"] == "edited"
