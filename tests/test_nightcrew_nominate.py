"""Tests for the night crew's self-queuing (tools/nightcrew/nominate.py).

Plain English: the nominator picks which never-answered dev notes the crew
proposes or lights for itself: newest first, only from the last week. The
behaviors that must never drift are the veto (a note carrying ANY answer from
her is never proposed), the ordering (newest first, while she still remembers
what a note meant) and the window (old notes are a burn's job). Pure logic over
dicts, no `data_dir` fixture, same as the triage tests.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime  # noqa: E402

import devnote_judgments  # noqa: E402
from tools.nightcrew import nominate  # noqa: E402


def note(text, nid, created="2026-07-20 12:00", night=None, **extra):
    """`night=True/False` is kept as the parameter these tests read as; it
    builds the judgment record that replaced the boolean. True -> approved
    (already lit), False -> unsure (her "not this" from the morning card).
    Both are ANSWERS, and the nominator never re-proposes an answered note."""
    n = {"id": nid, "text": text, "created": created, **extra}
    if night is not None:
        devnote_judgments.append(n, "approved" if night else "unsure")
    return n


# Every test runs "on" this day, so the week's window is 2026-07-17 .. 07-24.
NOW = datetime(2026, 7, 24, 12, 0)


def picked_ids(tabs, count=3):
    return [n["id"] for n in nominate.nominate(tabs, count, now=NOW)]


def test_newest_note_is_picked_first():
    tabs = {"today": [
        note("Add a search for to-dos", "older", created="2026-07-18 09:00"),
        note("Re add edit button to habits", "newer", created="2026-07-23 08:02"),
    ]}
    assert picked_ids(tabs, count=1) == ["newer"]


def test_ordering_is_newest_first_across_tabs():
    tabs = {
        "journal": [note("Add a copy button to all of these", "mid",
                         created="2026-07-20 10:00")],
        "today": [note("Add a search for to-dos", "old", created="2026-07-18 09:00"),
                  note("Re add edit button to habits", "new", created="2026-07-23 08:02")],
    }
    assert picked_ids(tabs) == ["new", "mid", "old"]


def test_a_note_older_than_the_window_is_left_for_a_burn():
    """Oldest-first proved old notes lose their meaning: 4 of her 7 refusals
    were "I don't know what this refers to"."""
    tabs = {"today": [note("Add a search for to-dos", "stale", created="2026-07-10 09:00")]}
    assert picked_ids(tabs) == []


def test_her_no_is_a_permanent_veto():
    """An `unsure` is her "not this" from the morning card. Proposing it again is the pestering
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
        note("Add a search for to-dos", "a", created="2026-07-21 09:00"),
        note("Re add edit button to habits", "b", created="2026-07-22 09:00"),
        note("Move the entry form to the top", "c", created="2026-07-23 09:00"),
    ]}
    assert picked_ids(tabs, count=2) == ["c", "b"]


def test_zero_or_negative_count_picks_nothing():
    tabs = {"today": [note("Add a search for to-dos", "a")]}
    assert nominate.nominate(tabs, 0) == []
    assert nominate.nominate(tabs, -1) == []


def test_an_undated_note_is_outside_the_window():
    tabs = {"today": [note("Re add edit button to habits", "undated", created="")]}
    assert picked_ids(tabs) == []


def test_tolerates_empty_and_missing_tabs():
    assert nominate.nominate({}, 3) == []
    assert nominate.nominate({"money": []}, 3) == []
    assert nominate.nominate(None, 3) == []
