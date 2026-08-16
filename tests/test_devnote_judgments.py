"""The dev-note judgment record — the append-only list that replaced `night`.

The guarantees worth pinning: the current verdict is DERIVED from the list (so
it can never disagree with it), a denial can't exist without a reason, editing
reopens an `unsure` but never a `denied`, and a malformed record degrades to
"no judgments" instead of raising — because this runs over every note in the
browser and one bad entry must not blank the page.
"""
import pytest

import devnote_judgments as dj


def note(*judgments):
    return {"id": "n1", "text": "a note", "judgments": list(judgments)}


# ── the derived current verdict ─────────────────────────────────────────────

def test_a_note_with_no_judgments_reads_as_open():
    assert dj.current({"id": "n1", "text": "x"}) == "open"
    assert dj.current(note()) == "open"


def test_current_is_the_last_entry_not_the_first():
    n = note(dj.make("unsure"), dj.make("approved"))
    assert dj.current(n) == "approved"


def test_history_survives_a_malformed_record():
    # A hand-edited file, a half-written entry, a stray string in the list.
    n = {"judgments": ["garbage", {"no_verdict": 1}, {"verdict": "nonsense"},
                       dj.make("denied", reason="outdated")]}
    assert len(dj.history(n)) == 1
    assert dj.current(n) == "denied"


def test_a_non_list_judgments_field_reads_as_empty():
    assert dj.current({"judgments": "approved"}) == "open"
    assert dj.history({"judgments": None}) == []


# ── the two questions the night crew asks ───────────────────────────────────

def test_green_lit_only_when_the_latest_verdict_is_approved():
    assert dj.is_green_lit(note(dj.make("approved"))) is True
    assert dj.is_green_lit(note(dj.make("approved"), dj.make("open"))) is False
    assert dj.is_green_lit(note(dj.make("unsure"))) is False


def test_answered_covers_every_verdict_except_open():
    for v in ("approved", "unsure", "denied"):
        reason = "outdated" if v == "denied" else ""
        assert dj.is_answered(note(dj.make(v, reason=reason))) is True
    assert dj.is_answered(note()) is False
    assert dj.is_answered(note(dj.make("unsure"), dj.make("open"))) is False


# ── validation: the closed vocabularies ─────────────────────────────────────

def test_a_denial_requires_one_of_the_two_reasons():
    assert dj.validate("denied") != []
    assert dj.validate("denied", reason="because i said so") != []
    assert dj.validate("denied", reason="outdated") == []
    assert dj.validate("denied", reason="completed") == []


def test_only_a_denial_carries_a_reason():
    assert dj.validate("approved", reason="completed") != []
    assert dj.validate("unsure", reason="outdated") != []


def test_unknown_verdicts_are_refused():
    assert dj.validate("rejected") != []
    assert dj.validate("") != []


def test_append_raises_rather_than_recording_a_malformed_judgment():
    n = note()
    with pytest.raises(ValueError):
        dj.append(n, "denied")            # no reason
    with pytest.raises(ValueError):
        dj.append(n, "maybe")             # not a verdict
    assert n["judgments"] == []           # nothing partial got written


# ── accumulation: the whole point of the list ───────────────────────────────

def test_judging_twice_keeps_both_rulings():
    n = note()
    dj.append(n, "unsure", text="can't tell what this meant")
    dj.append(n, "approved", text="oh — the kitchen categories")
    assert [j["verdict"] for j in dj.history(n)] == ["unsure", "approved"]
    assert dj.history(n)[0]["note"] == "can't tell what this meant"


def test_an_approval_can_carry_a_note_or_not():
    n = note()
    dj.append(n, "approved")
    dj.append(n, "approved", text="but narrower than written")
    assert "note" not in dj.history(n)[0]
    assert dj.history(n)[1]["note"] == "but narrower than written"


# ── reopen-on-edit ──────────────────────────────────────────────────────────

def test_editing_an_unsure_note_reopens_it():
    n = note(dj.make("unsure", text="what did I mean"))
    entry = dj.reopen_on_edit(n)
    assert entry is not None
    assert dj.current(n) == "open"
    assert entry["by"] == "edit"          # attributable, not disguised as her tap


def test_editing_does_not_resurrect_a_denial():
    # She said no on purpose. A typo fix must not quietly undo that.
    n = note(dj.make("denied", reason="completed"))
    assert dj.reopen_on_edit(n) is None
    assert dj.current(n) == "denied"


def test_editing_an_approved_note_leaves_the_green_light_alone():
    n = note(dj.make("approved"))
    assert dj.reopen_on_edit(n) is None
    assert dj.is_green_lit(n) is True


def test_editing_an_unjudged_note_records_nothing():
    n = note()
    assert dj.reopen_on_edit(n) is None
    assert dj.history(n) == []


# ── the by-page breakdown ───────────────────────────────────────────────────

def test_counts_by_tab_tallies_each_page_and_an_all_row():
    by_tab = {
        "journal": [note(dj.make("approved")), note(dj.make("denied", reason="outdated")), note()],
        "kitchen": [note(dj.make("unsure"))],
        "money": [],
    }
    out = dj.counts_by_tab(by_tab)
    assert out["tabs"]["journal"] == {"approved": 1, "denied": 1, "unsure": 0, "open": 1, "total": 3}
    assert out["tabs"]["kitchen"]["unsure"] == 1
    assert "money" not in out["tabs"]      # an empty page is not a row of zeros
    assert out["all"]["total"] == 4
    assert out["all"]["approved"] == 1
