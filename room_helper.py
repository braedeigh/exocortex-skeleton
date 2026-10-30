"""The room helper — one Sonnet per room, a layer above the swarm helpers, that
decides who should be working together.

**What this is, in plain English.** Sessions become a swarm by messaging each
other (swarms.py), and each swarm has a helper that summarises it
(swarm_helper.py). But messages are a blunt glue: one stray message joins two
unrelated clusters into one swarm for good, and two sessions doing the same
work never find each other unless one happens to write. The room helper looks
at the whole room from above and fixes that. It reads only summaries:

  - each open swarm's summary and each of its members' summaries (a closed
    swarm — fewer than two sessions still working in it — is left out, and
    its one working session, if it has one, counts as working alone;
    open_swarms),
  - the swarm's CLUSTERS, worked out here in code: the groups of members who
    messaged each other within config.ROOM_HELPER_QUIET_HOURS, each with the
    last time it messaged anyone in another cluster,
  - each session working alone: its summary (`session_summaries`) plus what
    it has done since. Each of those summaries is written by a model call of
    its own, made side by side with the room's call in the same run
    (swarm_helper.summarise_sessions) — the room's call writes none of them,
  - its own last few moves, including the ones she undid,
  - and, as a section of its own, the files every open session has edited
    lately, with any file two of them share flagged (edited_files.py) — the
    plainest sign that two lines of work collide.

From those it can make four moves:

  - FORM a new swarm from sessions working alone, and tell them about each other;
  - JOIN sessions to an existing swarm;
  - SPLIT a swarm, when a cluster in it has stopped talking to the rest;
  - RELEASE sessions from a swarm, back to working alone.

A move is a PLACEMENT (swarms.place): it overrides every message the
sessions exchanged before it, so a swarm glued together by old messages
really comes apart. A session's continuations always move with it. It acts
on its own; every move is posted in its chat with the reason, stored in
`room_moves` with what it replaced, and can be undone
(`scripts/room_moves.py undo <id>`). Each moved session is told in one
message, queued for the end of its turn — never interrupting. A swarm is at
least two sessions still working: forming one takes two working lines of
work, a split carrying fewer is a release, and a split or release that
leaves a swarm with one working session closes it (swarms.is_closed) — the
move says so, and that session is told it works alone now.

Its role, in her words: "your job as room helper is to babysit the sessions
that are ongoing in the room and coordinate with them if necessary."

Its chat is a helper chat like a swarm helper's (helper_chat.py), started from
the same kind of seed — a doc, her last messages with its replies, and every
active session in the room with its summary and files. It grows: it resumes
its conversation turn after turn and starts over from a fresh seed once it
passes config.HELPER_RESET_TOKENS (while "room_helper" is in
config.HELPER_GROW_ROLES; otherwise every turn starts fresh).
The room overview (room_overview) is what a RUN reads; the chat looks swarms,
clusters and moves up when it needs them.

A PROJECT HELPER is this same helper scoped to one project room
(project_rooms.py): the scope `coding:<build id>` instead of `coding`. It
reads and moves only the swarms and sessions inside its project. Every
function here that takes a `room` takes a scope: `_scope` splits it into
(room, project or None).

The Coding room helper SITS ABOVE the project helpers. It reads each project
room as ONE block (its name, its helper's latest overview, its swarms and
sessions by id, its helper's moves and report up since the last run, and what's
waiting there) and moves only the sessions in no project room. Above that:

  - OPEN (open_room): it makes a project room by itself, from a build on the
    list or a folder it adds to the list, when at least
    config.PROJECT_ROOM_MIN_SESSIONS working sessions already work there.
  - PROPOSE (propose): inside a room it assigns and that room's helper
    approves or declines, for form, join, split, release, PLACE (into or out
    of a project room) and CLOSE. Approving makes the move through the same
    doors, recorded and undoable; declining sends the reason back up; 24 hours
    unanswered lapses (lapse_proposals) and it's told.
  - REPORT UP: a project helper's run may say `up` when its project is stuck or
    crossing into other projects, which wakes the room helper.

Her words: "the room helper basically tries to assign it and then the project
helper approves it or not." The owner skips all of it with `--by-owner`. Which
helper is WOKEN for a session's activity doesn't change: the closest
(helper_chat.own_sessions). Rooms are never merged.

When it runs: at the minute tick (tick), at most once every
config.ROOM_HELPER_MIN_SEC, and only when some session in the room has done
something since the last run. Each run is its own detached process
(`python3 room_helper.py run <room>`): one model call for the room, and one
for each session working alone that has done something since its summary.

Touches: swarms.py (placements: place, unplace, new_swarm, line_of_work),
project_rooms.py (which sessions and swarms are in which project room),
swarm_helper.py (ask_model, side_by_side, summarise_sessions, the
member-activity reader, poke), sqlstore.py
(session_summaries, swarm_pins, room_moves, room_proposals, room_helper_runs),
buildlist.py (the folders a room can be opened on), the session
index (the helper's own entry — `role: "room_helper"`), routes/observatory.py
(peer_send, and its chat turns), helper_chat.py, edited_files.py (the files
section), config.py (ROOM_HELPER_*),
scripts/coming_up_dispatcher.py (the minute tick), scripts/room_moves.py (the
moves by hand, and undo), tests/test_room_helper.py. Design: docs/swarms.md.

Prompt that produced this: "I also want a helper in the coding room at large.
It also reads individual sessions a layer above the swarm helper. It reads
just the summary of what's going on with the swarm and the summaries of the
single agents and determines if they should be designated as a swarm, making
them aware of each other or placed into an existing swarm. It also can
separate out swarms if a cluster is not talking to other clusters anymore or
move solo sessions out of a swarm into the layer above. It has message
permissions to them." — then: it acts on its own, every move posted with its
reason and undoable; placements override the message links ("spins could
lead to disconnected swarms"); the Coding room only, to start.
"""
import copy
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import buildlist
import config
import edited_files
import lanes
import peermail
import sqlstore
import store
import swarm_helper
import swarms

ROLE = "room_helper"
# The same helper scoped to one project room (see the top of the file).
PROJECT_ROLE = "project_helper"
KINDS = ("form", "join", "split", "release")
# The moves about project rooms, not swarms: whose room a session is in, and
# which rooms exist. Only the room helper above the project rooms makes them.
ROOM_KINDS = ("place", "open", "close")
# What the room helper can ask a project helper to do (propose).
PROPOSAL_KINDS = (*KINDS, "place", "close")

# How much of a solo session's new activity one run reads. Less than a swarm
# member gets: the room helper only needs to know what the work is about.
_SOLO_CHARS = 1500
# How many of its own past moves a run is shown.
_RECENT_MOVES = 10

SYSTEM_PROMPT = """You are the {place} of one person's app, where AI \
coding agents work in sessions. Sessions that message each other form a SWARM, and every swarm \
has its own helper. You sit a layer above: your job is to watch over the sessions that are \
running in the room and coordinate with them when it's needed — mostly by deciding who should \
be working together. You read summaries, plus a list of the files each open session has \
edited lately. A swarm is at least two sessions still working \
(a session and its own continuations count as one) plus its helper; a swarm that drops to one \
working session closes by itself, and that session shows up below as working alone. Each \
session's own summary is written by a separate call, not by you. Your job:
1. Write a short overview of the room: the swarms, what the solo sessions are doing, anything \
that looks tangled.
2. Make moves, but ONLY when the summaries clearly show one is right:
   - form: two or more sessions working alone on the same thing, or on work that collides \
(same files, same feature) — make them a swarm so they know about each other. Two sessions \
editing the same file (flagged under "Files being edited now") are colliding.
   - join: a session working alone whose work belongs in an existing swarm.
   - split: a swarm holding two clusters that do unrelated work and have stopped talking to \
each other; list the cluster that should leave, and it becomes a swarm of its own.
   - release: a session in a swarm whose work has nothing to do with the swarm's any more.
   Every swarm you make or leave behind must hold at least two sessions still working. Never \
form, split or release so that a swarm ends up with one working session — a split or release \
that would leave one behind closes that swarm, and the one left works alone too.
Be conservative. No move is better than a wrong one. Never split clusters that messaged each \
other within the last {quiet} hours. Never redo a move she undid. A finished or retired \
session doesn't need moving.
3. For every move write the reason (for the owner) and one short message to the moved \
sessions: who they're now working with and why it matters to their work. One message per \
move; don't chat.
Use session ids exactly as given; `swarm` is the swarm id a join or split refers to.{ladder} \
Plain words; the owner reads everything you write."""

# What a run of the helper above the project rooms is told about them.
ROOM_LADDER = """

You also sit above the project rooms, each shown below as one block. Each has its own helper, which \
looks after what's inside it. You have three more moves, and `project` says which room:
   - open: make a project room (`project`: a build id or a full folder path, `convs` empty) when \
at least {floor} working sessions already work mostly in that repo. It's refused below that. Don't \
reopen a room that was closed unless the work has clearly come back.
   - place: put sessions into a project room (`project`: its build id) or out of every one \
(`project`: null). This goes to that room's helper as a proposal, for it to approve or decline.
   - close: ask a project room's helper to close its room, when the work there is over (`project`: \
its build id, `convs` empty). Also a proposal.
A form, join, split or release of sessions inside a project room is a proposal too: you assign, its \
helper approves or declines. Don't repeat a proposal that's waiting or was declined."""

# What a project helper's run is told about the helper above it.
PROJECT_LADDER = """

You sit under the room helper, which sees this project as one block and may propose moves here. \
Proposals waiting on you are listed below; you answer those in your chat, never in `moves`. `up` is \
your report to the room helper: a sentence or two when this project is stuck, or when its work is \
crossing into other projects. It wakes the room helper, so leave it an empty string when there's \
nothing, and don't repeat your last report."""

SCHEMA = {
    "type": "object",
    "properties": {
        "overview": {"type": "string"},
        "moves": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": list(KINDS)},
                "convs": {"type": "array", "items": {"type": "string"}},
                "swarm": {"type": ["integer", "null"]},
                "reason": {"type": "string"},
                "message": {"type": "string"}},
            "required": ["kind", "convs", "reason", "message"]}},
    },
    "required": ["overview", "moves"],
}


def _schema(scope):
    """The answer a run must give in this scope: the moves it may make, plus,
    for a project helper, its report up, and for the helper above the project
    rooms, the room moves and which room they're about."""
    import project_rooms
    lane, project = _scope(scope)
    schema = copy.deepcopy(SCHEMA)
    if project is not None:
        schema["properties"]["up"] = {"type": "string"}
        schema["required"].append("up")
    elif lane == project_rooms.ROOM:
        item = schema["properties"]["moves"]["items"]
        item["properties"]["kind"]["enum"] = [*KINDS, *ROOM_KINDS]
        item["properties"]["project"] = {"type": ["string", "null"]}
    return schema


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _scope(scope):
    """A scope as (room, project room id or None): `coding` is the Coding
    room's own helper, `coding:based-foods` the Based Foods project helper."""
    room, _, project = str(scope).partition(":")
    return room, project or None


def _place_name(scope):
    """What the helper is, in words: the room helper of a room, or the
    project helper of a project room."""
    room, project = _scope(scope)
    if project is None:
        return f"room helper for the {room} room"
    import project_rooms
    found = project_rooms.find(project)
    name = found["name"] if found else project
    return (f"project helper for the {name} project room, inside the {room} room — the"
            f" sessions working on {name}")


def _trim(text, cap):
    text = str(text or "").strip()
    return text if len(text) <= cap else "…" + text[-cap:]


# --- The helper's own session ---------------------------------------------------

def is_helper(entry, scope=None):
    """Is this the helper of this scope (any room or project helper, when no
    scope is given)?"""
    if not isinstance(entry, dict) or entry.get("role") not in (ROLE, PROJECT_ROLE):
        return False
    if scope is None:
        return True
    room, project = _scope(scope)
    if project is None:
        return entry.get("role") == ROLE and entry.get("room") == room
    return entry.get("role") == PROJECT_ROLE and entry.get("project_room") == project


def find_helper(room, index=None):
    """The helper's session id for this scope (a room, or a project room), or None."""
    index = store.read("bot_chats/index", {}) if index is None else index
    return next((conv for conv, entry in index.items()
                 if is_helper(entry, room) and not entry.get("archived")), None)


def ensure_room_helper(room):
    """The helper's Observatory session for this scope, made on first need."""
    from routes import observatory
    helper = find_helper(room)
    stored = (store.read("bot_chats/index", {}).get(helper) or {}) if helper else {}
    if helper and stored.get("allowed_tools") == swarm_helper.HELPER_TOOLS:
        return helper
    with store.mutate("bot_chats/index", {}) as index:
        helper = find_helper(room, index)
        if helper:
            # Keep its stored tools in step with HELPER_TOOLS, as the swarm
            # helper's are — its turns already run with them
            # (routes/observatory.py _conv_config); this keeps the record true.
            index[helper]["allowed_tools"] = list(swarm_helper.HELPER_TOOLS)
            return helper
        helper = observatory._new_conv_id(index)
        lane, project = _scope(room)
        title = f"Room helper · {lane.capitalize()}"
        if project is not None:
            import project_rooms
            found = project_rooms.find(project)
            title = f"Project helper · {found['name'] if found else project}"
        index[helper] = {
            "bot": "helper", "role": PROJECT_ROLE if project else ROLE, "room": lane,
            **({"project_room": project} if project else {}),
            "title": title,
            "started": _now(), "last_at": _now(), "claude_session_id": None,
            "cost_usd": 0.0, "journal": False, "lane": lane,
            "cwd": str(store.BUILD_DIR), "allowed_tools": list(swarm_helper.HELPER_TOOLS),
        }
    return helper


# --- Who is in the room ------------------------------------------------------------

def _helper_convs(index):
    return {c for c, e in index.items()
            if isinstance(e, dict) and e.get("role") in swarms.HELPER_ROLES}


def _project_members(room):
    """{conv: project room id} for the room's sessions — empty, and nothing
    read, when no project room is switched on."""
    import project_rooms
    return project_rooms.sync() if _scope(room)[0] == project_rooms.ROOM else {}


def open_swarms(room, index=None, members=None):
    """The swarms in this scope it works with: live, not closed, and in its
    project room (for a project helper) or in none (for the room helper). A closed
    swarm (fewer than two sessions still working, swarms.is_closed) is left
    out of what it reads and can't be joined or split — there's no one left
    in it to coordinate with each other, and its one working session, if any,
    is listed as working alone (solo_sessions). It comes back here by itself
    when a second session works in it again."""
    import project_rooms
    lane, project = _scope(room)
    if index is None:
        index = store.read("bot_chats/index", {})
    members = _project_members(room) if members is None else members
    return [c for c in swarms.overview() if c["lane"] == lane and not c.get("closed")
            and project_rooms.swarm_room([m["conv"] for m in c["members"]], index,
                                         members) == project]


def solo_sessions(room, index, cards, members=None):
    """The live sessions in this scope working alone: not archived, finished or
    handed on, not a helper, in its project room (or in none, for the room
    helper), and in none of these (open) swarms — so the last working session
    of a closed swarm is here too. Newest first."""
    lane, project = _scope(room)
    members = _project_members(room) if members is None else members
    in_swarm = {m["conv"] for card in cards for m in card["members"]}
    helpers = _helper_convs(index)
    found = [(entry.get("last_at") or "", conv) for conv, entry in index.items()
             if isinstance(entry, dict) and conv not in in_swarm and conv not in helpers
             and not swarms.member_retired(entry) and lanes.derive_lane(entry) == lane
             and members.get(conv) == project
             # Saved for later: parked by her, so not the helper's to place
             # (routes/observatory.py save_for_later).
             and not entry.get("saved_at")]
    return [conv for _, conv in sorted(found, reverse=True)]


def clusters(conn, members, index, since):
    """A swarm's clusters: its members grouped by who messaged whom after
    `since`, plus continuations (a line of work is one cluster). Each is
    returned as {"convs": [...], "last_cross": when it last messaged, or was
    messaged by, a member of another cluster (None: never)}. Biggest first."""
    member_set = set(members)
    marks = ",".join("?" * len(members))
    rows = conn.execute(
        f"SELECT from_conv, to_conv, at FROM agent_messages WHERE kind = 'A'"
        f" AND status != 'cancelled' AND from_conv IN ({marks}) AND to_conv IN ({marks})",
        (*members, *members)).fetchall() if members else []
    recent = [(a, b) for a, b, at in rows if (at or "") > since]
    continued = [(index[c]["spawned_from"], c) for c in members
                 if isinstance(index.get(c), dict) and index[c].get("spawned_via") == "continue"
                 and index[c].get("spawned_from") in member_set]
    grouped = swarms.groups(recent + continued)
    placed = set().union(*grouped) if grouped else set()
    grouped += [{c} for c in members if c not in placed]
    which = {c: i for i, group in enumerate(grouped) for c in group}
    last_cross = [None] * len(grouped)
    for a, b, at in rows:
        if which[a] != which[b]:
            for i in (which[a], which[b]):
                if at and (last_cross[i] is None or at > last_cross[i]):
                    last_cross[i] = at
    out = [{"convs": sorted(group), "last_cross": last_cross[i]}
           for i, group in enumerate(grouped)]
    return sorted(out, key=lambda c: -len(c["convs"]))


def recent_moves(room, limit=_RECENT_MOVES):
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT id, at, kind, convs, from_swarm, to_swarm, reason, undone_at, before"
            " FROM room_moves WHERE room = ? ORDER BY id DESC LIMIT ?", (room, limit)).fetchall()
    finally:
        conn.close()
    return [{"id": i, "at": at, "kind": kind, "convs": json.loads(convs), "from_swarm": f,
             "to_swarm": t, "reason": reason, "undone_at": undone,
             "target": _target_words(kind, t, before)}
            for i, at, kind, convs, f, t, reason, undone, before in rows]


def _target_words(kind, to_swarm, before):
    """Where a move took its sessions, in words. A room move keeps the room
    in its `before` JSON; a swarm move has its `to_swarm`."""
    if kind not in ROOM_KINDS:
        return f"swarm {to_swarm}" if to_swarm is not None else "alone"
    before = json.loads(before) if isinstance(before, str) else (before or {})
    if kind == "place":
        return before.get("to_name") or "no project room"
    return f"{'opened' if kind == 'open' else 'closed'} {before.get('name') or before.get('build')}"


def _stored_summaries(convs):
    if not convs:
        return {}
    conn = sqlstore.open_db()
    try:
        return {conv: (summary, at) for conv, summary, at in conn.execute(
            f"SELECT conv, summary, summary_at FROM session_summaries"
            f" WHERE conv IN ({','.join('?' * len(convs))})", list(convs))}
    finally:
        conn.close()


def _describe(conv, entry):
    state = "retired" if swarms.member_retired(entry) else swarms._status(entry)
    # A saved session says so, so the helper knows it isn't its to move.
    if entry.get("saved_at"):
        state += ", saved for later (don't move it)"
    return f"`{conv}` {entry.get('title') or conv} — {state}, last active {entry.get('last_at') or '?'}"


def _latest_overview(scope):
    """The first line of the latest overview a helper's run wrote, or None."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT output FROM room_helper_runs WHERE room = ? AND output"
                           " IS NOT NULL ORDER BY id DESC LIMIT 1", (scope,)).fetchone()
    finally:
        conn.close()
    try:
        overview = (json.loads(row[0]).get("overview") or "").strip() if row else ""
    except (ValueError, AttributeError):
        overview = ""
    return overview.splitlines()[0] if overview else None


def _last_report_up(scope, since=""):
    """The newest report up a project helper's runs wrote after `since`, as
    (when, the words), or None."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute("SELECT at, output FROM room_helper_runs WHERE room = ? AND at > ?"
                            " AND output IS NOT NULL ORDER BY id DESC LIMIT 50",
                            (scope, since)).fetchall()
    finally:
        conn.close()
    for at, output in rows:
        try:
            words = (json.loads(output).get("up") or "").strip()
        except (ValueError, AttributeError):
            continue
        if words:
            return at, words
    return None


def project_blocks(room, index, members):
    """The room helper's view of each project room: ONE block apiece — its
    name, its helper's latest overview line, how many open swarms and working
    sessions it holds, those swarms and sessions by id (a proposal has to name
    them), its helper's moves and report up since the room helper's last run,
    and the proposals waiting there. Their detail is its project helper's."""
    import project_rooms
    found = project_rooms.rooms() if _scope(room)[0] == project_rooms.ROOM else []
    if not found:
        return []
    out = ["## Project rooms", "",
           "Each project room has its own helper, which looks after the swarms and sessions"
           " inside it. You sit above it: inside a room you propose and its helper approves or"
           " declines.", ""]
    last_run = (index.get(find_helper(room, index)) or {}).get("helper_last_run") or ""
    cards = [c for c in swarms.overview() if c["lane"] == _scope(room)[0] and not c.get("closed")]
    for project in found:
        scope = f"{_scope(room)[0]}:{project['id']}"
        inside = [c for c in cards if project_rooms.swarm_room(
            [m["conv"] for m in c["members"]], index, members) == project["id"]]
        working = [conv for conv, at in members.items() if at == project["id"]
                   and not swarms.member_retired(index.get(conv))]
        helper = find_helper(scope, index)
        out += [f"### {project['name']} (project room `{project['id']}`)"
                + (f", helper `{helper}`" if helper else ", no helper yet"),
                f"Its helper's latest overview: {_latest_overview(scope) or '(none yet)'}",
                f"{len(inside)} open swarm{'s' if len(inside) != 1 else ''},"
                f" {len(working)} session{'s' if len(working) != 1 else ''} still working."]
        # Its swarms and sessions by id, so a proposal can name them.
        for card in inside:
            ids = [m["conv"] for m in card["members"] if not m.get("retired")]
            out.append(f"- swarm {card['id']} ({card['name']}): {', '.join(ids)}")
        solos = solo_sessions(scope, index, inside, members)
        if solos:
            out.append(f"- working alone: {', '.join(solos)}")
        moves = [m for m in recent_moves(scope) if m["at"] > last_run]
        if moves:
            out.append("Its helper's moves since your last run:")
            out += [f"- #{m['id']} {m['kind']} {', '.join(m['convs'])} → {m['target']}: {m['reason']}"
                    for m in reversed(moves)]
        waiting = proposals(project["id"])
        if waiting:
            out.append("Your proposals waiting on its helper:")
            out += [f"- {_proposal_words(p)}" for p in waiting]
        report = _last_report_up(scope, last_run)
        if report:
            out.append(f"Its helper reported up at {report[0]}: {report[1]}")
        out.append("")
    return out


def room_overview(room, activity=False):
    """The room as the room helper sees it, as one markdown document: every
    live swarm with its summaries and clusters, every session working alone,
    and the recent moves. With `activity`, each solo session also carries
    what it has done since its summary — that's a run's input; the chat's
    seed leaves it out."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    members = _project_members(room)
    cards = open_swarms(room, index, members)
    since = (datetime.now() - timedelta(hours=config.ROOM_HELPER_QUIET_HOURS)
             ).isoformat(timespec="seconds")
    lane, project = _scope(room)
    title = f"The {lane} room" if project is None else f"The {project} project room"
    out = [f"# {title}, {_now()}", ""]
    if project is None:
        out += project_blocks(room, index, members)
    out += ["## Swarms", ""]
    conn = sqlstore.open_db()
    try:
        for card in cards:
            out += [f"### Swarm {card['id']}: {card['name']}", "",
                    f"Summary (as of {card.get('summary_at') or 'never'}): "
                    + (card.get("summary") or "(none yet)"), "", "Members still working:"]
            live = [m for m in card["members"] if not m.get("retired")]
            for m in live:
                out.append(f"- {_describe(m['conv'], index.get(m['conv']) or {})}. "
                           + (m.get("summary") or "(no summary yet)"))
            retired = len(card["members"]) - len(live)
            if retired:
                out.append(f"- (and {retired} retired members)")
            out += ["", f"Clusters (who messaged whom in the last "
                        f"{config.ROOM_HELPER_QUIET_HOURS:g} hours, with handoffs):"]
            for n, cluster in enumerate(clusters(conn, [m["conv"] for m in card["members"]],
                                                 index, since), 1):
                working = [c for c in cluster["convs"]
                           if not swarms.member_retired(index.get(c))]
                if not working:
                    continue
                out.append(f"- cluster {n}: {', '.join(working)}"
                           f" (+{len(cluster['convs']) - len(working)} retired)"
                           f" — last messaged another cluster: {cluster['last_cross'] or 'never'}")
            out.append("")
    finally:
        conn.close()
    if not cards:
        out += ["(no swarms)", ""]
    solos = solo_sessions(room, index, cards, members)
    stored = _stored_summaries(solos)
    out += ["## Sessions working alone", ""]
    for conv in solos:
        summary, summary_at = stored.get(conv, (None, None))
        out.append(f"### {_describe(conv, index[conv])}")
        out.append("Summary: " + (summary or "(none yet)"))
        if activity:
            new = swarm_helper._member_activity(conv, summary_at)
            out += [f"New since {summary_at or 'it started'}:",
                    _trim(new, _SOLO_CHARS) or "(nothing new)"]
        out.append("")
    if not solos:
        out += ["(none)", ""]
    # What a project helper owes the helper above it: its answers, and its last
    # report, so it doesn't repeat one.
    if project is not None:
        out += [proposals_section(project), ""]
        report = _last_report_up(room)
        if report:
            out += [f"Your last report up, at {report[0]}: {report[1]}", ""]
    out += ["## Your recent moves", ""]
    moves = recent_moves(room)
    for move in moves:
        undone = (f" — SHE UNDID THIS at {move['undone_at']}; don't redo it"
                  if move["undone_at"] else "")
        out.append(f"- #{move['id']} {move['at']} {move['kind']} {', '.join(move['convs'])}"
                   f" → {move['target']}: {move['reason']}{undone}")
    if not moves:
        out.append("(none yet)")
    return "\n".join(out) + "\n"


# --- Making a move -------------------------------------------------------------------

class MoveError(ValueError):
    """A move that can't be made as asked — the reason says why."""


def _was_undone(room, kind, convs):
    """Did she undo this same move (same kind, same sessions)?"""
    return any(m["undone_at"] and m["kind"] == kind and set(m["convs"]) == set(convs)
               for m in recent_moves(room, limit=50))


def _whole_lines(convs, index, by):
    """The sessions a move is really about: every one checked to exist and not
    be a helper, each with its whole line of work, since its continuations
    would re-link it otherwise. Refuses a session she saved for later, unless
    she's the one moving it."""
    unknown = [c for c in convs if not isinstance(index.get(c), dict)]
    if unknown or not convs:
        raise MoveError(f"no such session: {', '.join(unknown) or '(none given)'}")
    if _helper_convs(index) & set(convs):
        raise MoveError("helpers can't be moved")
    moved = set()
    for conv in convs:
        moved |= swarms.line_of_work(conv, index)
    moved = sorted(moved)
    saved = [c for c in moved if (index.get(c) or {}).get("saved_at")]
    if saved and by != "owner":
        raise MoveError(f"saved for later by the owner: {', '.join(saved)}")
    return moved


def _tell_sessions(helper, tell, index):
    """Tell each session its note, once, at the end of its turn: one message
    of the words and the facts, to those still working."""
    from routes import observatory
    for conv, facts, words in tell:
        if swarms.member_retired(index.get(conv)):
            continue
        text = "\n\n".join(t for t in ((words or "").strip(), facts) if t)
        try:
            observatory.peer_send(helper, conv, text, mode="queue")
        except (KeyError, ValueError) as e:
            print(f"{_now()} room move message to {conv} failed: {e}", file=sys.stderr)


def execute(room, kind, convs, swarm_id=None, reason="", message="", by=None):
    """Make one move: place the sessions (with their continuations), record
    it so it can be undone, tell each moved session, and wake the helpers of
    the swarms it touched. Returns the stored move as a dict. Raises
    MoveError when the move doesn't fit the room as it is now."""
    if kind not in KINDS:
        raise MoveError(f"unknown move {kind!r}")
    index = store.read("bot_chats/index", {})
    moved = _whole_lines(convs, index, by)
    # Keep each helper to its own sessions: a project helper moves only the
    # sessions in its project room, the room helper only those in none.
    lane, project = _scope(room)
    members = _project_members(room)
    outside = [c for c in moved if members.get(c) != project]
    if outside:
        where = (f"the {project} project room" if project
                 else "no project room (a project room's own helper moves those: propose it"
                      " with `scripts/room_moves.py propose`)")
        raise MoveError(f"not in {where}: {', '.join(outside)}")
    # Where each session is now: its swarm only while that swarm is open. A
    # closed swarm's one working session is working alone (swarms.is_closed).
    open_ids = {c["id"] for c in swarms.overview() if not c.get("closed")}
    live = {c["id"]: c for c in open_swarms(room, index, members)}
    current = {c: (s if s in open_ids else None)
               for c, s in ((c, swarms.swarm_of(c)) for c in moved)}
    # A swarm is two lines of work still going: count the ones this move carries.
    working_lines = len(swarms.live_lines(moved, index))
    from_swarm = None
    # Check the move against the room as it is now.
    if kind == "form":
        if any(current.values()):
            raise MoveError("form is for sessions working alone — use join or split")
        if working_lines < 2:
            raise MoveError("a swarm needs at least two sessions still working"
                            " (a session and its continuations count once)")
    elif kind == "join":
        if swarm_id not in live:
            raise MoveError(f"swarm {swarm_id} isn't an open swarm in the {room} scope")
        if all(current[c] == swarm_id for c in moved):
            raise MoveError(f"already in swarm {swarm_id}")
        from_swarm = next((s for s in current.values() if s), None)
    elif kind == "split":
        # One working line of work leaving on its own isn't a swarm: that's a release.
        if working_lines < 2:
            return execute(room, "release", convs, None, reason, message, by)
        if swarm_id not in live:
            raise MoveError(f"swarm {swarm_id} isn't an open swarm in the {room} scope")
        if any(current[c] != swarm_id for c in moved):
            raise MoveError(f"split moves members of swarm {swarm_id} only")
        if not set(swarms.overview_members(swarm_id)) - set(moved):
            raise MoveError("that's the whole swarm — nothing to split from")
        from_swarm = swarm_id
    elif kind == "release":
        from_swarm = next((s for s in current.values() if s), None)
        if from_swarm is None:
            raise MoveError("already working alone")
    if by != "owner" and _was_undone(room, kind, moved):
        raise MoveError("she undid this same move before")
    # Who stays behind in the swarm the sessions leave, read before the move:
    # a swarm left with nobody linked is dissolved by the placement's sync.
    staying = (set(swarms.overview_members(from_swarm)) - set(moved)
               if from_swarm is not None else set())
    # Record the move first, so the placement can point at it.
    now = _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        move_id = conn.execute(
            "INSERT INTO room_moves (at, room, kind, convs, from_swarm, reason, before)"
            " VALUES (?, ?, ?, ?, ?, ?, '{}')",
            (now, room, kind, json.dumps(moved), from_swarm, reason)).lastrowid
        conn.execute("COMMIT")
    finally:
        conn.close()
    to_swarm = {"form": None, "split": None, "join": swarm_id, "release": None}[kind]
    if kind in ("form", "split"):
        to_swarm = swarms.new_swarm(lane)
    before = swarms.place(moved, to_swarm, move_id)
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("UPDATE room_moves SET to_swarm = ?, before = ? WHERE id = ?",
                     (to_swarm, json.dumps(before), move_id))
        conn.execute("COMMIT")
    finally:
        conn.close()
    # Wake the helpers of the swarms this touched: a new swarm gets named,
    # a changed one re-summarised.
    for touched, trigger in ((to_swarm, "formed" if kind in ("form", "split") else "joined"),
                             (from_swarm, "turn")):
        if touched is not None and swarms.is_live(touched):
            try:
                swarm_helper.poke(touched, trigger)
            except Exception as e:
                print(f"{_now()} helper poke for swarm {touched} failed: {e}", file=sys.stderr)
    # Find who a move out of a swarm left on their own. A swarm down to one
    # working line of work has closed (swarms.is_closed) — or dissolved, when
    # nothing links its rest any more; that line is working alone now, and is
    # told so along with the moved sessions.
    left_alone = []
    if staying and swarms.is_closed(staying, index):
        left_alone = sorted(c for c in staying if not swarms.member_retired(index.get(c)))
    # Tell each moved session that's still working, once, at the end of its turn.
    helper = ensure_room_helper(room)
    alone_note = (f"(Room helper: swarm {from_swarm} has closed — everyone else in it has"
                  " finished or moved on, so you're working alone now. `scripts/peers.py"
                  " list` shows who else is working.)")
    who = "Room helper" if project is None else "Project helper"
    alone_note = alone_note.replace("(Room helper:", f"({who}:", 1)
    tell = ([(c, _move_note(kind, to_swarm, moved, index, recipient=c, who=who), message)
             for c in moved] + [(c, alone_note, "") for c in left_alone])
    _tell_sessions(helper, tell, index)
    made = {"id": move_id, "at": now, "kind": kind, "convs": moved,
            "from_swarm": from_swarm, "to_swarm": to_swarm, "reason": reason,
            "left_alone": left_alone, "target": _target_words(kind, to_swarm, None)}
    # A move made by hand is posted in the helper's chat too; a run posts its own.
    if by != "room_helper":
        _post(helper, _render_move(made, by), now)
    return made


def _move_note(kind, to_swarm, moved, index, recipient=None, who="Room helper"):
    """The facts line under a move's message: where the session is now. For a
    swarm, its number and name, how many others are still working in it, and
    at most three of them by name — a big swarm's full list was noise, and
    `scripts/peers.py swarm` has it."""
    if to_swarm is None:
        return (f"({who}: you're working alone now — out of your old swarm. "
                "`scripts/peers.py list` shows who else is working.)")
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT name FROM swarms WHERE id = ?", (to_swarm,)).fetchone()
    finally:
        conn.close()
    called = f"swarm {to_swarm}" + (f" ({row[0]})" if row and row[0] else "")
    others = [m for m in swarms.overview_members(to_swarm)
              if m != recipient and not swarms.member_retired(index.get(m))]
    if not others:
        return (f"({who}: you're now in {called}. `scripts/peers.py swarm`"
                " shows it.)")
    named = ", ".join(f"{m} ({(index.get(m) or {}).get('title') or m})" for m in others[:3])
    count = f"{len(others)} other session{'s' if len(others) != 1 else ''} still working"
    more = f", among them {named}" if len(others) > 3 else f": {named}"
    return (f"({who}: you're now in {called}, with {count}{more}. "
            "`scripts/peers.py swarm` lists them.)")


def undo(move_id):
    """Put the sessions of one move back where they were before it. Returns
    the move, or raises MoveError (no such move, already undone, or a later
    move of its own family has touched the same sessions or room since — undo
    that one first). A swarm move and a room move are separate families: which
    swarm a session is in and which project room it's in don't overrule each
    other."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT room, kind, convs, before, undone_at, to_swarm FROM room_moves"
                           " WHERE id = ?", (move_id,)).fetchone()
        if row is None:
            raise MoveError(f"no move #{move_id}")
        room, kind, convs, before, undone_at, to_swarm = row
        if undone_at:
            raise MoveError(f"move #{move_id} was already undone at {undone_at}")
        convs = set(json.loads(convs))
        before = json.loads(before)
        later = [i for i, k, c, b in conn.execute(
            "SELECT id, kind, convs, before FROM room_moves WHERE id > ? AND undone_at IS NULL",
            (move_id,))
            if (k in ROOM_KINDS) == (kind in ROOM_KINDS)
            and (convs & set(json.loads(c)) or _same_room(kind, before, k, b))]
    finally:
        conn.close()
    if later:
        raise MoveError(f"move #{later[-1]} moved the same sessions since — undo it first")
    if kind == "place":
        _undo_place(before)
    elif kind == "open":
        before = _undo_open(before)
    elif kind == "close":
        _undo_close(before)
    else:
        swarms.unplace(before, joined=to_swarm if kind == "join" else None)
    now = _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("UPDATE room_moves SET undone_at = ?, before = ? WHERE id = ?",
                     (now, json.dumps(before), move_id))
        conn.execute("COMMIT")
    finally:
        conn.close()
    helper = find_helper(room)
    if helper:
        _post(helper, f"↩ Undid move #{move_id}: its sessions are back where they were.", now)
    return {"id": move_id, "undone_at": now}


def _same_room(kind, before, later_kind, later_before):
    """Did a later room move touch the room this open or close was about? Two
    placements only clash over the same sessions."""
    if kind not in ROOM_KINDS or later_kind not in ROOM_KINDS or {kind, later_kind} == {"place"}:
        return False
    later_before = json.loads(later_before)
    return bool(_rooms_touched(kind, before) & _rooms_touched(later_kind, later_before))


def _rooms_touched(kind, before):
    if kind == "place":
        return {before.get("to"), *(before.get("from") or [])} - {None}
    return {before.get("build")}


# --- Project rooms: placing sessions, opening and closing rooms -----------------------
# The moves above decide which SWARM a session is in. These decide which PROJECT
# ROOM it's in, and which rooms exist. They're recorded in `room_moves` under the
# room's own scope, posted and undoable the same way; what an undo needs goes in
# the move's `before` JSON.

def _room_name(project):
    """A project room's name, whether it's switched on or not."""
    build = buildlist.find(project)
    return build["name"] if build else project


def _record_room_move(room, kind, convs, reason, before):
    """Write down one room move. Returns (its id, when)."""
    now = _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        move_id = conn.execute(
            "INSERT INTO room_moves (at, room, kind, convs, reason, before)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (now, room, kind, json.dumps(convs), reason, json.dumps(before))).lastrowid
        conn.execute("COMMIT")
    finally:
        conn.close()
    return move_id, now


def _room_move_made(move_id, now, kind, convs, reason, before):
    """A room move as `execute` returns a swarm move."""
    return {"id": move_id, "at": now, "kind": kind, "convs": convs, "from_swarm": None,
            "to_swarm": None, "reason": reason, "left_alone": [],
            "target": _target_words(kind, None, before)}


def _undone_before(room, kind):
    """The `before` of each move of this kind she undid in this scope."""
    conn = sqlstore.open_db()
    try:
        return [json.loads(row[0]) for row in conn.execute(
            "SELECT before FROM room_moves WHERE room = ? AND kind = ? AND undone_at IS NOT NULL"
            " ORDER BY id DESC LIMIT 50", (room, kind))]
    finally:
        conn.close()


def place(target, convs, reason="", message="", by=None):
    """Put sessions (with their continuations) into a project room, or out of
    every one (target None), as a recorded move: posted in the room helper's
    chat and in the chats of the rooms they joined or left, each session still
    working told once which room it's in now and who its helper is. Returns
    the move. A placement beats the files from then on (project_rooms.place).

    Making it is this function's job, not deciding it: the room helper's own
    placements go through `propose`, and reach here once approved."""
    import project_rooms
    room = project_rooms.ROOM
    if target is not None and project_rooms.find(target) is None:
        raise MoveError(f"{target!r} isn't a switched-on project room")
    index = store.read("bot_chats/index", {})
    moved = _whole_lines(convs, index, by)
    members = project_rooms.sync(index)
    if all(members.get(c) == target for c in moved):
        raise MoveError("already in " + (_room_name(target) if target else "no project room"))
    if by != "owner" and _was_undone(room, "place", moved):
        raise MoveError("she undid this same move before")
    left = sorted({members.get(c) for c in moved} - {None, target})
    before = {"to": target, "to_name": _room_name(target) if target else None, "from": left,
              "rows": project_rooms.rows(moved)}
    project_rooms.place(target, moved)
    move_id, now = _record_room_move(room, "place", moved, reason, before)
    made = _room_move_made(move_id, now, "place", moved, reason, before)
    text = _render_move(made, by)
    # Post it in the room helper's chat (a run posts its own) and in each
    # project helper's it touched.
    helper = ensure_room_helper(room)
    if by != "room_helper":
        _post(helper, text, now)
    joined = ensure_room_helper(f"{room}:{target}") if target else None
    if joined:
        _post(joined, text, now)
    for project in left:
        losing = find_helper(f"{room}:{project}", index)
        if losing:
            _post(losing, text, now)
    # Tell each moved session which room it's in now, and whose it is.
    facts = (f"(Room helper: you're in the {_room_name(target)} project room now. Its helper,"
             f" `{joined}`, looks after the sessions and swarms in it.)" if target else
             f"(Room helper: you're in no project room now. The {room} room's helper, `{helper}`,"
             " looks after you.)")
    _tell_sessions(helper, [(conv, facts, message) for conv in moved], index)
    return made


def _undo_place(before):
    """Put the moved sessions' rows back, and say so in the rooms it touched."""
    import project_rooms
    project_rooms.restore(before.get("rows") or {})
    for project in _rooms_touched("place", before):
        helper = find_helper(f"{project_rooms.ROOM}:{project}")
        if helper:
            _post(helper, "↩ A placement was undone: its sessions are back where they were.", _now())


def _archive_project_helper(scope):
    """Put a closed room's helper away. Its chat and rules stay on disk."""
    helper = find_helper(scope)
    if helper:
        with store.mutate("bot_chats/index", {}) as index:
            if isinstance(index.get(helper), dict):
                index[helper]["archived"] = _now()
    return helper


def _bring_back_project_helper(scope):
    """Bring back the newest archived helper of this project room, if it has
    one, so a room opened again keeps its helper's chat."""
    with store.mutate("bot_chats/index", {}) as index:
        put_away = sorted((str(entry.get("archived")), conv) for conv, entry in index.items()
                          if is_helper(entry, scope) and entry.get("archived"))
        if put_away and not find_helper(scope, index):
            index[put_away[-1][1]].pop("archived", None)


def open_room(where, name=None, reason="", by=None):
    """Open a project room: a build on the list, or a folder on this machine,
    which is added to the list. Unless the owner asks, it's refused when fewer
    than config.PROJECT_ROOM_MIN_SESSIONS working sessions already work mostly
    in that repo, or when she undid opening this one. The room's helper is made
    at once and its first run started; each session that landed is told.
    Returns the move.

    Prompt: "I want some mechanism for project rooms to be created."
    """
    import project_rooms
    room = project_rooms.ROOM
    build = buildlist.find(where)
    folder = None
    if build is None:
        folder = Path(str(where)).expanduser()
        if not folder.is_absolute():
            raise MoveError(f"no build {where!r} on the list, and that isn't a full folder path")
        if not folder.is_dir():
            raise MoveError(f"no folder at {folder}")
        build = project_rooms.build_at(folder)
        folder = project_rooms.main_checkout(folder)
    root = str(build["root"]) if build else str(folder)
    if build and build["project_room"]:
        raise MoveError(f"{build['name']} is already a project room")
    # Hold the room helper to the floor, and to what she undid.
    if by != "owner":
        if any(b.get("root") == root for b in _undone_before(room, "open")):
            raise MoveError("she undid opening this room before")
        working = project_rooms.working_in(root)
        if len(working) < config.PROJECT_ROOM_MIN_SESSIONS:
            raise MoveError(f"only {len(working)} working session(s) work mostly in {root};"
                            f" a project room takes at least {config.PROJECT_ROOM_MIN_SESSIONS}")
    added = build is None
    if added:
        try:
            build = buildlist.add_folder(root, name)
        except ValueError as e:
            raise MoveError(str(e))
    project_rooms.switch(build["id"], True)
    landed = project_rooms.members(build["id"])
    scope = f"{room}:{build['id']}"
    _bring_back_project_helper(scope)
    project_helper = ensure_room_helper(scope)
    try:
        _spawn(scope, "opened")
    except Exception as e:
        print(f"{_now()} first run of {scope} not started: {e}", file=sys.stderr)
    before = {"build": build["id"], "name": build["name"], "root": root, "added": added,
              "project_room": False}
    move_id, now = _record_room_move(room, "open", landed, reason, before)
    made = _room_move_made(move_id, now, "open", landed, reason, before)
    helper = ensure_room_helper(room)
    if by != "room_helper":
        _post(helper, _render_move(made, by), now)
    index = store.read("bot_chats/index", {})
    facts = (f"(Room helper: the {build['name']} project room just opened, and you're in it. Its"
             f" helper, `{project_helper}`, looks after the sessions and swarms in it.)")
    _tell_sessions(helper, [(conv, facts, "") for conv in landed], index)
    return made


def _undo_open(before):
    """Take a room's opening back: its member rows (kept in the move), the
    flag, its helper, and its place on the list if the opening added it.
    Returns the move's `before` with the rows in it."""
    import project_rooms
    build = before["build"]
    if buildlist.find(build):
        project_rooms.switch(build, False)
    removed = project_rooms.clear(build)
    _archive_project_helper(f"{project_rooms.ROOM}:{build}")
    if before.get("added"):
        buildlist.remove(build)
    return {**before, "removed_rows": removed}


def close_room(project, reason="", by=None):
    """Close a project room: switch it off, keep its member rows in the move
    and delete them, and archive its helper. Its sessions and swarms go back to
    the room helper. Returns the move. The room helper's own closes go through
    `propose`, and reach here once approved."""
    import project_rooms
    room = project_rooms.ROOM
    found = project_rooms.find(project)
    if found is None:
        raise MoveError(f"{project!r} isn't a switched-on project room")
    scope = f"{room}:{project}"
    project_rooms.switch(project, False)
    rows = project_rooms.clear(project)
    before = {"build": project, "name": found["name"], "root": str(found["root"]), "rows": rows}
    move_id, now = _record_room_move(room, "close", sorted(rows), reason, before)
    made = _room_move_made(move_id, now, "close", sorted(rows), reason, before)
    text = _render_move(made, by)
    project_helper = find_helper(scope)
    if project_helper:
        _post(project_helper, text, now)
    _archive_project_helper(scope)
    if by != "room_helper":
        _post(ensure_room_helper(room), text, now)
    return made


def _undo_close(before):
    """Open a closed room again as it was: its rows, its flag, its helper."""
    import project_rooms
    build = before["build"]
    if buildlist.find(build) is None:
        raise MoveError(f"{build} is no longer on the Builds list")
    project_rooms.switch(build, True)
    project_rooms.restore(before.get("rows") or {})
    _bring_back_project_helper(f"{project_rooms.ROOM}:{build}")


# --- Proposals: the room helper assigns, the project helper answers -------------------
# Inside a project room the room helper doesn't move anything itself. It files a
# PROPOSAL, which wakes that room's helper; approving makes the move like any
# other, recorded and undoable, and declining sends the reason back up. The owner
# skips all of this (by="owner"). Unanswered ones lapse (lapse_proposals).
#
# Prompt: "the room helper basically tries to assign it and then the project
# helper approves it or not".

_PROPOSAL_COLUMNS = ("id", "at", "project", "kind", "convs", "swarm", "target", "reason",
                     "message", "proposed_by", "status", "answered_at", "answer_reason", "move_id")


def _proposal_rows(where, params):
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(f"SELECT {', '.join(_PROPOSAL_COLUMNS)} FROM room_proposals {where}",
                            params).fetchall()
    finally:
        conn.close()
    found = [dict(zip(_PROPOSAL_COLUMNS, row)) for row in rows]
    for proposal in found:
        proposal["convs"] = json.loads(proposal["convs"])
    return found


def proposals(project=None, status="open"):
    """Proposals in this state, oldest first: one project room's, or all."""
    where, params = "WHERE status = ?", [status]
    if project is not None:
        where, params = where + " AND project = ?", [status, project]
    return _proposal_rows(where + " ORDER BY id", params)


def _proposal_words(proposal):
    """One proposal as a line."""
    what = proposal["kind"]
    if what == "place":
        what += f" into {_room_name(proposal['target'])}" if proposal["target"] else " out of it"
    if proposal["swarm"] is not None:
        what += f" (swarm {proposal['swarm']})"
    who = f" {', '.join(proposal['convs'])}" if proposal["convs"] else ""
    return f"#{proposal['id']} {what}{who} — {proposal['reason']}"


def proposals_section(project):
    """What a project helper is shown of the proposals waiting on it. It stays
    the same text until a proposal changes, so a growing helper isn't handed
    it again for nothing (helper_chat.write_update)."""
    import project_rooms
    waiting = proposals(project)
    scope = f"{project_rooms.ROOM}:{project}"
    out = ["# Proposals waiting on you", ""]
    if not waiting:
        return "\n".join(out + ["(none)"]) + "\n"
    out += ["The room helper asks these of you. Answer each: `./venv/bin/python3 scripts/room_moves.py"
            f" --room {scope} approve <n>`, or `decline <n> --reason \"…\"` and say why.", ""]
    out += [f"- {_proposal_words(p)}" for p in waiting]
    return "\n".join(out) + "\n"


def _proposal_target(kind, convs, swarm_id, target, index, by):
    """What a proposal is about, checked against the rooms as they are now:
    (the project room whose helper answers it, the sessions with their whole
    lines). A place goes to the room it puts them in, or the room it takes them
    out of; a close to the room closing; a swarm move to the room its sessions
    are in."""
    import project_rooms
    if kind not in PROPOSAL_KINDS:
        raise MoveError(f"unknown proposal {kind!r}")
    if kind == "close":
        if project_rooms.find(target) is None:
            raise MoveError(f"{target!r} isn't a switched-on project room")
        return target, []
    moved = _whole_lines(convs, index, by)
    if kind == "place" and target is not None:
        if project_rooms.find(target) is None:
            raise MoveError(f"{target!r} isn't a switched-on project room")
        return target, moved
    inside = {project_rooms.sync(index).get(c) for c in moved}
    if None in inside or len(inside) != 1:
        raise MoveError("those sessions aren't all in one project room")
    project = inside.pop()
    # A join or split has to name an open swarm of that room: its helper isn't
    # woken for one that can't be made.
    if kind in ("join", "split") and swarm_id not in {
            c["id"] for c in open_swarms(f"{project_rooms.ROOM}:{project}", index)}:
        raise MoveError(f"swarm {swarm_id} isn't an open swarm in the {project} project room")
    return project, moved


def _carry_out(project, kind, convs, swarm_id, target, reason, message, by):
    """Make the move a proposal asks for. Returns the move."""
    import project_rooms
    if kind == "place":
        return place(target, convs, reason, message, by=by)
    if kind == "close":
        return close_room(project, reason, by=by)
    return execute(f"{project_rooms.ROOM}:{project}", kind, convs, swarm_id, reason, message, by=by)


def propose(kind, convs=(), swarm_id=None, target=None, reason="", message="", by=None):
    """Ask a project room's helper to make a move: form, join, split, release,
    place (`target`: where to, None for out of every room) or close (`target`:
    which room). Wakes that helper with it. Returns {"proposal": the row}, or
    {"move": the move} when the owner asked, which skips the exchange. Raises
    MoveError when it's about no one project room, is waiting already, or was
    declined or undone before."""
    import project_rooms
    from routes import observatory
    room = project_rooms.ROOM
    index = store.read("bot_chats/index", {})
    project, moved = _proposal_target(kind, list(convs), swarm_id, target, index, by)
    if by == "owner":
        return {"move": _carry_out(project, kind, moved, swarm_id, target, reason, message, by)}
    # Refuse one that's waiting already, or that was answered no. A lapsed one
    # may be asked again: nobody said no to it.
    same = [p for p in proposals(project) + proposals(project, "declined")
            if p["kind"] == kind and set(p["convs"]) == set(moved) and p["target"] == target]
    for proposal in same:
        if proposal["status"] == "open":
            raise MoveError(f"already waiting on its helper: proposal #{proposal['id']}")
        raise MoveError(f"its helper declined this before (#{proposal['id']}):"
                        f" {proposal['answer_reason']}")
    # Refuse one she undid, as for a move made directly.
    undone = (any(b.get("build") == target for b in _undone_before(room, "close"))
              if kind == "close" else
              _was_undone(room, "place", moved) if kind == "place" else
              _was_undone(f"{room}:{project}", kind, moved))
    if undone:
        raise MoveError("she undid this same move before")
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        number = conn.execute(
            "INSERT INTO room_proposals (at, project, kind, convs, swarm, target, reason, message,"
            " proposed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (_now(), project, kind, json.dumps(moved), swarm_id, target, reason, message,
             by or "cli")).lastrowid
        conn.execute("COMMIT")
    finally:
        conn.close()
    [proposal] = _proposal_rows("WHERE id = ?", (number,))
    scope = f"{room}:{project}"
    text = (f"(Room helper proposes) {_proposal_words(proposal)}\n\nApprove or decline, and say"
            f" why if not: `./venv/bin/python3 scripts/room_moves.py --room {scope} approve"
            f" {number}` or `decline {number} --reason \"…\"`.")
    observatory.peer_send(ensure_room_helper(room), ensure_room_helper(scope), text)
    return {"proposal": proposal}


def _answered(number, status, answer_reason="", move_id=None):
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("UPDATE room_proposals SET status = ?, answered_at = ?, answer_reason = ?,"
                     " move_id = ? WHERE id = ?", (status, _now(), answer_reason, move_id, number))
        conn.execute("COMMIT")
    finally:
        conn.close()


def _open_proposal(scope, number):
    """The open proposal with this number, for this scope's project helper."""
    project = _scope(scope)[1]
    found = _proposal_rows("WHERE id = ?", (number,))
    if not found or found[0]["project"] != project:
        raise MoveError(f"no proposal #{number} for {project or 'this scope'}")
    if found[0]["status"] != "open":
        raise MoveError(f"proposal #{number} is already {found[0]['status']}")
    return found[0]


def approve(scope, number, by=None):
    """A project helper says yes: the move is made like any other, recorded and
    undoable, and the room helper's chat says so. A move that no longer fits
    is refused and the proposal stays open. Returns the move."""
    proposal = _open_proposal(scope, number)
    room = _scope(scope)[0]
    move = _carry_out(proposal["project"], proposal["kind"], proposal["convs"], proposal["swarm"],
                      proposal["target"], proposal["reason"], proposal["message"],
                      by="owner" if by == "owner" else "proposal")
    _answered(number, "approved", move_id=move["id"])
    _post(ensure_room_helper(room), f"Proposal #{number} was approved: move #{move['id']}.", _now())
    return move


def decline(scope, number, reason):
    """A project helper says no, and why: the room helper hears it."""
    from routes import observatory
    proposal = _open_proposal(scope, number)
    _answered(number, "declined", answer_reason=reason)
    observatory.peer_send(ensure_room_helper(scope), ensure_room_helper(_scope(scope)[0]),
                          f"(Project helper for {_room_name(proposal['project'])} declined your"
                          f" proposal) {_proposal_words(proposal)}\n\nWhy: {reason}")
    return proposal


def lapse_proposals(now=None):
    """Lapse every proposal left unanswered past config.ROOM_PROPOSAL_LAPSE_HOURS,
    and tell the room helper. Returns how many. Run on the minute tick."""
    from routes import observatory
    import project_rooms
    cutoff = ((now or datetime.now()) - timedelta(hours=config.ROOM_PROPOSAL_LAPSE_HOURS)
              ).isoformat(timespec="seconds")
    stale = _proposal_rows("WHERE status = 'open' AND at <= ? ORDER BY id", (cutoff,))
    for proposal in stale:
        _answered(proposal["id"], "lapsed")
        try:
            observatory.peer_send(None, ensure_room_helper(project_rooms.ROOM),
                                  f"(Nobody answered your proposal, so it lapsed)"
                                  f" {_proposal_words(proposal)}", mode="queue")
        except (KeyError, ValueError) as e:
            print(f"{_now()} telling of lapsed proposal failed: {e}", file=sys.stderr)
    return len(stale)


# --- One run ------------------------------------------------------------------------

def _call_model(text, room):
    """A room run's call for the room as a whole: its overview and its moves."""
    import project_rooms
    lane, project = _scope(room)
    ladder = (PROJECT_LADDER if project is not None else
              ROOM_LADDER.format(floor=config.PROJECT_ROOM_MIN_SESSIONS)
              if lane == project_rooms.ROOM else "")
    prompt = SYSTEM_PROMPT.format(place=_place_name(room), ladder=ladder,
                                  quiet=f"{config.ROOM_HELPER_QUIET_HOURS:g}")
    return swarm_helper.ask_model(text, prompt, _schema(room))


def _post(helper, text, now, **marks):
    """A line in the room helper's chat, marked as its own post (not a chat
    reply — helper_chat doesn't replay these)."""
    peermail.append_line(store.DATA_DIR / "bot_chats" / f"{helper}.jsonl", {
        "type": "assistant", "timestamp": now, "helper_run": True, "helper_update": True,
        **marks, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})


def closed_line(move):
    """Say plainly that a move closed the swarm it left: the one session still
    working there is on its own now. Empty when it closed nothing."""
    if not move.get("left_alone"):
        return ""
    return (f"That left swarm {move['from_swarm']} with one session still working, so it"
            f" closed: {', '.join(move['left_alone'])} works alone now. Undoing this move"
            " puts the swarm back.")


def _render_move(move, by=None):
    target = move.get("target")
    if not target or move["kind"] in KINDS:
        target = (f"swarm {move['to_swarm']}" if move["to_swarm"] is not None
                  else "working alone")
    who = {"owner": " (by the owner)", "cli": " (by hand)",
           "proposal": " (a proposal, approved)"}.get(by, "")
    return "\n".join(line for line in [
        f"**Move #{move['id']} — {move['kind']}{who}** {', '.join(move['convs'])} → {target}",
        move["reason"], closed_line(move),
        f"Undo: `./venv/bin/python3 scripts/room_moves.py undo {move['id']}`"] if line)


def _render(answer, made, refused, proposed=()):
    lines = ["**The room now**", "", answer.get("overview") or ""]
    if answer.get("solos"):
        lines += ["", "**Working alone**"]
        lines += [f"- `{s.get('conv')}` — {s.get('summary')}" for s in answer["solos"]]
    for move in made:
        lines += ["", _render_move(move)]
    for proposal in proposed:
        lines += ["", f"**Proposed to the {_room_name(proposal['project'])} helper:**"
                      f" {_proposal_words(proposal)}"]
    for move, why in refused:
        lines += ["", f"~~{move.get('kind')} {', '.join(move.get('convs') or [])}~~"
                      f" — not made: {why}"]
    if (answer.get("up") or "").strip():
        lines += ["", f"**Reported up to the room helper:** {answer['up'].strip()}"]
    return "\n".join(lines)


def _run_move(room, move):
    """Carry out one move from a run's answer. Returns (the move, None) when it
    was made, (None, the proposal) when it went to a project helper. The helper
    above the project rooms opens rooms itself, and anything inside a room, or
    placing or closing one, becomes a proposal. Raises MoveError."""
    import project_rooms
    kind = move.get("kind")
    convs = list(move.get("convs") or [])
    reason = (move.get("reason") or "").strip()
    message = (move.get("message") or "").strip()
    lane, project = _scope(room)
    if project is None and lane == project_rooms.ROOM:
        if kind == "open":
            return open_room(move.get("project"), reason=reason, by="room_helper"), None
        if kind in ("place", "close"):
            return None, propose(kind, convs, None, move.get("project"), reason, message,
                                 by="room_helper")["proposal"]
        members = _project_members(room)
        inside = {members.get(c) for c in convs}
        if len(inside) == 1 and None not in inside:
            return None, propose(kind, convs, move.get("swarm"), None, reason, message,
                                 by="room_helper")["proposal"]
    return execute(room, kind, convs, move.get("swarm"), reason, message, by="room_helper"), None


def _report_up(room, helper, words):
    """Send a project helper's report up to the room helper, which wakes it.
    The same words as its last report aren't sent again. Never fails the run."""
    from routes import observatory
    lane, project = _scope(room)
    try:
        observatory.peer_send(helper, ensure_room_helper(lane),
                              f"(Project helper for {_room_name(project)} reports up) {words}")
    except Exception as e:
        print(f"{_now()} report up from {room} failed: {e}", file=sys.stderr)


def run(room, trigger="tick"):
    """Do one room run and write everything down: summaries, the moves made,
    the moves refused. Returns the answer, or raises after recording the error."""
    helper = ensure_room_helper(room)
    # Stamp the sessions' new summaries with when their activity was READ, not
    # when the calls came back: what a session does while the model is thinking
    # is still new to the next run.
    read_at = _now()
    # The files section stands apart from the summaries (edited_files.py).
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    lane, project = _scope(room)
    members = _project_members(room)
    # A project helper's files section lists only its project's sessions.
    shown = index if project is None else {
        c: e for c, e in index.items() if members.get(c) == project}
    text = room_overview(room, activity=True) + "\n" + edited_files.section(lane, shown)
    # Make every call at once: the room's own, and one per session working
    # alone that has done something since its summary was written.
    solos = solo_sessions(room, index, open_swarms(room, index, members), members)
    stored = _stored_summaries(solos)
    jobs = {"room": lambda: _call_model(text, room)}
    for conv in solos:
        summary, summary_at = stored.get(conv, (None, None))
        job = swarm_helper.session_job(conv, index[conv].get("title") or conv,
                                       swarms._status(index[conv]), summary, summary_at)
        if job:
            jobs[conv] = job
    # Read its last report up before this run's is stored, to tell a new one.
    last_up = _last_report_up(room) if project is not None else None
    results = swarm_helper.side_by_side(jobs)
    found, error = results["room"]
    answer, cost = found if found else (None, None)
    summaries, sessions_cost, session_errors = swarm_helper.summarise_sessions(results, solos)
    for problem in session_errors:
        print(f"{_now()} session summary failed — {problem}", file=sys.stderr)
    cost = (float(cost or 0) + sessions_cost) if (cost is not None or sessions_cost) else None
    # The sessions' new summaries ride in the run's record and its chat post.
    if answer:
        answer["solos"] = [{"conv": conv, "summary": summary}
                           for conv, summary in summaries.items()]
    now = _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute(
            "INSERT INTO room_helper_runs (room, at, trigger, input, output, cost_usd, error)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (room, now, trigger, text,
             json.dumps(answer, ensure_ascii=False) if answer else None, cost, error))
        # The new summaries REPLACE the old ones, as the swarm helper's do —
        # stored even when the room's own call failed.
        for conv, summary in summaries.items():
            conn.execute("INSERT OR REPLACE INTO session_summaries (conv, summary,"
                         " summary_at) VALUES (?, ?, ?)", (conv, summary, read_at))
        conn.execute("COMMIT")
    finally:
        conn.close()
    made, refused, proposed = [], [], []
    for move in (answer or {}).get("moves") or []:
        try:
            done, filed = _run_move(room, move)
            if done:
                made.append(done)
            else:
                proposed.append(filed)
        except Exception as e:
            # A move that doesn't fit is reported in the chat, not dropped.
            refused.append((move, str(e)))
    up = ((answer or {}).get("up") or "").strip()
    if project is not None and up and (last_up or (None, None))[1] != up:
        _report_up(room, helper, up)
    log_path = store.DATA_DIR / "bot_chats" / f"{helper}.jsonl"
    if answer:
        _post(helper, _render(answer, made, refused, proposed), now)
    else:
        peermail.append_line(log_path, {"type": "error", "error": error, "ts": now})
    peermail.append_line(log_path, {"type": "result", "subtype": "success" if answer else "error",
                                    "total_cost_usd": cost, "ts": now})
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(helper)
        if isinstance(entry, dict):
            entry["running"] = False
            entry["last_at"] = now
            entry["helper_last_run"] = now
            entry["cost_usd"] = round(float(entry.get("cost_usd") or 0) + float(cost or 0), 6)
            if error:
                entry["last_error"] = error
            else:
                entry.pop("last_error", None)
    if error:
        raise RuntimeError(error)
    return answer


# --- When it runs -----------------------------------------------------------------

def _spawn(room, trigger):
    """Start a run in its own detached process, marking the helper busy."""
    helper = ensure_room_helper(room)
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(helper)
        if not isinstance(entry, dict):
            return False
        entry["running"] = True
        entry["last_at"] = _now()
    log = store.DATA_DIR / "bot_chats" / ".turns" / f"room-helper-{room.replace(':', '-')}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR),
           "EXOCORTEX_CONTENT_DIR": str(store.CONTENT_DIR)}
    with open(log, "ab") as errf:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "run", room, trigger],
                         stdin=subprocess.DEVNULL, stdout=errf, stderr=errf,
                         start_new_session=True, env=env)
    return True


def due(room, index=None):
    """Should the room helper run now? When it's free, its last run is at
    least config.ROOM_HELPER_MIN_SEC old, and some session in the room (not a
    helper) has been active since."""
    from routes import observatory
    index = store.read("bot_chats/index", {}) if index is None else index
    helper = find_helper(room, index)
    entry = index.get(helper) if helper else {}
    if helper and observatory._effective_running(helper, entry):
        return False
    last = entry.get("helper_last_run") or ""
    if last and datetime.now() - datetime.fromisoformat(last) < timedelta(
            seconds=config.ROOM_HELPER_MIN_SEC):
        return False
    helpers = _helper_convs(index)
    lane, project = _scope(room)
    members = _project_members(room)
    return any(isinstance(e, dict) and c not in helpers and (e.get("last_at") or "") > last
               and lanes.derive_lane(e) == lane and members.get(c) == project
               for c, e in index.items())


def tick():
    """The minute tick: run each room's helper that's due. Returns how many
    runs started."""
    import project_rooms
    started = 0
    # Lapse the proposals left unanswered too long; it mustn't stop the runs.
    try:
        lapse_proposals()
    except Exception as e:
        print(f"{_now()} lapsing proposals failed: {e}", file=sys.stderr)
    scopes = list(config.ROOM_HELPER_ROOMS)
    # Each switched-on project room's helper, inside the room that holds them.
    if project_rooms.ROOM in scopes:
        scopes += [f"{project_rooms.ROOM}:{r['id']}" for r in project_rooms.rooms()]
    for room in scopes:
        if due(room) and _spawn(room, "tick"):
            started += 1
    return started


def main(argv):
    if len(argv) >= 3 and argv[1] == "run":
        room, trigger = argv[2], (argv[3] if len(argv) > 3 else "tick")
        try:
            run(room, trigger)
        except Exception as e:
            print(f"{_now()} room helper run for {room} failed: {e}", file=sys.stderr)
            # Never leave the helper looking busy forever.
            with store.mutate("bot_chats/index", {}) as index:
                for entry in index.values():
                    if is_helper(entry, room):
                        entry["running"] = False
            return 1
        return 0
    print("usage: room_helper.py run <room> [trigger]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    # Settle the data dir from the environment before anything caches it.
    if os.environ.get("EXOCORTEX_DATA_DIR"):
        store.DATA_DIR = Path(os.environ["EXOCORTEX_DATA_DIR"])
    sys.exit(main(sys.argv))
