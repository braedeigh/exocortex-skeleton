#!/usr/bin/env python3
"""nominate.py — the night crew picks its own work, oldest first.

Plain English: the owner used to be the only one who could queue a dev note
for the overnight crew (the moon tap). Now the crew also queues for itself:
each night it takes the OLDEST notes that (a) she has never said yes or no to,
and (b) would pass the eligibility gate anyway, and lights their moons for
her to see. She keeps a standing veto — un-mooning a note writes `night:
false`, and this module never proposes a note that carries any answer from
her, so one "no" is permanent (the burn protocol's refugium rule: re-proposing
something she already declined is how trust in the whole practice dies).

Why oldest first: the point is to work the backlog down until the crew is
caught up, and the old end of the queue was just re-verified against the code,
so age is not staleness here.

This is a NOMINATOR, not a second gate. Eligibility still belongs entirely to
triage.py — this module only asks triage "would this pass if it were lit?"
and picks from the yeses. Pure logic over dicts, no store access; the caller
(scripts/nightcrew_run.py) does the reading and writing.

Touches: tools/nightcrew/triage.py (the gate it defers to),
scripts/nightcrew_run.py (the consumer), tests/test_nightcrew_nominate.py.

Prompt that produced this: "I want it to find things to queue for itself.
Starting with the oldest ones until we're caught up."
"""
from tools.nightcrew import triage


def nominate(notes_by_tab, count):
    """Pick up to `count` never-considered, gate-passing notes, oldest first.

    "Never considered" is literal: the note has NO `night` key at all. Both
    `night: true` (she or a past night lit it) and `night: false` (she un-lit
    it — her veto) mean the note has an answer already, and an answered note
    is never proposed again.

    Returns rows shaped like triage.triage()'s eligible rows ({id, tab, text})
    plus `created`, so the caller can flip the flags and log what it picked.
    """
    if count <= 0:
        return []
    candidates = []
    for tab, notes in (notes_by_tab or {}).items():
        for note in notes or []:
            if not isinstance(note, dict) or "night" in note:
                continue
            # Ask the gate the hypothetical: would this pass if it were lit?
            ok, _ = triage.check({**note, "night": True})
            if ok:
                candidates.append({
                    "id": note.get("id"),
                    "tab": tab,
                    "text": (note.get("text") or "").strip(),
                    "created": note.get("created") or "",
                })
    # `created` is "YYYY-MM-DD HH:MM" everywhere, so string order is time
    # order. Notes with no timestamp sort first — unknown age reads as oldest.
    candidates.sort(key=lambda n: n["created"])
    return candidates[:count]
