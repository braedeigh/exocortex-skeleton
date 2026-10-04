"""Swarm routes — what the Observatory and the Terrain map show of swarms.

**What this is, in plain English.** Sessions that message each other form a
swarm (swarms.py), and each swarm has a helper that names it and keeps
summaries (swarm_helper.py). These routes hand that to the page:

    GET  /api/swarms              every live swarm — name, room, summary, member
                                  counts by state, members, who messaged whom,
                                  and `closed` (every member finished). The
                                  swarm cards in each room read this, and hide
                                  the closed ones unless she asks for them.
    GET  /api/swarms/<id>         one swarm in full, for its page: the above,
                                  plus the helper's recent runs (exactly what it
                                  was given and what it wrote back), the
                                  messages between members, where the
                                  helper saw their work differ, and — once
                                  it has closed — what it did: the closing
                                  summaries its helper wrote, newest first,
                                  each with its closing check.
    GET  /api/swarms/<id>/closings
                                  only what a swarm did: its name, its
                                  helper's session and the closing summaries,
                                  newest first. The line a room helper's chat
                                  gets when a swarm closes opens into this.
    GET  /api/swarms/<id>/line?a=<conv,...>&b=<conv,...>
                                  the messages one line of the swarm drawing
                                  stands for, newest first: everything sent
                                  between the sessions on side `a` and the
                                  ones on side `b`. A side is a list because
                                  one ring can stand in for retired sessions
                                  it took over from; the word `helper` means
                                  the swarm's helper, and then only what the
                                  helper SENT is listed, which is what its
                                  line counts.
    POST /api/swarms/<id>/refresh ask the helper to update now.
    GET  /api/swarms/room/<room>  the room seen from above, for the room map:
                                  the room helper's session, the sessions
                                  working alone (with its summary of each),
                                  and its recent moves (room_helper.py).
    GET  /api/swarms/helper-of/<conv>
                                  the helper one session's chat links to (the
                                  button above its message box): its swarm's
                                  helper, else its room's, else null — and
                                  `is_helper`, whether that session is itself
                                  a helper (its chat then gets a "context"
                                  button).
    GET  /api/swarms/helper-context/<conv>
                                  what a helper is working from, for its
                                  context page: the seed its latest turn was
                                  handed, in its parts (helper_chat.py), and
                                  her standing rules file. `?now=1` builds the
                                  seed as it would be this minute instead —
                                  seconds of work, so only when she asks.
    PUT  /api/swarms/helper-context/<conv>/rules
                                  save her standing rules file, as she edited
                                  it whole on that page.
    POST /api/swarms/helper-context/<conv>/rule
                                  change one rule from that page: add one,
                                  edit one, or drop one.

Messages TO the helper don't need a route of their own: the helper is a
session, so the chat's normal mailbox (POST
/api/observatory/conversation/<helper>/inbox) reaches it.

Touches: swarms.py, swarm_helper.py (the closing summaries), room_helper.py,
helper_chat.py (the seed and the rules), the agent_messages,
swarm_helper_runs, swarm_closings and session_summaries tables, tests/test_swarm_routes.py. Design: docs/swarms.md.
"""
import json

from flask import jsonify, request

import config
import helper_chat
import lanes
import room_helper
import sqlstore
import store
import swarm_helper
import swarms

# How much history the swarm page loads at once.
_RUNS_SHOWN = 20
_MESSAGES_SHOWN = 200


def detail(swarm_id):
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    if card is None:
        return None
    members = [m["conv"] for m in card["members"]]
    conn = sqlstore.open_db()
    try:
        runs = [{"id": rid, "at": at, "trigger": trigger, "input": text,
                 "output": json.loads(output) if output else None,
                 "cost_usd": cost, "error": error}
                for rid, at, trigger, text, output, cost, error in conn.execute(
                    "SELECT id, at, trigger, input, output, cost_usd, error"
                    " FROM swarm_helper_runs WHERE swarm_id = ? ORDER BY id DESC LIMIT ?",
                    (swarm_id, _RUNS_SHOWN))]
        marks = ",".join("?" * len(members)) or "''"
        helper = card.get("helper_conv") or ""
        messages = [{"id": mid, "at": at, "from": a, "to": b, "text": t, "mode": mode,
                     "status": status}
                    for mid, at, a, b, t, mode, status in conn.execute(
                        f"SELECT id, at, from_conv, to_conv, text, mode, status"
                        f" FROM agent_messages WHERE kind = 'A' AND status != 'cancelled'"
                        f" AND (from_conv IN ({marks}) OR from_conv = ?)"
                        f" AND (to_conv IN ({marks}) OR to_conv = ?)"
                        f" ORDER BY id DESC LIMIT ?",
                        (*members, helper, *members, helper, _MESSAGES_SHOWN))]
    finally:
        conn.close()
    latest = next((r["output"] for r in runs if r["output"]), None) or {}
    return {**card, "runs": runs, "messages": messages,
            "differences": latest.get("differences") or [],
            "closings": list(reversed(swarm_helper.closings(swarm_id)))}


def line_messages(swarm_id, side_a, side_b):
    """The messages one line of the swarm drawing stands for, newest first.

    Each side is a list of session ids, or the word "helper". The drawing
    counts the same rows (swarms.overview): messages of kind 'A' that weren't
    cancelled, between members; and for the helper's line, only what any of
    the swarm's helper sessions sent to that member. So what this lists adds
    up to the number on the line. Returns None for a swarm that isn't there,
    and raises ValueError when a side names a session that is not one of the
    swarm's members — a line can only be read by naming both of its ends.

    Prompt that produced it: "click on a line or something and see the
    messages that were sent in that line."
    """
    card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
    if card is None:
        return None
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    members = {m["conv"]: m["title"] for m in card["members"]}
    # Every helper session this swarm has had, as the drawing counts them.
    helpers = {conv for conv, entry in index.items()
               if isinstance(entry, dict) and entry.get("role") == "swarm_helper"
               and entry.get("swarm_id") == swarm_id}
    if card.get("helper_conv"):
        helpers.add(card["helper_conv"])

    def resolve(side):
        if side == ["helper"]:
            return set(helpers), True
        if not side or any(conv not in members for conv in side):
            raise ValueError("each side must name members of this swarm, or be 'helper'")
        return set(side), False

    a, a_is_helper = resolve(side_a)
    b, b_is_helper = resolve(side_b)
    if a_is_helper and b_is_helper:
        raise ValueError("only one side can be the helper")
    # Which directions count: both ways between members, helper-to-member only.
    directions = []
    if not b_is_helper:
        directions.append((a, b))
    if not a_is_helper:
        directions.append((b, a))
    clauses, params = [], []
    for senders, receivers in directions:
        if not senders or not receivers:
            continue
        clauses.append(f"(from_conv IN ({','.join('?' * len(senders))})"
                       f" AND to_conv IN ({','.join('?' * len(receivers))}))")
        params += [*sorted(senders), *sorted(receivers)]
    if not clauses:
        return {"messages": [], "total": 0}

    def title(conv):
        if conv in helpers:
            return "Helper"
        return members.get(conv) or conv

    where = f"kind = 'A' AND status != 'cancelled' AND ({' OR '.join(clauses)})"
    conn = sqlstore.open_db()
    try:
        total = conn.execute(f"SELECT COUNT(*) FROM agent_messages WHERE {where}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT id, at, from_conv, to_conv, text, mode, status FROM agent_messages"
            f" WHERE {where} ORDER BY id DESC LIMIT ?", (*params, _MESSAGES_SHOWN)).fetchall()
    finally:
        conn.close()
    return {"total": total,
            "messages": [{"id": mid, "at": at, "from": sender, "to": receiver,
                          "from_title": title(sender), "to_title": title(receiver),
                          "text": text, "mode": mode, "status": status}
                         for mid, at, sender, receiver, text, mode, status in rows]}


def room(room_name):
    """The room from above: its helper, who's working alone, the recent moves."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    cards = room_helper.open_swarms(room_name)
    solos = room_helper.solo_sessions(room_name, index, cards)
    summaries = room_helper._stored_summaries(solos)
    return {
        "room": room_name,
        "helper_conv": room_helper.find_helper(room_name, index),
        "solos": [{"conv": conv, "title": index[conv].get("title") or conv,
                   "state": swarms._status(index[conv]),
                   "summary": summaries.get(conv, (None,))[0]} for conv in solos],
        "moves": room_helper.recent_moves(room_name),
    }


def helper_of(conv_id):
    """The helper one session's chat links to, for the button above its
    message box — {"kind": "swarm" | "room", "conv", "title"}, or None.

    Its swarm's helper when it's in a swarm that has one; otherwise its room's
    helper. A swarm helper links up to its room's helper; the room helper is
    the top of the stack and links nowhere.
    Prompt: "click a button up above the text input spot to go to that agent's
    helper, whether it's a swarm helper or just the room's helper"."""
    index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    entry = index.get(conv_id)
    if not isinstance(entry, dict):
        return None

    def link(kind, helper):
        # A link only to a helper that exists, is open, and isn't this session.
        target = index.get(helper) if helper else None
        if helper == conv_id or not isinstance(target, dict) or target.get("archived"):
            return None
        return {"kind": kind, "conv": helper, "title": target.get("title") or helper}

    # Its swarm's helper first — a helper session is in no swarm, so this
    # only ever finds one for a member.
    if not swarms.is_helper_session(conv_id, index):
        swarm_id = swarms.swarm_of(conv_id)
        if swarm_id is not None:
            conn = sqlstore.open_db()
            try:
                row = conn.execute("SELECT helper_conv FROM swarms WHERE id = ?",
                                   (swarm_id,)).fetchone()
            finally:
                conn.close()
            found = link("swarm", row[0] if row else None)
            if found:
                return found
    # Otherwise the room's helper (None when the room has none).
    room = entry.get("room") or lanes.derive_lane(entry)
    return link("room", room_helper.find_helper(room, index))


def _helper_entry(conv_id):
    """The index entry of a helper session, or None when there is no such
    session or it isn't a helper."""
    index = store.read("bot_chats/index", {})
    entry = index.get(conv_id) if isinstance(index, dict) else None
    if not isinstance(entry, dict) or entry.get("role") not in swarms.HELPER_ROLES:
        return None
    return entry


def _rules_view(entry):
    """Her standing rules for one helper, for the context page: where the
    file is, its whole text (what she edits), and the rules the helper is
    handed from it."""
    path = helper_chat.rules_path(entry)
    return {"path": str(path), "exists": path.exists(),
            "text": helper_chat.rules_text(entry), "rules": helper_chat.rules(entry)}


def helper_context(conv_id, now=False):
    """What one helper is working from, for its context page — or None when
    the session isn't a helper.

    `seed` is the document its latest turn was handed, in its parts, with
    when it was written (None when it has had no turn yet). With `now`, the
    seed is built fresh instead: what the helper would be handed if a turn
    started this minute. Nothing is written either way — a look from this
    page never counts as the helper having seen anything.
    Prompt: "some kind of option to edit the rolling context directly or at
    least see what is in the rolling context for a room helper" — and, on
    what to edit: "the standing rules is the part that should be edited"."""
    entry = _helper_entry(conv_id)
    if entry is None:
        return None
    if now:
        seed = {"at": helper_chat._now(), "now": True,
                "parts": helper_chat.seed_parts(conv_id, entry)}
    else:
        seed = helper_chat.last_seed(conv_id)
        seed = dict(seed, now=False) if seed else None
    return {"conv": conv_id, "title": entry.get("title") or conv_id,
            "kind": entry["role"].removesuffix("_helper"),
            "swarm_id": entry.get("swarm_id"), "room": entry.get("room"),
            "exchanges_kept": config.HELPER_CHAT_EXCHANGES,
            "seed": seed, "rules": _rules_view(entry)}


def register(app):
    @app.route("/api/swarms")
    def swarms_list():
        return jsonify({"swarms": swarms.overview()})

    @app.route("/api/swarms/<int:swarm_id>")
    def swarm_detail(swarm_id):
        found = detail(swarm_id)
        if found is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(found)

    # Hand over the messages behind one line of the swarm drawing.
    @app.route("/api/swarms/<int:swarm_id>/line")
    def swarm_line(swarm_id):
        sides = [[conv for conv in (request.args.get(name) or "").split(",") if conv]
                 for name in ("a", "b")]
        try:
            found = line_messages(swarm_id, *sides)
        except ValueError as problem:
            return jsonify({"error": str(problem)}), 400
        if found is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(found)

    # Hand over what one swarm did, and nothing else. The one-line "swarm
    # closed" notice in a room helper's chat opens into the whole summary, and
    # the full detail above (every helper run with its input) is far more
    # than that fold needs.
    # Prompt: "one line is fine as long as it is clickable to expand".
    @app.route("/api/swarms/<int:swarm_id>/closings")
    def swarm_closings(swarm_id):
        card = next((c for c in swarms.overview() if c["id"] == swarm_id), None)
        if card is None:
            return jsonify({"error": "not found"}), 404
        return jsonify({"id": swarm_id, "name": card["name"],
                        "helper_conv": card.get("helper_conv"),
                        "closings": list(reversed(swarm_helper.closings(swarm_id)))})

    @app.route("/api/swarms/room/<room_name>")
    def swarm_room(room_name):
        return jsonify(room(room_name))

    @app.route("/api/swarms/helper-of/<conv_id>")
    def swarm_helper_of(conv_id):
        return jsonify({"helper": helper_of(conv_id),
                        "is_helper": _helper_entry(conv_id) is not None})

    @app.route("/api/swarms/helper-context/<conv_id>")
    def swarm_helper_context(conv_id):
        found = helper_context(conv_id, now=request.args.get("now") == "1")
        if found is None:
            return jsonify({"error": "not a helper session"}), 404
        return jsonify(found)

    @app.route("/api/swarms/helper-context/<conv_id>/rules", methods=["PUT"])
    def swarm_helper_rules(conv_id):
        """Save her rules file. The body carries the text she wrote and the
        text her page had loaded; a file that changed in between is not
        overwritten — she gets 409 and the file as it is now."""
        entry = _helper_entry(conv_id)
        if entry is None:
            return jsonify({"error": "not a helper session"}), 404
        body = request.get_json(silent=True) or {}
        if not isinstance(body.get("text"), str) or not isinstance(body.get("loaded"), str):
            return jsonify({"error": "text and loaded are required"}), 400
        try:
            helper_chat.save_rules(entry, body["text"], body["loaded"])
        except helper_chat.RulesChanged as e:
            return jsonify({"error": str(e), "rules": _rules_view(entry)}), 409
        return jsonify({"ok": True, "rules": _rules_view(entry)})

    @app.route("/api/swarms/helper-context/<conv_id>/rule", methods=["POST"])
    def swarm_helper_rule(conv_id):
        """Change one of her rules — the edit, delete and add buttons on the
        context page. Body: {"action": "add" | "edit" | "drop", "words",
        "number", "was"}. An added rule is written as the helper writes one:
        today's date and her words in quotes. An edit or a drop names the
        rule by its number AND by the text her page was showing (`was`): if
        rule `number` no longer reads that way — the helper added or dropped
        one meanwhile — nothing is changed and she gets 409 with the rules
        as they are now.
        Prompt: "I want edit buttons for the rules"."""
        entry = _helper_entry(conv_id)
        if entry is None:
            return jsonify({"error": "not a helper session"}), 404
        body = request.get_json(silent=True) or {}
        action, number = body.get("action"), body.get("number")
        try:
            if action == "add":
                helper_chat.add_rule(entry, body.get("words"))
            elif action in ("edit", "drop") and isinstance(number, int):
                now = helper_chat.rules(entry)
                if not 1 <= number <= len(now) or now[number - 1] != body.get("was"):
                    return jsonify({"error": "the rules changed while you were looking",
                                    "rules": _rules_view(entry)}), 409
                if action == "edit":
                    helper_chat.edit_rule(entry, number, body.get("words"))
                else:
                    helper_chat.drop_rule(entry, number)
            else:
                return jsonify({"error": "action must be add, edit or drop"}), 400
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        return jsonify({"ok": True, "rules": _rules_view(entry)})

    @app.route("/api/swarms/<int:swarm_id>/refresh", methods=["POST"])
    def swarm_refresh(swarm_id):
        if swarm_id not in swarms.sync():
            return jsonify({"error": "not found"}), 404
        # Straight to a run — she asked, so no debounce.
        started = swarm_helper._spawn(swarm_id, "refresh")
        return jsonify({"ok": True, "started": bool(started)})
