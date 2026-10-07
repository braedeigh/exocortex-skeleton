"""Named sets of pinned tabs — the rows of shortcuts across the top of a panel.

A workspace panel wears one *set* of tabs. A set is just an ordered list of
section ids ("observatory", "journal", …), given a name. The point is that two
panels — usually two windows on two monitors — can wear different ones: a work
set on the screen where the sessions run, a life set on the screen where the
journal and the dashboard live.

Kept here rather than in the browser so every window sees the same sets, and so
clearing browser data doesn't wipe them. Which set a given panel is wearing is
NOT here: that's per window, and lives in the browser beside the panel layout
(frontend/src/shell/panels/panelStore.ts).

Desktop only, as it stands: the phone gets a fixed strip of tabs and never
draws a panel bar at all (frontend/src/shell/SplitLayout.tsx), so nothing on a
phone reads this yet.

Shape: {"sets": [{"id": str, "name": str, "sections": [str, ...]}, ...],
        "removed": [str, ...]}

`removed` is the record of built-in sets she has deleted. It has to be written
down, because this file re-seeds any built-in that isn't in the stored list
(see load) and can't otherwise tell "she deleted it" from "an old browser tab
sent back a list from before it existed". Without the record, a deleted set
comes back on the next page load.

The section ids are defined on the client (frontend/src/shell/panels/
sections.ts) — this file stores whatever it's given and never interprets them,
so adding a section is a client-only change. Unknown ids are simply skipped
when the bar renders.
"""
from flask import request, jsonify

import config
import store

FILE = "tab_sets.json"

# What a fresh install gets: the two sets she described, plus an empty third
# that isn't about anything in particular -- somewhere to build a bar for
# whatever she's doing this week without disturbing either of the other two.
DEFAULT = {
    "sets": [
        # Just the Observatory: this is the set for the panel that watches
        # sessions, and live ones fill the rest of its bar on their own.
        {"id": "work", "name": "Work", "sections": ["observatory"]},
        {"id": "life", "name": "Life", "sections": ["journal", "dashboard", "pond"]},
        {"id": "spare", "name": "Spare", "sections": []},
    ]
}


# What the desktop app's fresh install gets instead (config.standalone): it has
# only the Observatory and Terrain, so the sets name only their sections. The
# ids stay "work" and "life" — the workspace's default layout names them.
STANDALONE_DEFAULT = {
    "sets": [
        {"id": "work", "name": "Work", "sections": ["observatory"]},
        {"id": "life", "name": "Life", "sections": ["terrain", "activity"]},
    ]
}


def _default():
    """The built-in sets for this install: the desktop app's, or the site's."""
    return STANDALONE_DEFAULT if config.standalone() else DEFAULT


def load():
    """Stored sets, with any built-in she hasn't deleted added back on the end.

    Not just `store.read(FILE, DEFAULT)`: once anything has been saved, the
    stored list is the whole answer, so a set added to DEFAULT later would
    never reach an install that had already saved once -- which is every
    install, since pinning a tab saves.

    Seeding on READ rather than as a one-off fixup is deliberate. A client that
    loaded before the new set existed still holds the old list, and the next
    pin sends that list back, dropping the newcomer again; re-adding it here
    means the next load quietly repairs it instead.

    Which is exactly why deleting one has to be WRITTEN DOWN. To this function
    a missing built-in looks the same whether she deleted it or a stale client
    dropped it, and the whole point of the seeding is to undo the second. So a
    deletion is a positive fact in `removed`, and only a set that is neither
    stored nor removed gets seeded back.
    """
    stored = store.read(FILE, None)
    if not stored or not isinstance(stored.get("sets"), list):
        return _default()
    sets = list(stored["sets"])
    have = {s.get("id") for s in sets if isinstance(s, dict)}
    removed = _clean_removed(stored, have)
    for built_in in _default()["sets"]:
        if built_in["id"] not in have and built_in["id"] not in removed:
            sets.append(dict(built_in))
    return {"sets": sets, "removed": removed}


def _clean_removed(payload, present_ids):
    """The deleted-set ids worth keeping: strings, and not the id of a set that
    is right there in the list. An id in both places is a contradiction -- it
    happens when she re-creates a set she'd deleted -- and the set existing is
    the newer, louder fact, so the tombstone is dropped rather than left to
    fight it."""
    raw = (payload or {}).get("removed")
    if not isinstance(raw, list):
        return []
    seen = set()
    out = []
    for x in raw:
        if isinstance(x, str) and x and x not in seen and x not in present_ids:
            seen.add(x)
            out.append(x)
    return out


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
        payload = request.json
        sets = _clean(payload)
        if not sets:
            # A body nothing survives is a bug somewhere, not an instruction to
            # leave her with no tabs at all. Refuse it and keep what's stored.
            return jsonify({"error": "no valid sets"}), 400

        present = {s["id"] for s in sets}
        if isinstance((payload or {}).get("removed"), list):
            removed = _clean_removed(payload, present)
        else:
            # NO `removed` KEY MEANS "I HAVE NO OPINION", NOT "NOTHING IS
            # DELETED". A browser tab open since before deleting existed sends
            # exactly this, and letting it clear the list would resurrect every
            # set she's thrown away. Only a body that says `removed` outright
            # gets to change it.
            stored = store.read(FILE, None) or {}
            removed = _clean_removed(stored, present)

        data = {"sets": sets, "removed": removed}
        store.write(FILE, data)
        return jsonify(data)
