"""Tests for the night crew's self-queuing (tools/nightcrew/nominate.py).

Plain English: the nominator picks which never-answered dev notes the crew
lights for itself, oldest first. The two behaviors that must never drift are
the veto (a note carrying ANY `night` answer — true or false — is never
proposed) and the ordering (oldest first, because the point is working the
backlog down). Pure logic over dicts, no `data_dir` fixture, same as the
triage tests.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import devnote_judgments  # noqa: E402
from tools.nightcrew import nominate  # noqa: E402


def note(text, nid, created="2026-06-01 12:00", night=None, **extra):
    """`night=True/False` is kept as the parameter these tests read as; it
    builds the judgment record that replaced the boolean. True -> approved
    (already lit), False -> unsure (her "not this" from the morning card).
    Both are ANSWERS, and the nominator never re-proposes an answered note."""
    n = {"id": nid, "text": text, "created": created, **extra}
    if night is not None:
        devnote_judgments.append(n, "approved" if night else "unsure")
    return n


def picked_ids(tabs, count=3):
    return [n["id"] for n in nominate.nominate(tabs, count)]


def test_oldest_note_is_picked_first():
    tabs = {"today": [
        note("Re add edit button to habits", "new", created="2026-07-23 08:02"),
        note("Add a search for to-dos", "old", created="2026-05-01 09:00"),
    ]}
    assert picked_ids(tabs, count=1) == ["old"]


def test_ordering_is_oldest_first_across_tabs():
    tabs = {
        "journal": [note("Add a copy button to all of these", "mid",
                         created="2026-06-15 10:00")],
        "today": [note("Add a search for to-dos", "old", created="2026-05-01 09:00"),
                  note("Re add edit button to habits", "new", created="2026-07-23 08:02")],
    }
    assert picked_ids(tabs) == ["old", "mid", "new"]


def test_her_no_is_a_permanent_veto():
    """`night: false` is her un-moon. Proposing it again is the pestering
    failure mode the whole record exists to prevent — one no is forever."""
    tabs = {"today": [note("Add a search for to-dos", "vetoed", night=False)]}
    assert picked_ids(tabs) == []


def test_already_lit_note_is_not_renominated():
    tabs = {"today": [note("Add a search for to-dos", "lit", night=True)]}
    assert picked_ids(tabs) == []


def test_gate_failing_note_is_not_nominated():
    """Nomination defers to triage entirely — a hedged note is no more eligible
    for self-queuing than it would be under her tap."""
    tabs = {"today": [note("maybe add a search for to-dos", "hedged")]}
    assert picked_ids(tabs) == []


def test_count_caps_the_pick():
    tabs = {"today": [
        note("Add a search for to-dos", "a", created="2026-05-01 09:00"),
        note("Re add edit button to habits", "b", created="2026-05-02 09:00"),
        note("Move the entry form to the top", "c", created="2026-05-03 09:00"),
    ]}
    assert picked_ids(tabs, count=2) == ["a", "b"]


def test_zero_or_negative_count_picks_nothing():
    tabs = {"today": [note("Add a search for to-dos", "a")]}
    assert nominate.nominate(tabs, 0) == []
    assert nominate.nominate(tabs, -1) == []


def test_undated_note_reads_as_oldest():
    tabs = {"today": [
        note("Add a search for to-dos", "dated", created="2026-05-01 09:00"),
        note("Re add edit button to habits", "undated", created=""),
    ]}
    assert picked_ids(tabs, count=1) == ["undated"]


def test_tolerates_empty_and_missing_tabs():
    assert nominate.nominate({}, 3) == []
    assert nominate.nominate({"money": []}, 3) == []
    assert nominate.nominate(None, 3) == []
