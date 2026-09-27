"""Helpers — the small Claude jobs a button fires (triage, recipe parsing,
receipt parsing, person impressions), and the room that remembers them.

What this file does, in plain English. Several buttons around the app hand a
job to Claude: 🧭 Triage on the Todos page, "parse this recipe URL / photo"
and "scan this receipt" in the Kitchen, "regenerate impression" on a person's
page. They all used to spawn `claude` in a named tmux pane and tell her to go
find the pane. That path is gone (tmux left with the Keeper's move to the
Reading Room, 2026-07-24), so they now come through here:

  mint_helper(...)  — the one door. Writes a brief for the job, opens a
                      PERSONAL-room Observatory session through routes/
                      spinoff.py's open_spinoff (the same door every agent
                      session uses), and stamps the entry `origin: "helper"`
                      + `helper: <kind>` so the Observatory can tell these
                      apart from her own conversations. Some kinds REJOIN a
                      live session by slug (triage, a person) because they're
                      conversations; the fire-and-forget kinds (a recipe, a
                      receipt) mint a fresh session per job, so every run is
                      its own card and nothing is typed into a session that
                      may be mid-turn.

  GET /api/helpers  — the history. Every helper session ever minted, archived
                      included, newest first, with what it was, whether it's
                      still running, whether it failed, and what it cost.
                      Drawn by the Helpers door at the bottom of the
                      Observatory roster and its page (/observatory/helpers),
                      so she can see what has run in the past without opening
                      each one.

Touches: routes/spinoff.py (open_spinoff), routes/observatory.py (the running
/tokens readers, so a helper card reads the same way a roster card does),
store.SPINOFF_DIR. Callers: routes/triage.py, routes/person.py,
routes/kitchen/recipes.py, routes/kitchen/receipts.py. The roster hides
helper sessions from the rooms (frontend sessionFilters.roomRoster).

Prompt that produced this: "I want all of those [tmux-spawned helper buttons]
to be built into the observatory as a section at the bottom so I can see
what has run in the past, like the night crew room that I have to click to
open."
"""
from flask import jsonify

import store

# routes.observatory and routes.spinoff are imported INSIDE the functions, not
# here: observatory imports routes.kitchen.shared, which loads the kitchen
# package, which loads recipes/receipts, which import this file — a module-
# level import here would close that circle before observatory finished
# loading. Lazy imports cost one dict lookup per call.

ORIGIN = "helper"

# What each kind is called on a card. Kinds not listed still work; they just
# show their raw name.
KIND_LABELS = {
    "triage": "Triage",
    "recipe": "Recipe parse",
    "receipt": "Receipt parse",
    "person": "Impression",
}


def mint_helper(kind, slug, brief, title, model=None):
    """Open (or rejoin) the helper session for `slug` and tag it as a helper.

    `brief` is the Markdown body written to SPINOFF_DIR/<slug>/BRIEF.md; it
    becomes the session's first message, word for word, so it should carry
    its own `## Protocol` section — a brief without one gets the general
    spinoff Protocol (claude-commands/spinoff/protocol.md), which is written
    for build work, not a helper's job. `title` is what the card says. Returns
    (payload, status) exactly like open_spinoff, with `kind` added."""
    from routes.spinoff import open_spinoff

    brief_dir = store.SPINOFF_DIR / slug
    brief_dir.mkdir(parents=True, exist_ok=True)
    (brief_dir / "BRIEF.md").write_text(brief)
    # Personal room on purpose: these jobs write into the vault (todos.json,
    # parsed recipes, a person's file) and she is the one who pressed the
    # button, so nothing unwatched is being handed autonomy.
    payload, status = open_spinoff(slug, lane="personal", model=model, via="helper")
    if status == 200 and payload.get("conversation_id"):
        # Stamp AFTER the mint, in a separate short lock, rather than teaching
        # open_spinoff about helpers: the spawn door stays one door.
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(payload["conversation_id"])
            if isinstance(entry, dict):
                entry["origin"] = ORIGIN
                entry["helper"] = kind
                if payload.get("newly_spawned"):
                    entry["title"] = title[:60]
    payload = dict(payload, kind=kind)
    return payload, status


def _helper_rows(index):
    from routes.observatory import _effective_running, _session_tokens

    rows = []
    for cid, entry in index.items():
        if not isinstance(entry, dict) or entry.get("origin") != ORIGIN:
            continue
        running = bool(entry.get("running")) and _effective_running(cid, entry)
        row = {
            "id": cid,
            "kind": entry.get("helper") or "helper",
            "label": KIND_LABELS.get(entry.get("helper") or "", entry.get("helper") or "Helper"),
            "title": entry.get("title") or "",
            "started": entry.get("started") or entry.get("last_at") or "",
            "last_at": entry.get("last_at") or "",
            "archived": entry.get("archived") or None,
            "running": running,
            "last_error": entry.get("last_error") or None,
            "lane": entry.get("lane"),
        }
        tokens = _session_tokens(cid)
        if tokens:
            row["tokens"] = tokens
        rows.append(row)
    rows.sort(key=lambda r: r["started"], reverse=True)
    return rows


def register(app):

    @app.route("/api/helpers")
    def helpers_list():
        """Every helper session, archived included, newest first."""
        index = store.read("bot_chats/index", {})
        rows = _helper_rows(index)
        return jsonify({
            "runs": rows,
            "running": sum(1 for r in rows if r["running"]),
            "failed": sum(1 for r in rows if r["last_error"] and not r["archived"]),
        })
