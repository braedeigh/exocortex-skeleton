"""Research room — the Observatory lane where research sessions live, and
the door that lists them.

What this file does, in plain English. Research used to happen in two places
that couldn't see each other: the owner's own Claude sessions, and the
dispatched research workers, which ran in named tmux panes nobody could open
from the app. Both now live in ONE lane, `research` (routes/observatory.py's
_LANES), rooted in store.RESEARCH_ROOM_DIR — a folder whose CLAUDE.md teaches
a session how to read her tables and how to write research back through
scripts/research_ctl.py. This file is that lane's two doors:

  mint_research_conversation(...)  — how a dispatched worker gets its
                      session. scripts/research_dispatcher.py calls this when
                      the run dispatcher admits a queued research session: it
                      writes one entry into bot_chats/index.json in the
                      research lane, stamped `origin: "research"` and
                      `research_session_id: <sid>`, so the conversation and
                      the research record point at each other. The worker's
                      job description (research-worker/CLAUDE.md or
                      research-distiller/CLAUDE.md) rides along as the
                      session's system prompt, so the room stays the ground
                      and the mode stays the job.

  GET /api/research-room — the history. Every conversation in the lane,
                      archived included, newest first: her own desk sessions
                      and the workers alike, each saying whether it's still
                      running and which research session (if any) it served.
                      Drawn by the Research door on the Observatory roster
                      and its page (/observatory/research). Mirrors
                      routes/helpers.py's GET /api/helpers.

Touches: routes/observatory.py (the lane profile, the id/clock helpers, the
running/tokens readers), store.RESEARCH_ROOM_DIR. Callers:
scripts/research_dispatcher.py (the mint), the frontend's ResearchPage /
ResearchDoor (the list). The roster hides research sessions from the rooms
(frontend sessionFilters.roomRoster) the same way it hides helpers.

Prompt that produced this: "research sessions get their own room in the
Observatory, and a research run's records all point at each other."
"""
from pathlib import Path

from flask import jsonify

import store

# routes.observatory is imported INSIDE the functions, not here: it pulls in
# routes.kitchen.shared and the whole kitchen package, and this module is
# imported by scripts/research_dispatcher.py, a cron script that should not
# pay for that at import time. Same shape as routes/helpers.py.

ORIGIN = "research"
LANE = "research"


def mint_research_conversation(session_id, title, model=None, system_prompt_file=None):
    """Open a research-lane conversation for one dispatched research session.

    Returns the new conversation id. The entry carries `origin: "research"` and
    `research_session_id` so the room and the research record can find each
    other; it is NOT started here — the caller hands the kickoff to the run
    dispatcher's runner, so the run stays inside the memory-admission queue.
    `model` is validated against the observatory's choices and written only
    when it's one of them; an omitted or unknown one leaves the field absent so
    the session follows the CLI default like every other conversation.
    `system_prompt_file` is the worker's CLAUDE.md, appended to the system
    prompt each turn — absent or missing, the session just runs bare in the
    room."""
    from routes.observatory import (_MODEL_CHOICES, _chats_dir, _lane_profile,
                                    _new_conv_id, _now)

    profile = _lane_profile(LANE)
    _chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        conv_id = _new_conv_id(index)
        entry = {
            "bot": "keeper", "started": _now(), "last_at": _now(),
            "claude_session_id": None, "cost_usd": 0.0,
            "title": (title or f"Research {session_id}")[:60], "journal": False,
            "lane": LANE, "cwd": profile["cwd"],
            "allowed_tools": list(profile["allowed_tools"]),
            "origin": ORIGIN,
            "research_session_id": session_id,
        }
        if model in _MODEL_CHOICES:
            entry["model"] = model
        if system_prompt_file and Path(system_prompt_file).is_file():
            entry["system_prompt_file"] = str(system_prompt_file)
        index[conv_id] = entry
    return conv_id


def _room_rows(index):
    """Every research-lane conversation as a row for the door and the page.
    Membership is the lane (resolved, so a session rooted in the room folder
    before lanes existed still counts), or the `research` origin stamp — a
    worker whose lane was later edited still belongs to the pipeline."""
    from routes.observatory import _conv_lane, _effective_running, _session_tokens

    rows = []
    for cid, entry in index.items():
        if not isinstance(entry, dict):
            continue
        if _conv_lane(entry) != LANE and entry.get("origin") != ORIGIN:
            continue
        running = bool(entry.get("running")) and _effective_running(cid, entry)
        row = {
            "id": cid,
            "title": entry.get("title") or "",
            "started": entry.get("started") or entry.get("last_at") or "",
            "last_at": entry.get("last_at") or "",
            "running": running,
            "archived": entry.get("archived") or None,
            "last_error": entry.get("last_error") or None,
            "origin": entry.get("origin") or None,
            "research_session_id": entry.get("research_session_id") or None,
        }
        tokens = _session_tokens(cid)
        if tokens:
            row["tokens"] = tokens
        rows.append(row)
    rows.sort(key=lambda r: r["started"], reverse=True)
    return rows


def register(app):

    @app.route("/api/research-room")
    def research_room_list():
        """Every research session, archived included, newest first — plus the
        model choices, so the page's "+ New research session" sheet can offer
        the same picker the roster does without a second round trip."""
        from routes.observatory import _MODEL_CHOICES

        index = store.read("bot_chats/index", {})
        rows = _room_rows(index)
        return jsonify({
            "sessions": rows,
            "running": sum(1 for r in rows if r["running"]),
            "failed": sum(1 for r in rows if r["last_error"] and not r["archived"]),
            "model_choices": list(_MODEL_CHOICES),
        })
