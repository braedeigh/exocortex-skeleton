"""Swarm routes — what the Observatory and the Terrain map show of swarms.

**What this is, in plain English.** Sessions that message each other form a
swarm (swarms.py), and each swarm has a helper that names it and keeps
summaries (swarm_helper.py). These routes hand that to the page:

    GET  /api/swarms              every live swarm — name, room, summary, member
                                  counts by state, members, who messaged whom.
                                  The swarm cards in each room read this.
    GET  /api/swarms/<id>         one swarm in full, for its page: the above,
                                  plus the helper's recent runs (exactly what it
                                  was given and what it wrote back), the
                                  messages between members, and where the
                                  helper saw their work differ.
    POST /api/swarms/<id>/refresh ask the helper to update now.

Messages TO the helper don't need a route of their own: the helper is a
session, so the chat's normal mailbox (POST
/api/observatory/conversation/<helper>/inbox) reaches it.

Touches: swarms.py, swarm_helper.py, the agent_messages and
swarm_helper_runs tables, tests/test_swarm_routes.py. Design: docs/swarms.md.
"""
import json

from flask import jsonify

import sqlstore
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

    @app.route("/api/swarms/<int:swarm_id>/refresh", methods=["POST"])
    def swarm_refresh(swarm_id):
        if swarm_id not in swarms.sync():
            return jsonify({"error": "not found"}), 404
        # Straight to a run — she asked, so no debounce.
        started = swarm_helper._spawn(swarm_id, "refresh")
        return jsonify({"ok": True, "started": bool(started)})
