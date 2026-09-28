"""Swarms — groups of agent sessions that have talked to each other.

**What this is, in plain English.** When agents message each other through the
mailbox (peermail.py), they form groups: any two sessions that have exchanged
a message are linked, and everything linked together — directly or through
someone else — is one swarm. Not everyone in a swarm has to have talked to
everyone; one conversation with one other member is enough to join. A session
that continued itself (a fresh session taking over when the old one's context
filled up) stays in its parent's swarm — but a handoff is not a conversation:
a session and its own continuation, with no message between them and anyone
else, are one line of work, not a swarm, and get no swarm of their own.

A swarm keeps its identity as it grows: the same number, the same name, the
same helper, even as new members join. When two swarms get linked, the older
one absorbs the younger (its row is kept, marked `merged_into`), so nothing a
helper wrote is lost. Membership only grows — a session that stops talking is
still part of the swarm it worked in.

She can also start a session straight into a swarm (the '+' on a swarm's
page): `join` adds it as a member before it has messaged anyone, and
`seed_text` is what it's told about the swarm it woke up in.

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
    """Who is linked to whom, as two lists: every pair that exchanged an
    agent message (delivered or not — sending is the interaction), and every
    session paired with the continuation that took over from it."""
    # A swarm's helper talks to every member but isn't one of them — linking
    # through it would make its own swarm out of nothing.
    helpers = {c for c, e in index.items() if isinstance(e, dict) and e.get("role") == "swarm_helper"}
    talked = [tuple(row) for row in conn.execute(
        "SELECT DISTINCT from_conv, to_conv FROM agent_messages"
        " WHERE kind = 'A' AND status != 'cancelled' AND from_conv IS NOT NULL")
        if row[0] not in helpers and row[1] not in helpers]
    continued = [(entry["spawned_from"], conv_id) for conv_id, entry in index.items()
                 if isinstance(entry, dict) and entry.get("spawned_via") == "continue"
                 and entry.get("spawned_from")]
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


def sync():
    """Bring the stored swarms up to date with who has talked to whom.
    Returns the live swarms as {id: set(members)}. Cheap — one query and a
    walk over a few hundred sessions — so it's safe to run whenever a
    message is sent or a page asks."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    conn = sqlstore.open_db()
    try:
        found = found_groups(*links(conn, index))
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
            # Dissolve any stored swarm no group covers any more. That's a
            # swarm formed by a handoff alone (before handoffs stopped making
            # swarms), or one whose only message was cancelled: there was
            # never a conversation, so its rows go, helper summaries with them.
            for gone in set(stored) - set(live):
                conn.execute("UPDATE swarms SET merged_into = NULL, updated_at = ?"
                             " WHERE merged_into = ?", (now, gone))
                conn.execute("DELETE FROM swarm_helper_runs WHERE swarm_id = ?", (gone,))
                conn.execute("DELETE FROM swarm_members WHERE swarm_id = ?", (gone,))
                conn.execute("DELETE FROM swarms WHERE id = ?", (gone,))
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    _archive_helpers(set(live))
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


def overview():
    """Every live swarm as a card needs it: name, room, summary, member
    count by state, the members with their own summaries, and who is joined
    to whom (messages sent, and continuations) for the network drawing."""
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
            for conv, joined, msummary, msummary_at in conn.execute(
                    "SELECT conv, joined_at, summary, summary_at FROM swarm_members"
                    " WHERE swarm_id = ? ORDER BY joined_at, conv", (sid,)):
                entry = index.get(conv) if isinstance(index.get(conv), dict) else {}
                state = _status(entry)
                counts[state] += 1
                members.append({"conv": conv, "title": entry.get("title") or conv,
                                "lane": lanes.derive_lane(entry), "state": state,
                                "retired": bool(entry.get("archived")) or conv in handed_on,
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
              + (f" — {m['summary']}" if m.get("summary") else "")
              for m in card["members"] if not m["retired"]]
    return "\n".join(lines) + "\n"
