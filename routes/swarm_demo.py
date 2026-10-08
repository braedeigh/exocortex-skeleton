"""Swarm demo routes — one frozen swarm, readable by anyone.

**What this is, in plain English.** The owner's portfolio shows a real swarm
stopped mid-work, which a visitor can click through. The live swarm routes
(routes/swarms.py) stay closed to visitors: they name every session and show
what was said. These two routes read one file instead, the frozen copy the
owner made and read through before publishing (scripts/freeze_swarm.py
writes a draft, and its `--publish` makes it `swarm_demo.json` in the data
folder; a draft alone is never served):

    GET /api/demo/swarm              the swarm as its stack draws it: name,
                                     summary, members with their states, the
                                     lines between them, every message
                                     between agents, and for each chat its
                                     title, state and open questions. No
                                     chat text.
    GET /api/demo/swarm/chat/<conv>  one member's chat (or the helper's), as
                                     the events a chat page draws.

Nothing here reads the database or a live transcript, so the demo can never
show more than the file holds. With no file, both answer 404.

Touches: store.py (the read), public_config.py (both paths are open to
visitors), server.py (the page may be framed by the portfolio),
frontend/src/features/observatory/SwarmDemoPage.tsx (the page),
tests/test_swarm_demo.py.

Prompt that produced it: "i want to put like, a frozen demo of a swarm that
was working and make it clickable"
"""
from flask import jsonify

import store

DEMO_COLLECTION = "swarm_demo"


def _demo():
    """The frozen swarm, or None when the owner hasn't made one."""
    found = store.read(DEMO_COLLECTION, {})
    if not isinstance(found, dict) or not isinstance(found.get("swarm"), dict):
        return None
    return found


def register(app):
    @app.route("/api/demo/swarm")
    def swarm_demo():
        demo = _demo()
        if demo is None:
            return jsonify({"error": "not found"}), 404
        # Hand over each chat's card, not its text: the page asks for a chat
        # only when a visitor opens it.
        sessions = {conv: {key: value for key, value in session.items() if key != "events"}
                    for conv, session in (demo.get("sessions") or {}).items()
                    if isinstance(session, dict)}
        return jsonify({**demo, "sessions": sessions})

    @app.route("/api/demo/swarm/chat/<conv_id>")
    def swarm_demo_chat(conv_id):
        demo = _demo()
        session = ((demo or {}).get("sessions") or {}).get(conv_id)
        if not isinstance(session, dict):
            return jsonify({"error": "not found"}), 404
        return jsonify({"id": conv_id, "title": session.get("title") or conv_id,
                        "state": session.get("state"), "events": session.get("events") or []})
