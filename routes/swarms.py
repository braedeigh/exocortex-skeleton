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
                                  messages between members, and where the
                                  helper saw their work differ.
    POST /api/swarms/<id>/refresh ask the helper to update now.
    GET  /api/swarms/room/<room>  the room seen from above, for the room map:
                                  the room helper's session, the sessions
                                  working alone (with its summary of each),
                                  and its recent moves (room_helper.py).

Messages TO the helper don't need a route of their own: the helper is a
session, so the chat's normal mailbox (POST
/api/observatory/conversation/<helper>/inbox) reaches it.

Touches: swarms.py, swarm_helper.py, room_helper.py, the agent_messages,
swarm_helper_runs and session_summaries tables, tests/test_swarm_routes.py. Design: docs/swarms.md.
"""
import json

from flask import jsonify

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
            "differences": latest.get("differences") or []}


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

    @app.route("/api/swarms/room/<room_name>")
    def swarm_room(room_name):
        return jsonify(room(room_name))

    @app.route("/api/swarms/<int:swarm_id>/refresh", methods=["POST"])
    def swarm_refresh(swarm_id):
        if swarm_id not in swarms.sync():
            return jsonify({"error": "not found"}), 404
        # Straight to a run — she asked, so no debounce.
        started = swarm_helper._spawn(swarm_id, "refresh")
        return jsonify({"ok": True, "started": bool(started)})
