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
  - each session working alone: the summary this helper wrote of it last
    time (`session_summaries`) plus what it has done since,
  - its own last few moves, including the ones she undid.

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

Its chat is a helper chat like a swarm helper's (helper_chat.py): every turn
starts fresh from a rolling seed, whose view of the world is the room overview
(room_overview) instead of one swarm.

When it runs: at the minute tick (tick), at most once every
config.ROOM_HELPER_MIN_SEC, and only when some session in the room has done
something since the last run. Each run is its own detached process
(`python3 room_helper.py run <room>`), one model call.

Touches: swarms.py (placements: place, unplace, new_swarm, line_of_work),
swarm_helper.py (ask_model, the member-activity reader, poke), sqlstore.py
(session_summaries, swarm_pins, room_moves, room_helper_runs), the session
index (the helper's own entry — `role: "room_helper"`), routes/observatory.py
(peer_send, and its chat turns), helper_chat.py, config.py (ROOM_HELPER_*),
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
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import config
import lanes
import peermail
import sqlstore
import store
import swarm_helper
import swarms

ROLE = "room_helper"
KINDS = ("form", "join", "split", "release")

# How much of a solo session's new activity one run reads. Less than a swarm
# member gets: the room helper only needs to know what the work is about.
_SOLO_CHARS = 1500
# How many of its own past moves a run is shown.
_RECENT_MOVES = 10

SYSTEM_PROMPT = """You are the room helper for the {room} room of one person's app, where AI \
coding agents work in sessions. Sessions that message each other form a SWARM, and every swarm \
has its own helper. You sit a layer above: your job is to watch over the sessions that are \
running in the room and coordinate with them when it's needed — mostly by deciding who should \
be working together. You read only summaries. A swarm is at least two sessions still working \
(a session and its own continuations count as one) plus its helper; a swarm that drops to one \
working session closes by itself, and that session shows up below as working alone. Your job:
1. Summarise each session working alone in 1-3 sentences: what it's doing now, what it's \
waiting on. Your summary replaces the old one, so carry forward anything still true.
2. Write a short overview of the room: the swarms, what the solo sessions are doing, anything \
that looks tangled.
3. Make moves, but ONLY when the summaries clearly show one is right:
   - form: two or more sessions working alone on the same thing, or on work that collides \
(same files, same feature) — make them a swarm so they know about each other.
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
4. For every move write the reason (for the owner) and one short message to the moved \
sessions: who they're now working with and why it matters to their work. One message per \
move; don't chat.
Use session ids exactly as given; `swarm` is the swarm id a join or split refers to. Plain \
words; the owner reads everything you write."""

SCHEMA = {
    "type": "object",
    "properties": {
        "overview": {"type": "string"},
        "solos": {"type": "array", "items": {
            "type": "object",
            "properties": {"conv": {"type": "string"}, "summary": {"type": "string"}},
            "required": ["conv", "summary"]}},
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
    "required": ["overview", "solos", "moves"],
}


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _trim(text, cap):
    text = str(text or "").strip()
    return text if len(text) <= cap else "…" + text[-cap:]


# --- The helper's own session ---------------------------------------------------

def is_helper(entry):
    return isinstance(entry, dict) and entry.get("role") == ROLE


def find_helper(room, index=None):
    """The room helper's session id for this room, or None."""
    index = store.read("bot_chats/index", {}) if index is None else index
    return next((conv for conv, entry in index.items()
                 if is_helper(entry) and entry.get("room") == room
                 and not entry.get("archived")), None)


def ensure_room_helper(room):
    """The room helper's Observatory session for this room, made on first need."""
    from routes import observatory
    helper = find_helper(room)
    if helper:
        return helper
    with store.mutate("bot_chats/index", {}) as index:
        helper = find_helper(room, index)
        if helper:
            return helper
        helper = observatory._new_conv_id(index)
        index[helper] = {
            "bot": "helper", "role": ROLE, "room": room,
            "title": f"Room helper · {room.capitalize()}",
            "started": _now(), "last_at": _now(), "claude_session_id": None,
            "cost_usd": 0.0, "journal": False, "lane": room,
            "cwd": str(store.BUILD_DIR), "allowed_tools": list(swarm_helper.HELPER_TOOLS),
        }
    return helper


# --- Who is in the room ------------------------------------------------------------

def _helper_convs(index):
    return {c for c, e in index.items()
            if isinstance(e, dict) and e.get("role") in swarms.HELPER_ROLES}


def open_swarms(room):
    """The swarms in this room it works with: live and not closed. A closed
    swarm (fewer than two sessions still working, swarms.is_closed) is left
    out of what it reads and can't be joined or split — there's no one left
    in it to coordinate with each other, and its one working session, if any,
    is listed as working alone (solo_sessions). It comes back here by itself
    when a second session works in it again."""
    return [c for c in swarms.overview() if c["lane"] == room and not c.get("closed")]


def solo_sessions(room, index, cards):
    """The live sessions in this room working alone: not archived, finished or
    handed on, not a helper, and in none of these (open) swarms — so the last
    working session of a closed swarm is here too. Newest first."""
    in_swarm = {m["conv"] for card in cards for m in card["members"]}
    helpers = _helper_convs(index)
    found = [(entry.get("last_at") or "", conv) for conv, entry in index.items()
             if isinstance(entry, dict) and conv not in in_swarm and conv not in helpers
             and not swarms.member_retired(entry) and lanes.derive_lane(entry) == room]
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
            "SELECT id, at, kind, convs, from_swarm, to_swarm, reason, undone_at"
            " FROM room_moves WHERE room = ? ORDER BY id DESC LIMIT ?", (room, limit)).fetchall()
    finally:
        conn.close()
    return [{"id": i, "at": at, "kind": kind, "convs": json.loads(convs), "from_swarm": f,
             "to_swarm": t, "reason": reason, "undone_at": undone}
            for i, at, kind, convs, f, t, reason, undone in rows]


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
    return f"`{conv}` {entry.get('title') or conv} — {state}, last active {entry.get('last_at') or '?'}"


def room_overview(room, activity=False):
    """The room as the room helper sees it, as one markdown document: every
    live swarm with its summaries and clusters, every session working alone,
    and the recent moves. With `activity`, each solo session also carries
    what it has done since its summary — that's a run's input; the chat's
    seed leaves it out."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    cards = open_swarms(room)
    since = (datetime.now() - timedelta(hours=config.ROOM_HELPER_QUIET_HOURS)
             ).isoformat(timespec="seconds")
    out = [f"# The {room} room, {_now()}", "", "## Swarms", ""]
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
    solos = solo_sessions(room, index, cards)
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
    out += ["## Your recent moves", ""]
    moves = recent_moves(room)
    for move in moves:
        undone = (f" — SHE UNDID THIS at {move['undone_at']}; don't redo it"
                  if move["undone_at"] else "")
        target = move["to_swarm"] if move["kind"] in ("form", "join", "split") else "alone"
        out.append(f"- #{move['id']} {move['at']} {move['kind']} {', '.join(move['convs'])}"
                   f" → {target}: {move['reason']}{undone}")
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


def execute(room, kind, convs, swarm_id=None, reason="", message="", by=None):
    """Make one move: place the sessions (with their continuations), record
    it so it can be undone, tell each moved session, and wake the helpers of
    the swarms it touched. Returns the stored move as a dict. Raises
    MoveError when the move doesn't fit the room as it is now."""
    from routes import observatory
    if kind not in KINDS:
        raise MoveError(f"unknown move {kind!r}")
    index = store.read("bot_chats/index", {})
    unknown = [c for c in convs if not isinstance(index.get(c), dict)]
    if unknown or not convs:
        raise MoveError(f"no such session: {', '.join(unknown) or '(none given)'}")
    if _helper_convs(index) & set(convs):
        raise MoveError("helpers can't be moved")
    # A line of work moves whole: its continuations would re-link it otherwise.
    moved = set()
    for conv in convs:
        moved |= swarms.line_of_work(conv, index)
    moved = sorted(moved)
    # Where each session is now: its swarm only while that swarm is open. A
    # closed swarm's one working session is working alone (swarms.is_closed).
    open_ids = {c["id"] for c in swarms.overview() if not c.get("closed")}
    live = {c["id"]: c for c in open_swarms(room)}
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
            raise MoveError(f"swarm {swarm_id} isn't an open swarm in the {room} room")
        if all(current[c] == swarm_id for c in moved):
            raise MoveError(f"already in swarm {swarm_id}")
        from_swarm = next((s for s in current.values() if s), None)
    elif kind == "split":
        # One working line of work leaving on its own isn't a swarm: that's a release.
        if working_lines < 2:
            return execute(room, "release", convs, None, reason, message, by)
        if swarm_id not in live:
            raise MoveError(f"swarm {swarm_id} isn't an open swarm in the {room} room")
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
        to_swarm = swarms.new_swarm(room)
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
    note = _move_note(kind, to_swarm, moved, index)
    alone_note = (f"(Room helper: swarm {from_swarm} has closed — everyone else in it has"
                  " finished or moved on, so you're working alone now. `scripts/peers.py"
                  " list` shows who else is working.)")
    tell = [(c, note, message) for c in moved] + [(c, alone_note, "") for c in left_alone]
    for conv, facts, words in tell:
        if swarms.member_retired(index.get(conv)):
            continue
        text = "\n\n".join(t for t in ((words or "").strip(), facts) if t)
        try:
            observatory.peer_send(helper, conv, text, mode="queue")
        except (KeyError, ValueError) as e:
            print(f"{_now()} room move message to {conv} failed: {e}", file=sys.stderr)
    made = {"id": move_id, "at": now, "kind": kind, "convs": moved,
            "from_swarm": from_swarm, "to_swarm": to_swarm, "reason": reason,
            "left_alone": left_alone}
    # A move made by hand is posted in the helper's chat too; a run posts its own.
    if by != "room_helper":
        _post(helper, _render_move(made, by), now)
    return made


def _move_note(kind, to_swarm, moved, index):
    """The facts line under a move's message: where the session is now."""
    if to_swarm is None:
        return ("(Room helper: you're working alone now — out of your old swarm. "
                "`scripts/peers.py list` shows who else is working.)")
    others = [m for m in swarms.overview_members(to_swarm)
              if not swarms.member_retired(index.get(m))]
    names = ", ".join(f"{m} ({(index.get(m) or {}).get('title') or m})" for m in others)
    return (f"(Room helper: you're now in swarm {to_swarm}, with {names}. "
            "`scripts/peers.py swarm` shows it.)")


def undo(move_id):
    """Put the sessions of one move back where they were before it. Returns
    the move, or raises MoveError (no such move, already undone, or a later
    move has moved the same sessions since — undo that one first)."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT room, convs, before, undone_at FROM room_moves WHERE id = ?",
                           (move_id,)).fetchone()
        if row is None:
            raise MoveError(f"no move #{move_id}")
        room, convs, before, undone_at = row
        if undone_at:
            raise MoveError(f"move #{move_id} was already undone at {undone_at}")
        convs = set(json.loads(convs))
        later = [i for i, c in conn.execute(
            "SELECT id, convs FROM room_moves WHERE id > ? AND undone_at IS NULL", (move_id,))
            if convs & set(json.loads(c))]
    finally:
        conn.close()
    if later:
        raise MoveError(f"move #{later[-1]} moved the same sessions since — undo it first")
    swarms.unplace(json.loads(before))
    now = _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("UPDATE room_moves SET undone_at = ? WHERE id = ?", (now, move_id))
        conn.execute("COMMIT")
    finally:
        conn.close()
    helper = find_helper(room)
    if helper:
        _post(helper, f"↩ Undid move #{move_id}: its sessions are back where they were.", now)
    return {"id": move_id, "undone_at": now}


# --- One run ------------------------------------------------------------------------

def _call_model(text, room):
    """A room run's model call."""
    prompt = SYSTEM_PROMPT.format(room=room, quiet=f"{config.ROOM_HELPER_QUIET_HOURS:g}")
    return swarm_helper.ask_model(text, prompt, SCHEMA)


def _post(helper, text, now, **marks):
    """A line in the room helper's chat, marked as its own post (not a chat
    reply — helper_chat leaves these to the room overview)."""
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
    target = (f"swarm {move['to_swarm']}" if move["to_swarm"] is not None
              else "working alone")
    who = {"owner": " (by the owner)", "cli": " (by hand)"}.get(by, "")
    return "\n".join(line for line in [
        f"**Move #{move['id']} — {move['kind']}{who}** {', '.join(move['convs'])} → {target}",
        move["reason"], closed_line(move),
        f"Undo: `./venv/bin/python3 scripts/room_moves.py undo {move['id']}`"] if line)


def _render(answer, made, refused):
    lines = ["**The room now**", "", answer.get("overview") or ""]
    if answer.get("solos"):
        lines += ["", "**Working alone**"]
        lines += [f"- `{s.get('conv')}` — {s.get('summary')}" for s in answer["solos"]]
    for move in made:
        lines += ["", _render_move(move)]
    for move, why in refused:
        lines += ["", f"~~{move.get('kind')} {', '.join(move.get('convs') or [])}~~"
                      f" — not made: {why}"]
    return "\n".join(lines)


def run(room, trigger="tick"):
    """Do one room run and write everything down: summaries, the moves made,
    the moves refused. Returns the answer, or raises after recording the error."""
    helper = ensure_room_helper(room)
    text = room_overview(room, activity=True)
    answer, cost, error = None, None, None
    try:
        answer, cost = _call_model(text, room)
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        error = str(e)
    now = _now()
    index = store.read("bot_chats/index", {})
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute(
            "INSERT INTO room_helper_runs (room, at, trigger, input, output, cost_usd, error)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (room, now, trigger, text,
             json.dumps(answer, ensure_ascii=False) if answer else None, cost, error))
        # The new summaries REPLACE the old ones, as the swarm helper's do.
        for solo in (answer or {}).get("solos") or []:
            if isinstance(index.get(solo.get("conv")), dict) and solo.get("summary"):
                conn.execute("INSERT OR REPLACE INTO session_summaries (conv, summary,"
                             " summary_at) VALUES (?, ?, ?)", (solo["conv"], solo["summary"], now))
        conn.execute("COMMIT")
    finally:
        conn.close()
    made, refused = [], []
    for move in (answer or {}).get("moves") or []:
        try:
            made.append(execute(room, move.get("kind"), list(move.get("convs") or []),
                                move.get("swarm"), (move.get("reason") or "").strip(),
                                (move.get("message") or "").strip(), by="room_helper"))
        except Exception as e:
            # A move that doesn't fit is reported in the chat, not dropped.
            refused.append((move, str(e)))
    log_path = store.DATA_DIR / "bot_chats" / f"{helper}.jsonl"
    if answer:
        _post(helper, _render(answer, made, refused), now)
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
    log = store.DATA_DIR / "bot_chats" / ".turns" / f"room-helper-{room}.log"
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
    return any(isinstance(e, dict) and c not in helpers and (e.get("last_at") or "") > last
               and lanes.derive_lane(e) == room for c, e in index.items())


def tick():
    """The minute tick: run each room's helper that's due. Returns how many
    runs started."""
    started = 0
    for room in config.ROOM_HELPER_ROOMS:
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
                    if is_helper(entry) and entry.get("room") == room:
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
