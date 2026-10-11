#!/usr/bin/env python3
"""nominate.py — the night crew picks its own work, newest first, from the last week.

Plain English: the owner used to be the only one who could queue a dev note
for the overnight crew (the moon tap). Now the crew also finds work for itself:
each night it takes the NEWEST notes, written in the last week, that (a) she
has never ruled on — no approved / unsure / denied judgment
(devnote_judgments.py) — and (b) would pass the eligibility gate anyway. What
happens to the picks is the caller's rung (scripts/nightcrew_run.py pick_mode):
proposal cards she judges, or real work. Any answer from her is permanent here:
an answered note is never proposed again (the burn protocol's refugium rule:
re-proposing something she already declined is how trust in the whole practice
dies). An `unsure` comes back only when she edits the note, which appends
`open`.

Why newest first, and only the last week: a note is written against whatever
is on the screen — "this doesn't float", "change the emoji" — and within weeks
she can no longer tell what it meant. Oldest-first (the first policy) proved
it: 4 of her 7 refusals of its picks were "I don't know what this refers to".
A note proposed while it's fresh can still be judged. The old backlog is a job
for a burn, not for the crew.

This is a NOMINATOR, not a second gate. Eligibility still belongs entirely to
triage.py — this module only asks triage "would this pass if it were lit?"
and picks from the yeses. Pure logic over dicts, no store access; the caller
(scripts/nightcrew_run.py) does the reading and writing.

Touches: tools/nightcrew/triage.py (the gate it defers to),
scripts/nightcrew_run.py (the consumer), tests/test_nightcrew_nominate.py.

Prompt that produced this: "I want it to find things to queue for itself."
Then, for the ordering, her ok to: "newest-first: propose notes within about a
week of writing them, while you still remember what 'this' meant, and leave
the old backlog to a burn."
"""
from datetime import datetime, timedelta

import devnote_judgments
from tools.nightcrew import triage

# How far back the crew looks. A week is roughly how long a note written
# against the screen stays intelligible to her.
WINDOW_DAYS = 7


def nominate(notes_by_tab, count, now=None):
    """Pick up to `count` never-answered, gate-passing notes from the last
    WINDOW_DAYS, newest first. `now` is injectable for tests.

    "Never answered" means the note's current verdict is `open` — no
    judgments at all, or reopened since the last one.

    Returns rows shaped like triage.triage()'s eligible rows ({id, tab, text})
    plus `created`, so the caller can record or queue what it picked.
    """
    if count <= 0:
        return []
    # `created` is "YYYY-MM-DD HH:MM" everywhere, so string order is time
    # order and the window is a string comparison. An undated note has no age
    # to judge, so it falls outside the window.
    since = ((now or datetime.now()) - timedelta(days=WINDOW_DAYS)).strftime("%Y-%m-%d %H:%M")
    candidates = []
    for tab, notes in (notes_by_tab or {}).items():
        for note in notes or []:
            # Skip anything she has already ruled on — approved, denied, or
            # unsure. An `unsure` stops being answered the moment she edits the
            # note to add context (that appends `open`), so it comes back here
            # on its own without ever needing to be re-proposed blind.
            if not isinstance(note, dict) or devnote_judgments.is_answered(note):
                continue
            if (note.get("created") or "") < since:
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
    candidates.sort(key=lambda n: n["created"], reverse=True)
    return candidates[:count]
