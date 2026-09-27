"""Which room (lane) an Observatory session lives in — one rule, one place.

**What this is, in plain English.** Every session sits in one of four rooms:
Personal, Coding, Orchestra, Research. New sessions have the room written on
them; older ones (about 40% of them on this install) never did, and the app
works it out from the folder the session was started in. That rule used to
live only inside routes/observatory.py, so the SQL copy of the sessions table
(codestore.py) couldn't use it and showed those older rooms as blank. Now both
read it from here, so the app and the database can't disagree about a room.

Touches: `routes/observatory.py` (_conv_lane delegates here — the gates and
defaults a lane hands a session still live there), `codestore.py` (the
`sessions` table's `lane` column), `tests/test_lanes.py`.

Prompt that produced this: "I saw that everything is marked keeper section
there. Wanting personal, coding, etc to be there."
"""
from pathlib import Path

import store

LANES = ("orchestra", "personal", "coding", "research")


def derive_lane(entry):
    """Which room a session lives in. Assigned at creation; DERIVED for every
    entry that predates lanes, so nothing needs migrating: a session rooted
    somewhere OTHER than the app checkout (the vault, the shared root) is
    Personal. That matches how the two kinds were actually created — builder
    sessions got store.BUILD_DIR, the legacy Keeper ones got the vault.

    Nothing derives to CODING, and that's deliberate: Coding shares its ground
    with Orchestra, so a folder can't tell the two apart, and guessing wrong
    would hand an unwatched session Coding's ungated autonomy. A session only
    lands there because she put it there — the ✎ picker, or a fresh create.

    An entry we can't place — no cwd, or a path that won't resolve — derives
    to ORCHESTRA, the gated lane: an unknown-derives-to-personal would quietly
    *widen* a session's autonomy, and the whole gate exists on the principle
    that a wrong guess should cost a tap, not a mistake. Fail toward ask."""
    lane = entry.get("lane")
    if lane in LANES:
        return lane
    cwd = entry.get("cwd")
    if not cwd:
        return "orchestra"
    # Place the session by the ground it stands on. The research room is its
    # own folder, so a session rooted there can only be Research; the app
    # checkout is Orchestra (never Coding — see above); anywhere else is
    # Personal.
    try:
        resolved = Path(cwd).resolve()
        if resolved == Path(store.RESEARCH_ROOM_DIR).resolve():
            return "research"
        return ("orchestra" if resolved == Path(store.BUILD_DIR).resolve()
                else "personal")
    except (OSError, ValueError, RuntimeError):
        return "orchestra"


def is_keeper(entry):
    """A real Keeper session: one that journals. The `bot` field says "keeper"
    on nearly every session (a leftover default from when the Keeper was the
    only bot), so it can't answer this — `journal: true` can."""
    return entry.get("journal") is True
