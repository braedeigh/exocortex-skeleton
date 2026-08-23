"""Triage — the 🧭 button on the Todos page that opens a Reading Room session
you talk to about your day; it reorders todos.json as you chat.

What this file does, in plain English: one endpoint, POST /api/triage/open.
It writes a short brief into the spinoff folder (SPINOFF_DIR/triage/BRIEF.md)
that points the session at the triage skill — the CLAUDE.md in TRIAGE_DIR,
which lives in the vault, not here — and then walks through the same door
every agent session uses, routes/spinoff.py's open_spinoff(). That mints an
Observatory conversation in the PERSONAL room (rooted at the parent of both
repos, acting without the ask-gate, because editing todos.json in the vault
is exactly its job) and starts it working; the Todos page then navigates to
it. Opening triage twice rejoins the same live conversation instead of
minting a second one — open_spinoff does that by slug. The walk through the
door is routes/helpers.py's mint_helper, shared with the other helper
buttons, which also tags the session so it shows in the Helpers room.

History in one line: this used to spawn `claude` in a tmux pane and deep-link
to the /phone terminal. The tmux path was retired 2026-07-24 (the Keeper moved
to the Reading Room) and tmux isn't installed on the current box, so the
button went dark. Re-doored 2026-08-22 in the burn session — the owner's
call was "put triage back in the UI", and the dev-todo had already named this
route (write a brief, hit /api/spinoff/open).

Prompt that produced this: "Put triage back in the UI actually" — the triage
button had no frontend caller and depended on a tmux spawn path that no
longer exists; re-door it through the spinoff machinery.
"""
from flask import jsonify, request

import store
from routes.helpers import mint_helper

SLUG = "triage"


def _brief_text():
    """The brief is deliberately tiny: it hands the session to the skill file
    in the vault rather than copying the skill here, so the owner keeps
    editing how Triage behaves in ONE place (TRIAGE_DIR/CLAUDE.md)."""
    skill = store.TRIAGE_DIR / "CLAUDE.md"
    return (
        "# Triage\n\n"
        "## Protocol\n\n"
        f"1. Read `{skill}` — it is the whole skill. You are **Triage**: the\n"
        "   owner's todo-prioritizing partner. Follow it exactly, including its\n"
        "   hard rules about what you may and may not write.\n"
        "2. Read the data files it names, fresh, before every reply.\n"
        "3. Open the conversation by asking, in a sentence, how the day feels —\n"
        "   energy, anything urgent, anything dreaded. Don't reorder anything\n"
        "   until she has answered.\n"
        "4. Keep it conversational and short. She's talking to you, not reading\n"
        "   a memo.\n"
    )


def register(app):

    @app.route("/api/triage/open", methods=["POST"])
    def triage_open():
        data = request.json or {}
        # The brief is rewritten on every open (mint_helper does that) so it
        # always names the current TRIAGE_DIR.
        payload, status = mint_helper(
            "triage", SLUG, _brief_text(), "Triage",
            model=(data.get("model") or "").strip() or None,
        )
        return jsonify(payload), status
