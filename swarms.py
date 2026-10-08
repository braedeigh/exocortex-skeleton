"""Swarms — groups of agent sessions that have talked to each other.

**What this is, in plain English.** When agents message each other through the
mailbox (peermail.py), they form groups: any two sessions that have had a
real BACK-AND-FORTH are linked, and everything linked together — directly or
through someone else — is one swarm. Not everyone in a swarm has to have
talked to everyone; one conversation with one other member is enough to join.
But it has to be a conversation: at least LINK_MESSAGES (three) messages
between the two, with at least one each way — a message, an answer and a
follow-up. A heads-up about a shared file links nobody, answered with a
"thanks" or not (her calls: "both ways", then the three-message rule). A
session and its continuations count as one sender, so a reply from the
session that took over still answers. A session
that continued itself (a fresh session taking over when the old one's context
filled up) stays in its parent's swarm — but a handoff is not a conversation:
a session and its own continuation, with no message between them and anyone
else, are one line of work, not a swarm, and get no swarm of their own.

A swarm keeps its identity as it grows: the same number, the same name, the
same helper, even as new members join. When two swarms get linked, the older
one absorbs the younger (its row is kept, marked `merged_into`), so nothing a
helper wrote is lost. Left to itself, membership only grows — a session that
stops talking is still part of the swarm it worked in.

The one thing that overrides the messages is a PLACEMENT (`swarm_pins`), made
by the room helper (room_helper.py) when it forms, joins, splits or releases
swarms. A session placed at time T is no longer linked by any message it
exchanged at or before T; it belongs where it was placed (or nowhere, when
released), and only messages sent after T can pull it anywhere else. That's
how a swarm glued together by one old stray message comes apart.

A swarm is at least TWO sessions still working, plus its helper. It CLOSES
the moment fewer than two of its lines of work are live (`is_closed`): a
member that finished — done, archived, or handed on — doesn't count, the
helper doesn't count, and a session with its continuations counts once. So a
swarm whose other members retired, or were released, closes and its last
working session is back to working alone: the pages hide the closed swarm and
show that session as an ordinary card, and the room helper reads it as a solo
session. It opens again, the same swarm, the moment a second line of work is
live in it — a member working again, or a new session messaging or joining
it. Closed is worked out from the members each time, not stored; `overview`
marks each card `closed`.

Prompt: "i don't necessarily want a swarm to be just 1 agent and the helper.
i want a swarm to be a minimum of 2 sessions and a helper."

She can also start a session straight into a swarm (the '+' on a swarm's
page): `join` adds it as a member before it has messaged anyone, and
`seed_text` is what it's told about the swarm it woke up in.

A swarm can be sorted into TOPICS (`swarm_topics`, and `topic_id` on each
member): named groups of members doing the same piece of work, for a swarm
that holds more than one. Everyone stays a member of the one swarm; a topic
only says who reads together. The room helper does the sorting
(room_helper.sort_topic, through `set_topic` here) and the swarm's helper
writes each topic a short summary. A continuation is read as in its parent's
topic until it is sorted itself.

Prompt: "Can you make it such that there are sub swarms by topic?"

This file only works out who belongs where and stores it. Naming the swarm and
summarising its members is the helper's job (docs/swarms.md, stage 4).

Touches: sqlstore.py (the `swarms`, `swarm_members`, `swarm_topics`,
`swarm_helper_runs`, `swarm_closings` and `swarm_pins` tables), the `agent_messages` table (peermail.py), room_helper.py
(which makes the placements, through `place`), the session index
(bot_chats/index — lanes and spinoff lineage), tests/test_swarms.py.
Design and decisions: docs/swarms.md.

Prompt that produced this: "it defines its own project based on 2 or more
agents interacting, and they don't all have to be interacting with all the
other agents, just 1 other."
"""
from collections import Counter
from datetime import datetime, timedelta

import lanes
import sqlstore
import store


# The helper sessions: a swarm's own, the room's (room_helper.py) and the
# Linear helper (linear_feed.py). They
# message everyone they watch, so their messages never link anybody.
HELPER_ROLES = ("swarm_helper", "room_helper", "linear_helper")


# How many messages two sessions must have exchanged, with at least one each
# way, before they are linked (links).
LINK_MESSAGES = 3


def _now():
    return datetime.now().isoformat(timespec="seconds")


def pins(conn):
    """Every placement, as {conv: (swarm_id or None, at)}."""
    return {conv: (swarm_id, at) for conv, swarm_id, at in
            conn.execute("SELECT conv, swarm_id, at FROM swarm_pins")}


def _superseded(swarm_id, conv, joined_at, placed):
    """Is this stored membership overruled by a later placement elsewhere?
    A row that joined after the placement stands: new messages put it there."""
    pin = placed.get(conv)
    return bool(pin) and pin[0] != swarm_id and (joined_at or "") <= pin[1]


def groups(links):
    """Every connected group of two or more, from a list of (a, b) links.
    This is a union-find: each session points at a representative, and two
    linked sessions end up sharing one."""
    parent = {}

    def root(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]    # path halving keeps chains short
            x = parent[x]
        return x

    for a, b in links:
        if a and b and a != b:
            parent[root(a)] = root(b)
    found = {}
    for x in list(parent):
        found.setdefault(root(x), set()).add(x)
    return [members for members in found.values() if len(members) >= 2]


def links(conn, index):
    """Who is linked to whom, as two lists: every pair that has had a
    back-and-forth (delivered or not — sending is the interaction), and every
    session paired with the continuation that took over from it.

    A pair needs LINK_MESSAGES messages between them, at least one EACH way:
    a message, an answer and a follow-up. A heads-up links nobody, whether
    or not it got a "thanks": that is not working together. A session and
    its continuations are one sender here (`line`), so an answer from the
    session that took over counts.

    Placements (swarm_pins) bend both lists. A message is left out when it
    came at or before the placement of either end. And the
    sessions placed into the same live swarm are linked to each other, and to
    one of the swarm's other members — that's what holds a swarm the room
    helper made together before its members have said a word."""
    # A helper talks to every session it watches but works with none of
    # them — linking through it would make a swarm out of nothing.
    helpers = {c for c, e in index.items()
               if isinstance(e, dict) and e.get("role") in HELPER_ROLES}
    placed = pins(conn)

    def cut(conv, last):
        pin = placed.get(conv)
        return bool(pin) and (last or "") <= pin[1]

    sent = [(a, b, count) for a, b, last, count in conn.execute(
        "SELECT from_conv, to_conv, MAX(at), COUNT(*) FROM agent_messages"
        " WHERE kind = 'A' AND status != 'cancelled' AND from_conv IS NOT NULL"
        " GROUP BY from_conv, to_conv")
        if a not in helpers and b not in helpers and not cut(a, last) and not cut(b, last)]
    # Keep only the pairs that had a back-and-forth, counting a session and
    # its continuations as one sender: each session is named by the first
    # session of its line of work, and a pair stays when both lines wrote and
    # there were LINK_MESSAGES messages between them.
    parent = {c: e.get("spawned_from") for c, e in index.items()
              if isinstance(e, dict) and e.get("spawned_via") == "continue"}

    def line(conv):
        seen = {conv}
        while parent.get(conv) and parent[conv] not in seen:
            conv = parent[conv]
            seen.add(conv)
        return conv

    ways = Counter()
    for a, b, count in sent:
        ways[line(a), line(b)] += count
    talked = [(a, b) for a, b, _ in sent
              if line(a) != line(b) and ways[line(b), line(a)]
              and ways[line(a), line(b)] + ways[line(b), line(a)] >= LINK_MESSAGES]
    # Placed sessions: chained to each other and to one member of their swarm.
    by_swarm = {}
    for conv, (swarm_id, _) in placed.items():
        if swarm_id is not None:
            by_swarm.setdefault(swarm_id, []).append(conv)
    for swarm_id, convs in by_swarm.items():
        live = conn.execute("SELECT 1 FROM swarms WHERE id = ? AND merged_into IS NULL",
                            (swarm_id,)).fetchone()
        if not live:
            continue
        anchor = next((conv for conv, joined in conn.execute(
            "SELECT conv, joined_at FROM swarm_members WHERE swarm_id = ?"
            " ORDER BY joined_at, conv", (swarm_id,))
            if conv not in convs and not _superseded(swarm_id, conv, joined, placed)), None)
        chain = sorted(convs) + ([anchor] if anchor else [])
        talked += list(zip(chain, chain[1:]))
    continued = [(entry["spawned_from"], conv_id) for conv_id, entry in index.items()
                 if isinstance(entry, dict) and entry.get("spawned_via") == "continue"
                 and entry.get("spawned_from")
                 and entry["spawned_from"] not in helpers and conv_id not in helpers]
    return talked, continued


def found_groups(talked, continued):
    """The swarms that should exist: groups joined by messages, with each
    continuation chain riding along with its parent. A group held together
    by handoffs alone is left out — nobody in it talked to anybody."""
    talkers = {conv for pair in talked for conv in pair}
    return [members for members in groups(talked + continued) if members & talkers]


def _majority_lane(members, index):
    """The room a swarm's card sits in: the room most of its members are in."""
    counts = Counter(lanes.derive_lane(index.get(m) or {}) for m in members)
    return counts.most_common(1)[0][0] if counts else "orchestra"


class _WriteNeeded(Exception):
    """Raised by sync's dry pass the moment it finds something to write."""


def sync():
    """Bring the stored swarms up to date with who has talked to whom.
    Returns the live swarms as {id: set(members)}. Cheap — one query and a
    walk over a few hundred sessions — so it's safe to run whenever a
    message is sent or a page asks.

    Every swarms page and every peer message runs this, and nearly always
    nothing has changed, so it looks before it locks: a dry pass reads the
    stored swarms without the write lock and stops at the first thing it
    would write. Only then is the lock taken and the same pass run for real.
    Queueing for the lock on every page read is what made the swarms pages
    fail with "database is locked" whenever a slow writer held it."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    conn = sqlstore.open_db()
    try:
        found = found_groups(*links(conn, index))
        placed = pins(conn)
        try:
            live = _reconcile(conn, [set(m) for m in found], placed, index, dry=True)
        except _WriteNeeded:
            sqlstore.begin_immediate(conn)
            try:
                live = _reconcile(conn, found, placed, index, dry=False)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
    finally:
        conn.close()
    _archive_helpers(set(live))
    return live


def _reconcile(conn, found, placed, index, dry):
    """Make the stored swarms match the groups found; returns the live ones.
    With `dry`, nothing is written: it raises _WriteNeeded at the first write
    it would make, and returns normally only when the store already matches.
    `found` is changed in place, so a dry pass must be given a copy."""
    now = _now()

    def write(sql, params):
        if dry:
            raise _WriteNeeded
        return conn.execute(sql, params)

    lanes_stored = dict(conn.execute("SELECT id, lane FROM swarms WHERE merged_into IS NULL"))
    stored = {}
    for swarm_id, conv, joined in conn.execute(
            "SELECT m.swarm_id, m.conv, m.joined_at FROM swarm_members m"
            " JOIN swarms s ON s.id = m.swarm_id"
            " WHERE s.merged_into IS NULL").fetchall():
        # A placement elsewhere takes the session out of this swarm.
        if _superseded(swarm_id, conv, joined, placed):
            write("DELETE FROM swarm_members WHERE swarm_id = ? AND conv = ?",
                  (swarm_id, conv))
            continue
        stored.setdefault(swarm_id, set()).add(conv)
    live = {}
    for members in found:
        # Which stored swarms this group already covers. None: a new
        # swarm. One: it grew. Several: they've been linked — the
        # oldest (lowest id) absorbs the rest.
        overlap = sorted(sid for sid, have in stored.items() if have & members)
        if overlap:
            keep = overlap[0]
            for gone in overlap[1:]:
                write("UPDATE swarms SET merged_into = ?, updated_at = ?"
                      " WHERE id = ?", (keep, now, gone))
                members |= stored.pop(gone)
        else:
            keep = write(
                "INSERT INTO swarms (created_at, updated_at, lane) VALUES (?, ?, ?)",
                (now, now, _majority_lane(members, index))).lastrowid
            stored[keep] = set()
        # Membership only grows (see the top of the file) — except
        # by a placement, which already took its rows out above.
        members |= stored[keep]
        joining = members - stored[keep]
        for conv in joining:
            write("INSERT OR IGNORE INTO swarm_members (swarm_id, conv,"
                  " joined_at) VALUES (?, ?, ?)", (keep, conv, now))
        # Restamp the swarm only when something about it changed, so
        # updated_at — what the cards are ordered by — means "last changed".
        lane = _majority_lane(members, index)
        if joining or lane != lanes_stored.get(keep):
            write("UPDATE swarms SET lane = ?, updated_at = ? WHERE id = ?",
                  (lane, now, keep))
        stored[keep] = members
        live[keep] = members
    # Dissolve any stored swarm no group covers any more. That's a
    # swarm formed by a handoff alone (before handoffs stopped making
    # swarms), or one whose only message was cancelled: there was
    # never a conversation, so its rows go, helper summaries and closing
    # summaries with them.
    for gone in set(stored) - set(live):
        write("UPDATE swarms SET merged_into = NULL, updated_at = ?"
              " WHERE merged_into = ?", (now, gone))
        write("DELETE FROM swarm_helper_runs WHERE swarm_id = ?", (gone,))
        write("DELETE FROM swarm_closings WHERE swarm_id = ?", (gone,))
        write("DELETE FROM swarm_members WHERE swarm_id = ?", (gone,))
        write("DELETE FROM swarm_topics WHERE swarm_id = ?", (gone,))
        write("DELETE FROM swarms WHERE id = ?", (gone,))
    return live


def _archive_helpers(live_ids):
    """Archive the helper session of every swarm that no longer stands on its
    own — absorbed into another, or dissolved — so it stops sitting in the
    room as if it still had a swarm to watch. A helper mid-run is left for
    the next sync."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    retire = {conv for conv, entry in index.items()
              if isinstance(entry, dict) and entry.get("role") == "swarm_helper"
              and entry.get("swarm_id") not in live_ids
              and not entry.get("archived") and not entry.get("running")}
    if not retire:
        return
    with store.mutate("bot_chats/index", {}) as index:
        for conv in retire:
            if isinstance(index.get(conv), dict):
                index[conv]["archived"] = _now()
                index[conv].pop("helper_pending", None)


def _status(entry):
    """The three states the Orchestra cards use, plus silent: working (a turn
    is running), needs input (it asked her something), silent (neither)."""
    if entry.get("awaiting_input"):
        return "needs_input"
    if entry.get("running"):
        return "working"
    return "silent"


def member_retired(entry):
    """Is this member finished with the swarm? True when it said it was done
    (`done_at`, scripts/session_done.py), was closed or archived, handed its
    work on to a continuation, or is gone from the index altogether — and it
    isn't in the middle of a turn."""
    if not isinstance(entry, dict):
        return True
    if entry.get("running"):
        return False
    return bool(entry.get("done_at") or entry.get("archived") or entry.get("continued_by"))


def finished_at(entry):
    """When a member was last heard from or put away: the latest of its last
    activity, its done mark and its archiving. None when there's nothing to go
    on (it's gone from the index)."""
    if not isinstance(entry, dict):
        return None
    stamps = [entry.get(k) for k in ("last_at", "done_at", "archived")]
    stamps = [str(v)[:19] for v in stamps if isinstance(v, str) and v]
    return max(stamps) if stamps else None


def helper_role(conv_id, index):
    """Which kind of helper this session is (one of HELPER_ROLES), or None
    when it isn't one. Helpers could once be handed off like any Coding
    session, and the successor ("Swarm helper · … (cont.)") carries no role of
    its own, so the handoff chain (spawned_from) is walked back to find one."""
    seen = set()
    while conv_id and conv_id not in seen:
        seen.add(conv_id)
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return None
        if entry.get("role") in HELPER_ROLES:
            return entry["role"]
        if entry.get("spawned_via") != "continue":
            return None
        conv_id = entry.get("spawned_from")
    return None


def is_helper_session(conv_id, index):
    """Is this a helper session — a swarm's, the room's or Linear's
    (HELPER_ROLES) — or a continuation of one (helper_role)?"""
    return helper_role(conv_id, index) is not None


def in_helper_view(members, index, now=None):
    """Which members the swarm helper still checks: everyone except the ones
    that finished (member_retired) more than config.SWARM_HELPER_FORGET_HOURS
    ago, and except old helper sessions (is_helper_session). Returns (kept,
    dropped) — lists of the same member dicts or ids it was given. The dropped
    are still members (the swarm's closing check and the pages count them);
    the helper just stops rereading them every run. Old helpers are in
    neither list: the helper never reads them at all, not even their names —
    their summaries were only ever retellings of the swarm.

    Prompt: "for the helper session, i don't want it to read and receive
    summaries from the retired helpers anymore"."""
    import config
    cutoff = ((now or datetime.now()) - timedelta(hours=config.SWARM_HELPER_FORGET_HOURS)
              ).isoformat(timespec="seconds")
    kept, dropped = [], []
    for m in members:
        conv = m["conv"] if isinstance(m, dict) else m
        if is_helper_session(conv, index):
            continue
        entry = index.get(conv)
        stamp = finished_at(entry)
        if member_retired(entry) and (stamp is None or stamp < cutoff):
            dropped.append(m)
        else:
            kept.append(m)
    return kept, dropped


def is_live(swarm_id):
    """Does this swarm still stand on its own — stored, and not merged into
    another?"""
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT merged_into FROM swarms WHERE id = ?",
                           (swarm_id,)).fetchone()
    finally:
        conn.close()
    return row is not None and row[0] is None


def retired(swarm_id, index=None):
    """Has the swarm closed — is it a live swarm with members, fewer than two
    of whose lines of work are still going (is_closed)? That's the moment its
    helper writes its closing summary (swarm_helper.close_out). A swarm that was
    merged into another, dissolved, or has no members is not "retired": it
    never finished, it stopped existing."""
    if index is None:
        index = store.read("bot_chats/index", {})
    if not is_live(swarm_id):
        return False
    members = overview_members(swarm_id)
    return bool(members) and is_closed(members, index)


def live_lines(members, index):
    """The lines of work among these members that are still going: each a
    frozenset of a session and its continuations (line_of_work), counted
    once however many of them are members. Old helper sessions
    (is_helper_session) don't make a line live.

    A line is going while ANY session in it is unfinished (member_retired),
    member or not. A session that hands its work on is finished the moment it
    does, and its continuation is made a member only at the next sync: judged
    by members alone, a swarm read as closed in that gap and its helper wrote
    a closing summary for work that was still going."""
    lines = {frozenset(line_of_work(m, index)) for m in members
             if not is_helper_session(m, index)}
    return {line for line in lines
            if any(not member_retired(index.get(conv)) for conv in line)}


def is_closed(members, index):
    """Is a swarm of these members closed — fewer than two lines of work still
    going (live_lines)? A swarm is two sessions working together; one left on
    its own is working alone, and the swarm's helper can't make up the second."""
    return len(live_lines(members, index)) < 2


def overview():
    """Every live swarm as a card needs it: name, room, summary, member
    count by state, the members with their own summaries, and who is joined
    to whom (messages sent, continuations, and the helper's messages out to
    members) for the network drawing.

    Each card says whether the swarm is `closed`: fewer than two of its
    lines of work are still going (is_closed, the same rule as `retired`).
    That is read fresh from the members every time, never stored, so a second
    line of work going again — a member starting again, or a new one joining
    — opens the swarm again by itself. Closed swarms are still listed; the
    pages and the room helper choose to leave them out, and a closed swarm's
    one working session then stands in the room as working alone.

    Each card carries its `topics` (the ones with members), and each member
    the `topic_id` it reads under, or None when it isn't sorted."""
    sync()
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    # Which sessions have handed their work on to a successor (continuation):
    # with the archived ones, these are the swarm's retired members.
    handed_on = {e.get("spawned_from") for e in index.values()
                 if isinstance(e, dict) and e.get("spawned_via") == "continue"}
    conn = sqlstore.open_db()
    try:
        swarms = conn.execute(
            "SELECT id, name, lane, helper_conv, summary, summary_at, created_at"
            " FROM swarms WHERE merged_into IS NULL ORDER BY updated_at DESC").fetchall()
        out = []
        for sid, name, lane, helper, summary, summary_at, created in swarms:
            members = []
            counts = Counter()
            for conv, joined, msummary, msummary_at, topic_id in conn.execute(
                    "SELECT conv, joined_at, summary, summary_at, topic_id FROM swarm_members"
                    " WHERE swarm_id = ? ORDER BY joined_at, conv", (sid,)):
                entry = index.get(conv) if isinstance(index.get(conv), dict) else {}
                state = _status(entry)
                counts[state] += 1
                members.append({"conv": conv, "title": entry.get("title") or conv,
                                "lane": lanes.derive_lane(entry), "state": state,
                                "retired": bool(entry.get("archived")) or conv in handed_on,
                                "joined_at": joined, "summary": msummary,
                                "summary_at": msummary_at, "topic_id": topic_id})
            # Leave out a swarm with no members at all. Every one was placed
            # somewhere else (a room helper release or split), and sync can't
            # dissolve what it no longer sees members of, so the row stays;
            # it's kept, with its helper's runs, but there's nothing to draw.
            if not members:
                continue
            topics = _read_topics(conn, sid, members, index)
            # Which member took over from which: a continuation remembers
            # its parent (spawned_from), and both are members.
            member_ids = {m["conv"] for m in members}
            continues = []
            for m in members:
                entry = index.get(m["conv"]) or {}
                if (entry.get("spawned_via") == "continue"
                        and entry.get("spawned_from") in member_ids):
                    continues.append({"from": entry["spawned_from"], "to": m["conv"]})
            talked = conn.execute(
                "SELECT from_conv, to_conv, COUNT(*) FROM agent_messages"
                " WHERE kind = 'A' AND status != 'cancelled'"
                " AND from_conv IN (SELECT conv FROM swarm_members WHERE swarm_id = ?)"
                " GROUP BY from_conv, to_conv", (sid,)).fetchall()
            # What the helper has sent each member: its threads out to them.
            # A swarm can have had more than one helper session (a retired
            # one's successor), so all of its helpers' messages count, and
            # they're drawn from the one helper seat.
            helpers = {c for c, e in index.items()
                       if isinstance(e, dict) and e.get("role") == "swarm_helper"
                       and e.get("swarm_id") == sid} | ({helper} if helper else set())
            helper_sent = Counter()
            if helpers:
                marks = ",".join("?" * len(helpers))
                for to, n in conn.execute(
                        "SELECT to_conv, COUNT(*) FROM agent_messages"
                        " WHERE kind = 'A' AND status != 'cancelled'"
                        f" AND from_conv IN ({marks}) GROUP BY to_conv", tuple(helpers)):
                    if to in member_ids:
                        helper_sent[to] += n
            out.append({
                "id": sid, "name": name or f"Swarm {sid}", "named": bool(name),
                "lane": lane, "helper_conv": helper, "summary": summary,
                "summary_at": summary_at, "created_at": created,
                "counts": {"working": counts["working"], "silent": counts["silent"],
                           "needs_input": counts["needs_input"]},
                "members": members, "topics": topics,
                "closed": is_closed([m["conv"] for m in members], index),
                "links": [{"from": a, "to": b, "messages": n} for a, b, n in talked],
                "continues": continues,
                "helper_links": [{"to": conv, "messages": n}
                                 for conv, n in sorted(helper_sent.items())],
            })
        return out
    finally:
        conn.close()


def _read_topics(conn, swarm_id, members, index):
    """A swarm's topics as a card needs them, and each member's `topic_id`
    settled in place. A member that isn't sorted reads as in the topic of its
    own line of work (a continuation joins after the sorting was done); one
    whose topic is gone reads as unsorted. Topics with nobody in them are
    left out. Returns [{id, name, summary, summary_at, convs}], oldest first."""
    rows = conn.execute("SELECT id, name, summary, summary_at FROM swarm_topics"
                        " WHERE swarm_id = ? ORDER BY id", (swarm_id,)).fetchall()
    if not rows:
        for m in members:
            m["topic_id"] = None
        return []
    known = {row[0] for row in rows}
    sorted_into = {m["conv"]: m["topic_id"] for m in members if m["topic_id"] in known}
    for m in members:
        if m["conv"] in sorted_into:
            continue
        m["topic_id"] = next((sorted_into[c] for c in sorted(line_of_work(m["conv"], index))
                              if c in sorted_into), None)
    return [{"id": tid, "name": name, "summary": summary, "summary_at": summary_at,
             "convs": [m["conv"] for m in members if m["topic_id"] == tid]}
            for tid, name, summary, summary_at in rows
            if any(m["topic_id"] == tid for m in members)]


def set_topic(swarm_id, name, convs):
    """Sort these members of a live swarm into the topic with this name,
    making the topic if the swarm has none by that name (capitals aside). A
    session's continuations go with it. Topics left with nobody are deleted.
    Returns {"id", "name", "convs": who is in it now, "changed": whether
    anything was written}. Raises ValueError when the swarm isn't live, the
    name is empty, or none of the sessions is a member."""
    name = " ".join(str(name or "").split())[:80]
    if not name:
        raise ValueError("a topic needs a name")
    if not is_live(swarm_id):
        raise ValueError(f"swarm {swarm_id} isn't a live swarm")
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    members = set(overview_members(swarm_id))
    wanted = set()
    for conv in convs:
        wanted |= line_of_work(conv, index) & members
    if not wanted:
        raise ValueError(f"none of those sessions is a member of swarm {swarm_id}")
    now = _now()
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        row = conn.execute("SELECT id, name FROM swarm_topics WHERE swarm_id = ?"
                           " AND lower(name) = lower(?)", (swarm_id, name)).fetchone()
        changed = row is None
        if row is None:
            topic_id = conn.execute(
                "INSERT INTO swarm_topics (swarm_id, name, created_at, updated_at)"
                " VALUES (?, ?, ?, ?)", (swarm_id, name, now, now)).lastrowid
        else:
            topic_id, name = row
        marks = ",".join("?" * len(wanted))
        moved = conn.execute(
            f"UPDATE swarm_members SET topic_id = ? WHERE swarm_id = ? AND conv IN ({marks})"
            " AND topic_id IS NOT ?", (topic_id, swarm_id, *sorted(wanted), topic_id)).rowcount
        if moved:
            changed = True
            conn.execute("UPDATE swarm_topics SET updated_at = ? WHERE id = ?", (now, topic_id))
        # Delete the topics nobody is in any more.
        conn.execute("DELETE FROM swarm_topics WHERE swarm_id = ? AND id NOT IN"
                     " (SELECT topic_id FROM swarm_members WHERE swarm_id = ?"
                     "  AND topic_id IS NOT NULL)", (swarm_id, swarm_id))
        inside = [r[0] for r in conn.execute(
            "SELECT conv FROM swarm_members WHERE swarm_id = ? AND topic_id = ? ORDER BY conv",
            (swarm_id, topic_id))]
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return {"id": topic_id, "name": name, "convs": inside, "changed": changed}


def swarm_of(conv_id):
    """The live swarm a session belongs to, or None."""
    conn = sqlstore.open_db()
    try:
        row = conn.execute(
            "SELECT s.id FROM swarm_members m JOIN swarms s ON s.id = m.swarm_id"
            " WHERE m.conv = ? AND s.merged_into IS NULL", (conv_id,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def overview_members(swarm_id):
    """The member session ids of one swarm."""
    conn = sqlstore.open_db()
    try:
        return [r[0] for r in conn.execute(
            "SELECT conv FROM swarm_members WHERE swarm_id = ?", (swarm_id,))]
    finally:
        conn.close()


def join(swarm_id, conv_id):
    """Put a session into a live swarm by hand — the '+' on a swarm's page
    starts a session that belongs to the swarm before it has said a word.
    Returns False if there's no such live swarm.

    Nothing else has to change for it to stay: membership only grows, and
    sync keeps every stored member of a swarm whose group still stands, so a
    member added here is kept even though no message links it yet."""
    if swarm_id not in sync():
        return False
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("INSERT OR IGNORE INTO swarm_members (swarm_id, conv, joined_at)"
                     " VALUES (?, ?, ?)", (swarm_id, conv_id, _now()))
        conn.execute("UPDATE swarms SET updated_at = ? WHERE id = ?", (_now(), swarm_id))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return True


def new_swarm(lane):
    """A new, empty swarm row in this room. Returns its id. Its members come
    from `place` — sync dissolves it again if nobody is placed in it."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        swarm_id = conn.execute("INSERT INTO swarms (created_at, updated_at, lane)"
                                " VALUES (?, ?, ?)", (_now(), _now(), lane)).lastrowid
        conn.execute("COMMIT")
        return swarm_id
    finally:
        conn.close()


def place(convs, swarm_id, move_id=None):
    """Put these sessions into this swarm (None: release them to work alone),
    overriding every message they've exchanged so far (see the top of the
    file). Returns what each was before, as {conv: [swarm_id, at] or None},
    for an undo. Syncs afterwards, so the swarms reflect it at once."""
    now = _now()
    conn = sqlstore.open_db()
    try:
        before = {c: list(v) for c, v in pins(conn).items() if c in convs}
        sqlstore.begin_immediate(conn)
        for conv in convs:
            conn.execute("INSERT OR REPLACE INTO swarm_pins (conv, swarm_id, at, move_id)"
                         " VALUES (?, ?, ?, ?)", (conv, swarm_id, now, move_id))
            if swarm_id is not None:
                conn.execute("INSERT OR IGNORE INTO swarm_members (swarm_id, conv, joined_at)"
                             " VALUES (?, ?, ?)", (swarm_id, conv, now))
        conn.execute("COMMIT")
    finally:
        conn.close()
    sync()
    return {c: before.get(c) for c in convs}


def unplace(before):
    """Undo `place`: give each session back the placement it had before
    ({conv: [swarm_id, at] or None} — None removes its placement, so its old
    messages link it again). Syncs afterwards."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        for conv, pin in before.items():
            if pin:
                conn.execute("INSERT OR REPLACE INTO swarm_pins (conv, swarm_id, at)"
                             " VALUES (?, ?, ?)", (conv, pin[0], pin[1]))
            else:
                conn.execute("DELETE FROM swarm_pins WHERE conv = ?", (conv,))
        conn.execute("COMMIT")
    finally:
        conn.close()
    sync()


def line_of_work(conv_id, index):
    """This session and every continuation before and after it — one line of
    work, which always moves together."""
    parent = {c: e.get("spawned_from") for c, e in index.items()
              if isinstance(e, dict) and e.get("spawned_via") == "continue"}
    root, seen = conv_id, {conv_id}
    while parent.get(root) in index and parent[root] not in seen:
        root = parent[root]
        seen.add(root)
    line, frontier = {root}, [root]
    while frontier:
        here = frontier.pop()
        for child, p in parent.items():
            if p == here and child not in line:
                line.add(child)
                frontier.append(child)
    return line | {conv_id}


def seed_text(swarm_id):
    """What a session started inside a swarm is told before its first turn:
    which swarm, what the helper says it's about, and who's in it."""
    card = next((c for c in overview() if c["id"] == swarm_id), None)
    if card is None:
        return ""
    lines = [f"## Your swarm: {card['name']}", "",
             "You were started inside this swarm by the owner, so you're a member"
             " from your first turn. Run `./venv/bin/python3 scripts/peers.py swarm`"
             " before you begin for its current state, and message the members"
             " whose work touches yours.", ""]
    if card.get("summary"):
        lines += [card["summary"], ""]
    lines += [f"- `{m['conv']}` {m['title']} ({m['state']})"
              + (f" — {' '.join(m['summary'].split())}" if m.get("summary") else "")
              for m in card["members"] if not m["retired"]]
    return "\n".join(lines) + "\n"
