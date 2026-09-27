"""Swarms — groups of agent sessions that have talked to each other.

**What this is, in plain English.** When agents message each other through the
mailbox (peermail.py), they form groups: any two sessions that have exchanged
a message are linked, and everything linked together — directly or through
someone else — is one swarm. Not everyone in a swarm has to have talked to
everyone; one conversation with one other member is enough to join. A session
that continued itself (a fresh session taking over when the old one's context
filled up) stays in its parent's swarm.

A swarm keeps its identity as it grows: the same number, the same name, the
same helper, even as new members join. When two swarms get linked, the older
one absorbs the younger (its row is kept, marked `merged_into`), so nothing a
helper wrote is lost. Membership only grows — a session that stops talking is
still part of the swarm it worked in.

This file only works out who belongs where and stores it. Naming the swarm and
summarising its members is the helper's job (docs/swarms.md, stage 4).

Touches: sqlstore.py (the `swarms`, `swarm_members` and `swarm_helper_runs`
tables), the `agent_messages` table (peermail.py), the session index
(bot_chats/index — lanes and spinoff lineage), tests/test_swarms.py.
Design and decisions: docs/swarms.md.

Prompt that produced this: "it defines its own project based on 2 or more
agents interacting, and they don't all have to be interacting with all the
other agents, just 1 other."
"""
from collections import Counter
from datetime import datetime

import lanes
import sqlstore
import store


def _now():
    return datetime.now().isoformat(timespec="seconds")


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
    """Who is linked to whom: every pair that exchanged an agent message
    (delivered or not — sending is the interaction), plus every session and
    the continuation that took over from it."""
    # A swarm's helper talks to every member but isn't one of them — linking
    # through it would make its own swarm out of nothing.
    helpers = {c for c, e in index.items() if isinstance(e, dict) and e.get("role") == "swarm_helper"}
    pairs = [tuple(row) for row in conn.execute(
        "SELECT DISTINCT from_conv, to_conv FROM agent_messages"
        " WHERE kind = 'A' AND status != 'cancelled' AND from_conv IS NOT NULL")
        if row[0] not in helpers and row[1] not in helpers]
    for conv_id, entry in index.items():
        if (isinstance(entry, dict) and entry.get("spawned_via") == "continue"
                and entry.get("spawned_from")):
            pairs.append((entry["spawned_from"], conv_id))
    return pairs


def _majority_lane(members, index):
    """The room a swarm's card sits in: the room most of its members are in."""
    counts = Counter(lanes.derive_lane(index.get(m) or {}) for m in members)
    return counts.most_common(1)[0][0] if counts else "orchestra"


def sync():
    """Bring the stored swarms up to date with who has talked to whom.
    Returns the live swarms as {id: set(members)}. Cheap — one query and a
    walk over a few hundred sessions — so it's safe to run whenever a
    message is sent or a page asks."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    conn = sqlstore.open_db()
    try:
        found = groups(links(conn, index))
        sqlstore.begin_immediate(conn)
        try:
            stored = {}
            for swarm_id, conv in conn.execute(
                    "SELECT m.swarm_id, m.conv FROM swarm_members m"
                    " JOIN swarms s ON s.id = m.swarm_id"
                    " WHERE s.merged_into IS NULL"):
                stored.setdefault(swarm_id, set()).add(conv)
            now = _now()
            live = {}
            for members in found:
                # Which stored swarms this group already covers. None: a new
                # swarm. One: it grew. Several: they've been linked — the
                # oldest (lowest id) absorbs the rest.
                overlap = sorted(sid for sid, have in stored.items() if have & members)
                if overlap:
                    keep = overlap[0]
                    for gone in overlap[1:]:
                        conn.execute("UPDATE swarms SET merged_into = ?, updated_at = ?"
                                     " WHERE id = ?", (keep, now, gone))
                        members |= stored.pop(gone)
                else:
                    keep = conn.execute(
                        "INSERT INTO swarms (created_at, updated_at, lane) VALUES (?, ?, ?)",
                        (now, now, _majority_lane(members, index))).lastrowid
                    stored[keep] = set()
                # Membership only grows (see the top of the file).
                members |= stored[keep]
                for conv in members - stored[keep]:
                    conn.execute("INSERT OR IGNORE INTO swarm_members (swarm_id, conv,"
                                 " joined_at) VALUES (?, ?, ?)", (keep, conv, now))
                conn.execute("UPDATE swarms SET lane = ?, updated_at = ? WHERE id = ?",
                             (_majority_lane(members, index), now, keep))
                stored[keep] = members
                live[keep] = members
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return live
    finally:
        conn.close()


def _status(entry):
    """The three states the Orchestra cards use, plus silent: working (a turn
    is running), needs input (it asked her something), silent (neither)."""
    if entry.get("awaiting_input"):
        return "needs_input"
    if entry.get("running"):
        return "working"
    return "silent"


def overview():
    """Every live swarm as a card needs it: name, room, summary, member
    count by state, the members with their own summaries, and who is joined
    to whom (messages sent, and continuations) for the network drawing."""
    sync()
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    conn = sqlstore.open_db()
    try:
        swarms = conn.execute(
            "SELECT id, name, lane, helper_conv, summary, summary_at, created_at"
            " FROM swarms WHERE merged_into IS NULL ORDER BY updated_at DESC").fetchall()
        out = []
        for sid, name, lane, helper, summary, summary_at, created in swarms:
            members = []
            counts = Counter()
            for conv, joined, msummary, msummary_at in conn.execute(
                    "SELECT conv, joined_at, summary, summary_at FROM swarm_members"
                    " WHERE swarm_id = ? ORDER BY joined_at, conv", (sid,)):
                entry = index.get(conv) if isinstance(index.get(conv), dict) else {}
                state = _status(entry)
                counts[state] += 1
                members.append({"conv": conv, "title": entry.get("title") or conv,
                                "lane": lanes.derive_lane(entry), "state": state,
                                "joined_at": joined, "summary": msummary,
                                "summary_at": msummary_at})
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
            out.append({
                "id": sid, "name": name or f"Swarm {sid}", "named": bool(name),
                "lane": lane, "helper_conv": helper, "summary": summary,
                "summary_at": summary_at, "created_at": created,
                "counts": {"working": counts["working"], "silent": counts["silent"],
                           "needs_input": counts["needs_input"]},
                "members": members,
                "links": [{"from": a, "to": b, "messages": n} for a, b, n in talked],
                "continues": continues,
            })
        return out
    finally:
        conn.close()


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
