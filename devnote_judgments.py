"""What she decided about a dev note, and when — the note's own judgment record.

Plain English: a dev note used to carry one boolean, `night`, which had to mean
three different things at once (lit for tonight / refused / never looked at).
That was too small to hold a real opinion, and it lived in the wrong place: her
verdicts were being written onto night-crew *run* records, so the note itself
never knew it had been judged. Twenty-three notes had a verdict recorded
somewhere and nothing on the note.

So a note now carries `judgments` — a list, appended to, never overwritten. The
note's current verdict is simply the last entry; there is no separate field for
it, because a stored summary of a list is a thing that can drift from the list.
Four verdicts:

  approved — she wants it; this is the green light the night crew runs on
  unsure   — she can't tell what the note meant. NOT a refusal: editing the
             note to add context appends `open` and it comes back around
  denied   — she doesn't want it, with a reason: `outdated` or `completed`.
             These are the ones a later sweep may delete
  open     — never judged, or reopened. The absence of judgments means this too

Why append-only: she judges a note, sends it back to herself with a question,
and judges it again. Keeping only the latest answer would throw away the fact
that she changed her mind — which is exactly the material for seeing whether the
crew's picking is getting better.

Touches: routes/devnotes.py (the judge + edit doors), tools/nightcrew/triage.py
(lock 1 reads the green light here), tools/nightcrew/nominate.py (what it may
propose), routes/nightcrew.py (the morning card writes here too, so there is one
judgment store instead of two), tests/test_devnote_judgments.py.

Prompt that produced this: "I want to be able to click in there and be able to
see what notes I have modified/judged and what my judgement of them was ...
'approve' with or without a note, 'unsure, need more context', and 'denied' with
the reason being 'outdated' or 'completed' ... I want the notes to accumulate
these as well."
"""
from datetime import datetime

# The whole vocabulary. `open` is a real verdict (a reopening is an event worth
# recording) but it is also what an unjudged note reads as, so it never needs to
# be written just to establish a starting state.
VERDICTS = ("approved", "unsure", "denied", "open")

# Only a denial carries a reason, and only these two. A closed vocabulary is
# what makes denials countable — the whole point of recording them is to see how
# many of her notes died of rot versus of being already done.
DENIED_REASONS = ("outdated", "completed")

# The verdicts that mean "she has answered this" — the crew must not re-propose
# a note in any of them. `unsure` counts: it stops being unsure when she edits
# the note, which appends `open` and makes it proposable again.
ANSWERED = ("approved", "unsure", "denied")


def history(note):
    """Every judgment on this note, oldest first. Tolerant: a malformed or
    missing list reads as no judgments rather than raising, because this is
    called on every note in the browser and one bad record must not blank the
    page."""
    raw = (note or {}).get("judgments")
    if not isinstance(raw, list):
        return []
    return [j for j in raw if isinstance(j, dict) and j.get("verdict") in VERDICTS]


def current(note):
    """The note's verdict right now — the last entry, or `open` if there are
    none. Derived, never stored: a summary field beside the list is a second
    source of truth that can disagree with it."""
    h = history(note)
    return h[-1]["verdict"] if h else "open"


def is_green_lit(note):
    """Does the night crew have permission to WORK this note? Replaces the old
    `night: true`."""
    return current(note) == "approved"


def is_answered(note):
    """Has she ruled on this at all? Replaces the old "is the `night` key
    present" test, which was doing this job invisibly."""
    return current(note) in ANSWERED


def validate(verdict, reason="", text=""):
    """Errors with what's wrong, in the words the caller shows her. Empty list
    means the judgment is well-formed."""
    errors = []
    if verdict not in VERDICTS:
        errors.append(f"verdict must be one of: {', '.join(VERDICTS)}")
    if verdict == "denied":
        if reason not in DENIED_REASONS:
            errors.append(f"a denial needs a reason: {' or '.join(DENIED_REASONS)}")
    elif reason:
        errors.append(f"only a denial carries a reason (got `{reason}` on `{verdict}`)")
    if len(text or "") > 2000:
        errors.append("note is over 2000 characters")
    return errors


def make(verdict, text="", reason="", at=None, by="her"):
    """One judgment record. `by` distinguishes her taps from the reopen the edit
    door appends on her behalf, so the history can be read back honestly."""
    entry = {
        "verdict": verdict,
        "at": at or datetime.now().strftime("%Y-%m-%d %H:%M"),
        "by": by,
    }
    if text:
        entry["note"] = text
    if reason:
        entry["reason"] = reason
    return entry


def append(note, verdict, text="", reason="", at=None, by="her"):
    """Add a judgment to a note in place. Raises ValueError on a bad judgment —
    callers validate first and show her the message; this is the backstop that
    keeps a malformed verdict out of the record entirely."""
    errors = validate(verdict, reason, text)
    if errors:
        raise ValueError("; ".join(errors))
    entry = make(verdict, text, reason, at, by)
    note.setdefault("judgments", [])
    if not isinstance(note["judgments"], list):
        note["judgments"] = []
    note["judgments"].append(entry)
    return entry


def reopen_on_edit(note, at=None):
    """Editing a note's text is how she answers an `unsure` — the added context
    IS the answer, so it needs no second tap. Mirrors the behaviour dev notes
    already had for the crew's `night_questions`, which clear on edit.

    Returns the appended entry, or None when there was nothing to reopen: an
    already-open note gets no entry (editing a fresh note is not an event), and
    a denial is NOT reopened by an edit — she said no on purpose, and quietly
    undoing that on a typo fix would be the silent-resurrection bug in reverse.
    """
    if current(note) != "unsure":
        return None
    return append(note, "open", text="reopened — context added", at=at, by="edit")


def counts_by_tab(notes_by_tab):
    """Verdict tallies per page, plus an `all` row — the shape the by-page
    breakdown renders from. Pages with no notes are omitted rather than shown as
    a row of zeros."""
    out = {}
    totals = {v: 0 for v in VERDICTS}
    for tab, notes in (notes_by_tab or {}).items():
        row = {v: 0 for v in VERDICTS}
        seen = False
        for n in notes or []:
            if not isinstance(n, dict):
                continue
            seen = True
            v = current(n)
            row[v] += 1
            totals[v] += 1
        if seen:
            row["total"] = sum(row[v] for v in VERDICTS)
            out[tab] = row
    totals["total"] = sum(totals[v] for v in VERDICTS)
    return {"tabs": out, "all": totals}
