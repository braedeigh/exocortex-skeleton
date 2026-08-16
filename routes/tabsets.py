"""Named sets of pinned tabs — the rows of shortcuts across the top of a panel.

A workspace panel wears one *set* of tabs. A set is just an ordered list of
section ids ("observatory", "journal", …), given a name. The point is that two
panels — usually two windows on two monitors — can wear different ones: a work
set on the screen where the sessions run, a life set on the screen where the
journal and the dashboard live.

Kept here rather than in the browser so both windows and the phone see the same
sets, and so clearing browser data doesn't wipe them. Which set a given panel
is wearing is NOT here: that's per window, and lives in the browser beside the
panel layout (frontend/src/shell/panels/panelStore.ts).

Shape: {"sets": [{"id": str, "name": str, "sections": [str, ...]}, ...]}

The section ids are defined on the client (frontend/src/shell/panels/
sections.ts) — this file stores whatever it's given and never interprets them,
so adding a section is a client-only change. Unknown ids are simply skipped
when the bar renders.
"""
from flask import request, jsonify

import store

FILE = "tab_sets.json"

# What a fresh install gets: the two sets she described, plus an empty third
# that isn't about anything in particular -- somewhere to build a bar for
# whatever she's doing this week without disturbing either of the other two.
DEFAULT = {
    "sets": [
        {"id": "work", "name": "Work", "sections": ["observatory", "research", "terrain"]},
        {"id": "life", "name": "Life", "sections": ["journal", "dashboard", "pond"]},
        {"id": "spare", "name": "Spare", "sections": []},
    ]
}


def load():
    """Stored sets, with any built-in set that isn't there yet added on the end.

    Not just `store.read(FILE, DEFAULT)`: once anything has been saved, the
    stored list is the whole answer, so a set added to DEFAULT later would
    never reach an install that had already saved once -- which is every
    install, since pinning a tab saves.

    Seeding on READ rather than as a one-off fixup is deliberate. A client that
    loaded before the new set existed still holds the old list, and the next
    pin sends that list back, dropping the newcomer again; re-adding it here
    means the next load quietly repairs it instead.

    The tradeoff, stated plainly: a built-in set can't be deleted, only
    emptied. There's no delete in the UI, so nothing can want that yet -- when
    there is one, it needs to record the removal rather than rely on absence.
    """
    stored = store.read(FILE, None)
    if not stored or not isinstance(stored.get("sets"), list):
        return DEFAULT
    sets = list(stored["sets"])
    have = {s.get("id") for s in sets if isinstance(s, dict)}
    for built_in in DEFAULT["sets"]:
        if built_in["id"] not in have:
            sets.append(dict(built_in))
    return {"sets": sets}


def _clean(payload):
    """Keep only well-formed sets. A malformed body shouldn't be able to leave
    her with a workspace that has no tabs at all, so anything unrecognisable is
    dropped rather than stored."""
    sets = []
    for s in (payload or {}).get("sets", []):
        if not isinstance(s, dict):
            continue
        sid = s.get("id")
        name = s.get("name")
        sections = s.get("sections")
        if not isinstance(sid, str) or not sid:
            continue
        if not isinstance(name, str) or not name:
            continue
        if not isinstance(sections, list):
            continue
        sections = [x for x in sections if isinstance(x, str) and x]
        # Duplicates in one bar would render two identical tabs, and pinning is
        # a toggle, so the second could never be un-pinned.
        seen = set()
        deduped = []
        for x in sections:
            if x not in seen:
                seen.add(x)
                deduped.append(x)
        sets.append({"id": sid, "name": name, "sections": deduped})
    return sets


def register(app):
    @app.route("/api/tabsets")
    def get_tabsets():
        return jsonify(load())

    @app.route("/api/tabsets", methods=["PUT"])
    def put_tabsets():
        sets = _clean(request.json)
        if not sets:
            return jsonify({"error": "no valid sets"}), 400
        data = {"sets": sets}
        store.write(FILE, data)
        return jsonify(data)
