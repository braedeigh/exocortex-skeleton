#!/usr/bin/env python3
"""nominate.py — the night crew picks its own work, oldest first.

Plain English: the owner used to be the only one who could queue a dev note
for the overnight crew (the moon tap). Now the crew also finds work for itself:
each night it takes the OLDEST notes that (a) she has never ruled on — no
approved / unsure / denied judgment (devnote_judgments.py) — and (b) would pass
the eligibility gate anyway. What happens to the picks is the caller's rung
(scripts/nightcrew_run.py pick_mode): proposal cards she judges, or real work.
Any answer from her is permanent here: an answered note is never proposed again
(the burn protocol's refugium rule: re-proposing something she already declined
is how trust in the whole practice dies). An `unsure` comes back only when she
edits the note, which appends `open`.

Why oldest first: it was the simplest policy to start the tuning with. It is
known to be wrong in one way — old is not the same as wanted; it resurfaced
notes she'd been ignoring on purpose — which is why the crew only proposes for
now, and her verdicts on the proposals are the material for the next policy.

This is a NOMINATOR, not a second gate. Eligibility still belongs entirely to
triage.py — this module only asks triage "would this pass if it were lit?"
and picks from the yeses. Pure logic over dicts, no store access; the caller
(scripts/nightcrew_run.py) does the reading and writing.

Touches: tools/nightcrew/triage.py (the gate it defers to),
scripts/nightcrew_run.py (the consumer), tests/test_nightcrew_nominate.py.

Prompt that produced this: "I want it to find things to queue for itself.
Starting with the oldest ones until we're caught up."
"""
import devnote_judgments
from tools.nightcrew import triage


def nominate(notes_by_tab, count):
    """Pick up to `count` never-answered, gate-passing notes, oldest first.

    "Never answered" means the note's current verdict is `open` — no
    judgments at all, or reopened since the last one.

    Returns rows shaped like triage.triage()'s eligible rows ({id, tab, text})
    plus `created`, so the caller can record or queue what it picked.
    """
    if count <= 0:
        return []
    candidates = []
    for tab, notes in (notes_by_tab or {}).items():
        for note in notes or []:
            # Skip anything she has already ruled on — approved, denied, or
            # unsure. An `unsure` stops being answered the moment she edits the
            # note to add context (that appends `open`), so it comes back here
            # on its own without ever needing to be re-proposed blind.
            if not isinstance(note, dict) or devnote_judgments.is_answered(note):
                continue
            # Ask the gate the hypothetical: would this pass if she'd lit it?
            ok, _ = triage.check({**note, "judgments": [devnote_judgments.make("approved")]})
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
