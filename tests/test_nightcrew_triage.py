"""Tests for the night crew's eligibility gate (tools/nightcrew/triage.py).

Plain English: the gate decides which dev notes overnight agents may attempt.
If it silently widens, an unsupervised agent gets handed work it can't finish
or can't verify — so every rejection class gets a test, and the real note text
that motivated each rule is used as the fixture rather than invented strings.

Named for the behavior, one assertion of intent each, per the repo's testing
conventions. No `data_dir` fixture: triage is pure logic over dicts and never
touches the store.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.nightcrew import triage  # noqa: E402


def note(text, night=True, nid="n1"):
    """A dev note in dev_notes.json's shape. Green-lit by default, since most
    tests are about lock 2 (the text rules), not lock 1 (her tap)."""
    return {"id": nid, "text": text, "night": night}


# --- lock 1: her green-light ------------------------------------------------

def test_unflagged_note_is_never_eligible():
    ok, reason = triage.check(note("Add a search for to-dos", night=False))
    assert ok is False
    assert reason == "not green-lit"


def test_flagged_simple_note_passes():
    ok, reason = triage.check(note("Add a search for to-dos"))
    assert ok is True
    assert reason == ""


def test_missing_night_key_is_treated_as_unflagged():
    ok, _ = triage.check({"id": "x", "text": "Re add edit button to habits"})
    assert ok is False


def test_night_must_be_true_not_truthy():
    """A stray "yes"/1 in the JSON must not open the gate — the flag is written
    by one button and anything else means the data drifted."""
    ok, _ = triage.check({"id": "x", "text": "Add a search", "night": "yes"})
    assert ok is False


# --- lock 2: the text rules, each keyed to a real note ----------------------

def test_hedge_word_rejects_underspecified_note():
    # terminal/b1a6b03d — "not sure if this is possible"
    ok, reason = triage.check(note(
        "make the scroll functionality feel more native, not the buggy slow "
        "version. not sure if this is possible"))
    assert ok is False
    assert "not sure" in reason


def test_figure_out_is_a_hedge():
    ok, reason = triage.check(note("figure out what to do with the done tasks"))
    assert ok is False
    assert "figure out" in reason


def test_device_bound_note_is_rejected():
    # kitchen/ab0c0b9c — the crew's Playwright run can't reach the installed PWA
    ok, reason = triage.check(note(
        "Fix the PWA version of recipe editing. The sections are all messed up"))
    assert ok is False
    assert "device-bound" in reason


def test_ios_keyboard_note_is_rejected():
    ok, reason = triage.check(note(
        "when i clicked done on one of the to-dos, it made a huge empty block "
        "come up from the bottom on ios"))
    assert ok is False
    assert "device-bound" in reason


def test_structural_note_is_rejected():
    # today/7d223555 — the "dependent on" feature is a data-model change
    ok, reason = triage.check(note(
        'add a "dependent on" feature where to-do items are dependent on others'))
    assert ok is False
    assert "structural" in reason


def test_already_done_marker_is_rejected_and_reported_as_such():
    # today/9e7ee56f carries its own fix annotation
    ok, reason = triage.check(note(
        "when i clicked done it made an empty block [fix 1, 2026-07-09: scroll snap]"))
    assert ok is False
    assert "already done" in reason


def test_done_marker_outranks_other_rejections():
    """A note that is both already-done and hedged reports already-done, since
    that's the one that changes what she does with it (retire, not rewrite)."""
    ok, reason = triage.check(note("maybe fix the thing [fix 1, 2026-07-09: done]"))
    assert "already done" in reason


def test_long_note_is_rejected_as_a_spec():
    ok, reason = triage.check(note("Move the entry form to the top. " + "x" * 260))
    assert ok is False
    assert "too long" in reason


def test_feature_request_is_rejected_even_when_confidently_worded():
    """The hedge list only catches notes that SOUND unsure. A feature can be
    short and certain ("Consider integrated mood tracker") — the first real
    run let 54% of notes through, mostly on this shape."""
    ok, reason = triage.check(note(
        "Consider integrated mood tracker like the mood app Georgia uses"))
    assert ok is False
    assert "a feature, not a fix" in reason


def test_a_way_to_is_a_feature():
    ok, reason = triage.check(note(
        "the people files are not accurate. need to find a way to make them "
        "more factual only"))
    assert ok is False
    assert "a feature, not a fix" in reason


def test_caret_continuation_is_rejected():
    # global/ea1b4440 — half a thought; the other half is the note above it
    ok, reason = triage.check(note("^until I fix my daytime color runway"))
    assert ok is False
    assert "continuation" in reason


def test_bare_reminder_is_too_short():
    # observatory/87e3a902 is literally the word "Soil"
    ok, reason = triage.check(note("Soil"))
    assert ok is False
    assert "too short" in reason


def test_the_shortest_real_diet_note_still_passes():
    """Pins the MIN_CHARS floor against the shortest note the crew must keep.
    If this fails, the floor got greedy — lower it, don't delete the test."""
    ok, reason = triage.check(note("Add a search for to-dos"))
    assert ok is True, reason


def test_enumerated_note_is_rejected_as_compound():
    # kitchen/ec722d11 — three asks in one body
    ok, reason = triage.check(note(
        "Foods section: (1) log foods that bother me. (2) plan a list to try. "
        "(3) a UI to isolate triggers"))
    assert ok is False
    assert "several asks" in reason


def test_a_single_parenthetical_one_is_not_compound():
    """Only (2)/(3) mark enumeration — a lone "(1)" is prose, and rejecting it
    would quietly eat legitimate notes."""
    ok, _ = triage.check(note("fix the copy button (1px off) so the text fits"))
    assert ok is True


def test_empty_note_is_rejected():
    ok, reason = triage.check(note("   "))
    assert ok is False
    assert reason == "empty note"


def test_non_dict_is_rejected_without_raising():
    ok, _ = triage.check("not a note")
    assert ok is False


@pytest.mark.parametrize("text", [
    "Add a search for to-dos",
    "Re add edit button to habits",
    "make the now section always display all with no filtering",
    "Move the entry form for items to the top of this page",
    "Remove the tags showing the focus/category on all of the to-dos",
])
def test_real_class_one_notes_all_pass(text):
    """The mechanical UI notes are the crew's whole diet — if a filter change
    starts eating these, the crew has nothing to do and this test says so."""
    ok, reason = triage.check(note(text))
    assert ok is True, f"{text!r} rejected: {reason}"


# --- the whole-file pass ----------------------------------------------------

def test_triage_splits_eligible_from_rejected():
    result = triage.triage({
        "today": [note("Add a search for to-dos", nid="a"),
                  note("maybe do the thing", nid="b")],
    })
    assert [r["id"] for r in result["eligible"]] == ["a"]
    assert [r["id"] for r in result["rejected"]] == ["b"]


def test_triage_carries_tab_and_reason_through():
    result = triage.triage({"kitchen": [note("maybe do the thing", nid="b")]})
    row = result["rejected"][0]
    assert row["tab"] == "kitchen"
    assert "maybe" in row["reason"]


def test_unflagged_notes_are_not_listed_as_rejections():
    """Almost every note is unflagged; listing them would bury the handful she
    actually green-lit and got turned down."""
    result = triage.triage({
        "today": [note("some note", night=False), note("maybe x", nid="b")],
    })
    assert len(result["rejected"]) == 1
    assert result["rejected"][0]["id"] == "b"


def test_triage_tolerates_empty_and_missing_tabs():
    assert triage.triage({}) == {"eligible": [], "rejected": []}
    assert triage.triage({"money": []}) == {"eligible": [], "rejected": []}
    assert triage.triage(None) == {"eligible": [], "rejected": []}
