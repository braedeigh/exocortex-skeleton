"""Linear room — the Observatory lane whose sessions work in Linear with the
owner, the door that lists them, and a live window onto Linear itself.

What this file does, in plain English. Linear is an outside issue tracker;
the owner plans and runs a project there. Claude sessions reach it through
the `linear` MCP server, which is installed at user scope, so every session
carries its tools. The `linear` lane (routes/observatory.py's _LANES) roots a
session in store.LINEAR_ROOM_DIR, a vault folder whose CLAUDE.md says which
team and which plan, and what must never be written to an outside service.

The page can't use the MCP: its login belongs to Claude. So the page's own
view of Linear goes through linear_api.py (Linear's GraphQL API, with a
personal key she pastes in once). Nothing from Linear is stored here. The
board is read live, with a short cache.

  GET  /api/linear-room          every conversation in the lane, archived
                                 included, newest first. Drawn by the Linear
                                 door on the roster and by its page. It never
                                 calls Linear, so the roster stays fast.
  GET  /api/linear-room/board    the team's issues grouped by status, what's
                                 waiting on her, what's blocked. Or, with no
                                 key, how to make one.
  POST/DELETE /api/linear-room/key            save (checked with Linear first)
                                              or forget the API key.
  POST /api/linear-room/issue/<id>/state      move an issue to another status.
  POST /api/linear-room/issue/<id>/assign     assign it, or unassign it.
  POST /api/linear-room/issue/<id>/comment    comment on it.
  POST /api/linear-room/issue/<id>/work       start (or reopen) a Linear
                                              session briefed with the issue.
  POST /api/linear-room/capture               a line she types becomes a new
                                              issue in Triage, or in Backlog
                                              when the team has no Triage.

Touches: routes/observatory.py (the lane profile, the running/tokens readers,
the model choices, the session id minting), linear_api.py, config.py (the
key), store.LINEAR_ROOM_DIR. Callers: the frontend's LinearDoor, LinearPage
and LinearBoard. The roster hides these sessions from the rooms (frontend
sessionFilters.roomRoster), the same way it hides research sessions.

Prompts that produced this: "add the linear MCP … we are going to be working
on my foods app together through it", then "i want the linear room to reflect
linear and the MCP … i want to be able to interact with linear from that room."
"""
import os
import tempfile

from flask import jsonify, request

import config
import linear_api
import store

LANE = "linear"

# The order a board reads left to right, by the kind of status. Linear lets a
# team name and add its own statuses, but every one of them has one of these
# types, so this order holds for any team.
_TYPE_ORDER = {"triage": 0, "backlog": 1, "unstarted": 2, "started": 3,
               "completed": 4, "canceled": 5, "duplicate": 6}
# Status types that mean the issue is finished, one way or another.
_CLOSED_TYPES = ("completed", "canceled", "duplicate")

# Where to make a key, said in the page's own words when there isn't one.
_KEY_HELP = ("In Linear, open Settings → Security & access → Personal API keys, "
             "make a key (read and write), and paste it into the box here. It's "
             "kept on this server only, in the data folder's linear_api_key file.")


def _room_rows(index):
    """Every Linear-lane conversation as a row for the door and the page.
    Membership is the lane, resolved — a session rooted in the room folder
    counts even if its entry never had the lane written on it."""
    from routes.observatory import _conv_lane, _effective_running, _session_tokens

    rows = []
    for cid, entry in index.items():
        if not isinstance(entry, dict) or _conv_lane(entry) != LANE:
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
            "linear_issue": entry.get("linear_issue") or None,
        }
        tokens = _session_tokens(cid)
        if tokens:
            row["tokens"] = tokens
        rows.append(row)
    rows.sort(key=lambda r: r["started"], reverse=True)
    return rows


# --- The board --------------------------------------------------------------

def _person(user):
    """A Linear user as the page names them. Linear's `name` is sometimes
    just the email address, and then the shorter display name reads better."""
    if not user:
        return None
    name = user.get("name") or ""
    if not name or "@" in name:
        name = user.get("displayName") or name
    return {"id": user.get("id"), "name": name}


def _capture_state(states):
    """The status a captured issue lands in: the team's Triage when it has
    one turned on, else its first Backlog status, else its first
    not-yet-started one."""
    for kind in ("triage", "backlog", "unstarted"):
        for state in states:
            if state["type"] == kind:
                return state
    return states[0] if states else None


def _shape_board(raw):
    """Turn Linear's raw answer into what the page draws: every status in
    board order with its issues, the open issues assigned to her, and, on
    each issue, what's still blocking it."""
    team = raw.get("team")
    viewer = raw.get("viewer") or {}
    viewer_id = viewer.get("id")
    # Statuses in board order: by kind first, then the team's own order.
    raw_states = sorted((team.get("states") or {}).get("nodes") or [],
                        key=lambda s: (_TYPE_ORDER.get(s["type"], 9), s.get("position") or 0))
    states = [{"id": s["id"], "name": s["name"], "type": s["type"], "color": s.get("color")}
              for s in raw_states]

    issues = []
    for node in (team.get("issues") or {}).get("nodes") or []:
        state = node.get("state") or {}
        # Blocked-by comes from the OTHER side of a "blocks" link: Linear
        # stores "A blocks B" on A, so B finds it among its inverse relations.
        # A blocker that's already finished no longer blocks anything.
        blocked_by = [
            {"identifier": rel["issue"]["identifier"], "title": rel["issue"]["title"]}
            for rel in (node.get("inverseRelations") or {}).get("nodes") or []
            if rel.get("type") == "blocks" and rel.get("issue")
            and (rel["issue"].get("state") or {}).get("type") not in _CLOSED_TYPES]
        blocks = [rel["relatedIssue"]["identifier"]
                  for rel in (node.get("relations") or {}).get("nodes") or []
                  if rel.get("type") == "blocks" and rel.get("relatedIssue")]
        assignee = _person(node.get("assignee"))
        is_open = state.get("type") not in _CLOSED_TYPES
        issues.append({
            "id": node["id"],
            "identifier": node.get("identifier") or "",
            "title": node.get("title") or "",
            "url": node.get("url") or "",
            "updated_at": node.get("updatedAt") or "",
            "state_id": state.get("id"),
            "assignee": assignee,
            "project": (node.get("project") or {}).get("name"),
            "milestone": (node.get("projectMilestone") or {}).get("name"),
            "blocked_by": blocked_by,
            "blocks": blocks,
            "blocked": is_open and bool(blocked_by),
            "open": is_open,
            "mine": bool(assignee and viewer_id and assignee["id"] == viewer_id),
        })

    columns = [{**state, "issues": [i for i in issues if i["state_id"] == state["id"]]}
               for state in states]
    members = [dict(_person(m), me=m.get("id") == viewer_id)
               for m in (team.get("members") or {}).get("nodes") or []
               if m.get("active", True)]
    capture = _capture_state(states)
    return {
        "configured": True,
        "team": {"id": team["id"], "key": team.get("key"), "name": team.get("name")},
        "viewer": _person(viewer),
        "members": members,
        "columns": columns,
        "waiting_on_you": [i for i in issues if i["mine"] and i["open"]],
        "capture_into": {"id": capture["id"], "name": capture["name"]} if capture else None,
        "issue_count": len(issues),
    }


def _not_configured(refused=False):
    """The board's answer when there's no usable key: say how to get one."""
    return jsonify({"configured": False, "refused": refused, "key_help": _KEY_HELP,
                    "key_from_env": bool(os.environ.get("EXOCORTEX_LINEAR_API_KEY"))})


def _current_board():
    """The shaped board, from the cache when it's fresh. Raises what
    linear_api raises; the routes below turn that into an answer."""
    raw = linear_api.board()
    if not raw.get("team"):
        raise linear_api.LinearError("The key works, but it can't see a Linear team.")
    return _shape_board(raw)


def _linear_failure(error):
    """One way to answer when Linear says no: a refused key sends the page
    back to the key box (409), anything else is shown as Linear said it (502).
    Not 401: the app's client reads a 401 as "you're logged out of this site"
    and sends her to the login page."""
    if isinstance(error, linear_api.LinearAuthError):
        return jsonify({"error": str(error), "refused": True}), 409
    return jsonify({"error": str(error)}), 502


# --- The key ----------------------------------------------------------------

def _save_key(key):
    """Write the key to its file, readable by this user only. Written to a
    temporary file and renamed into place, so a half-written key can't be read."""
    path = config.linear_api_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_path = tempfile.mkstemp(dir=path.parent, prefix=".linear_key.")
    try:
        os.fchmod(handle, 0o600)
        os.write(handle, key.encode("utf-8"))
    finally:
        os.close(handle)
    os.replace(temp_path, path)


# --- Work on this -----------------------------------------------------------

def _work_brief(issue):
    """The first message a "Work on this" session reads: the issue as Linear
    has it, and how to report back through the MCP. The issue's words are
    quoted as the issue's. Her collaborator can write them, so they're
    material to work from, not orders."""
    # Name the owner from the profile, never from code. The brief tells the
    # session whose private life stays out of Linear and who to ask, so it
    # needs her name — read from config.get_profile, "the owner" when unset.
    owner = (config.get_profile().get("owner_name") or "").strip() or "the owner"
    lines = [
        f"Work on Linear issue **{issue['identifier']}: {issue['title']}**",
        f"Link: {issue.get('url') or ''}",
        f"Status now: {(issue.get('state') or {}).get('name') or 'unknown'}"
        + (f" · Project: {issue['project']['name']}" if issue.get("project") else "")
        + (f" · Milestone: {issue['projectMilestone']['name']}" if issue.get("projectMilestone") else ""),
        "",
        "## What the issue says",
        "",
        (issue.get("description") or "(no description)").strip(),
    ]
    comments = ((issue.get("comments") or {}).get("nodes") or [])
    if comments:
        lines += ["", "## Latest comments", ""]
        for comment in comments:
            who = _person(comment.get("user")) or {"name": "someone"}
            lines.append(f"- **{who['name']}** ({(comment.get('createdAt') or '')[:10]}): "
                         + (comment.get("body") or "").strip().replace("\n", " ")[:600])
    lines += [
        "",
        "## How to work it",
        "",
        f"- Read the issue in full with the `linear` MCP (`get_issue {issue['identifier']}`) "
        "and check it against this room's CLAUDE.md and the plan before starting.",
        "- When you start, move it to **In Progress** (or the team's started status) "
        "and comment on it saying what you're about to do.",
        "- Comment on the issue as you reach real milestones, written so the "
        f"collaborator can read it cold. Nothing about {owner}'s private life goes in.",
        "- When it's finished, comment with what was done and move it to Done. "
        "If you stop short, leave it in progress and say in a comment what's left.",
        f"- Anything unclear or big, ask {owner} here first.",
    ]
    return "\n".join(lines)


def _live_session_for(index, identifier):
    """An open (not archived) Linear session already working this issue, so
    a second tap reopens it instead of starting a duplicate."""
    for conv_id, entry in index.items():
        if isinstance(entry, dict) and entry.get("linear_issue") == identifier \
                and not entry.get("archived"):
            return conv_id
    return None


def register(app):

    @app.route("/api/linear-room")
    def linear_room_list():
        """Every Linear session, archived included, newest first — plus the
        model choices, so the page's "+ New Linear session" sheet offers the
        same picker the roster does."""
        from routes.observatory import _MODEL_CHOICES

        rows = _room_rows(store.read("bot_chats/index", {}))
        return jsonify({
            "sessions": rows,
            "running": sum(1 for r in rows if r["running"]),
            "failed": sum(1 for r in rows if r["last_error"] and not r["archived"]),
            "model_choices": list(_MODEL_CHOICES),
        })

    @app.route("/api/linear-room/board")
    def linear_room_board():
        """The team's board, read live from Linear. `?fresh=1` skips the
        half-minute cache (the page's refresh button)."""
        if not config.linear_api_key():
            return _not_configured()
        try:
            if request.args.get("fresh"):
                linear_api.forget_board()
            return jsonify(_current_board())
        except linear_api.LinearAuthError:
            return _not_configured(refused=True)
        except linear_api.LinearError as error:
            return _linear_failure(error)

    @app.route("/api/linear-room/key", methods=["POST"])
    def linear_room_key_save():
        """Save a pasted API key, after Linear confirms it works. The answer
        names whose key it is and never repeats the key back."""
        key = str((request.json or {}).get("key") or "").strip()
        if not key or len(key) > 200 or any(c.isspace() for c in key):
            return jsonify({"error": "That doesn't look like a Linear API key."}), 400
        try:
            who = linear_api.viewer(key=key)
        except linear_api.LinearAuthError:
            return jsonify({"error": "Linear refused that key. Check it was copied whole."}), 400
        except linear_api.LinearError as error:
            return _linear_failure(error)
        _save_key(key)
        linear_api.forget_board()
        return jsonify({"ok": True, "name": (_person(who) or {}).get("name")})

    @app.route("/api/linear-room/key", methods=["DELETE"])
    def linear_room_key_forget():
        """Forget the saved key. An env-var key isn't touched; that one is
        the install's to change."""
        try:
            config.linear_api_key_path().unlink()
        except FileNotFoundError:
            pass
        linear_api.forget_board()
        return jsonify({"ok": True})

    @app.route("/api/linear-room/issue/<issue_id>/state", methods=["POST"])
    def linear_room_issue_state(issue_id):
        """Move an issue to another of the team's statuses. Only a status the
        team actually has is accepted."""
        state_id = str((request.json or {}).get("state_id") or "")
        try:
            board = _current_board()
            if not any(c["id"] == state_id for c in board["columns"]):
                return jsonify({"error": "That isn't one of the team's statuses."}), 400
            linear_api.update_issue(issue_id, {"stateId": state_id})
        except linear_api.LinearError as error:
            return _linear_failure(error)
        return jsonify({"ok": True})

    @app.route("/api/linear-room/issue/<issue_id>/assign", methods=["POST"])
    def linear_room_issue_assign(issue_id):
        """Assign an issue to someone on the team, or unassign it
        (`assignee_id: null`)."""
        assignee_id = (request.json or {}).get("assignee_id")
        try:
            board = _current_board()
            if assignee_id is not None and not any(m["id"] == assignee_id for m in board["members"]):
                return jsonify({"error": "That person isn't on the team."}), 400
            linear_api.update_issue(issue_id, {"assigneeId": assignee_id})
        except linear_api.LinearError as error:
            return _linear_failure(error)
        return jsonify({"ok": True})

    @app.route("/api/linear-room/issue/<issue_id>/comment", methods=["POST"])
    def linear_room_issue_comment(issue_id):
        """Comment on an issue, as her."""
        body = str((request.json or {}).get("body") or "").strip()
        if not body:
            return jsonify({"error": "The comment is empty."}), 400
        try:
            linear_api.add_comment(issue_id, body[:10000])
        except linear_api.LinearError as error:
            return _linear_failure(error)
        return jsonify({"ok": True})

    @app.route("/api/linear-room/capture", methods=["POST"])
    def linear_room_capture():
        """Quick capture: the first line she typed becomes the issue's title,
        anything after it the description. It lands where the team sorts new
        things (see _capture_state)."""
        text = str((request.json or {}).get("text") or "").strip()
        if not text:
            return jsonify({"error": "Nothing to capture."}), 400
        title, _, description = text.partition("\n")
        try:
            board = _current_board()
            if not board["capture_into"]:
                return jsonify({"error": "The team has no status to put it in."}), 400
            created = linear_api.create_issue(board["team"]["id"], title.strip()[:250],
                                              description.strip(), board["capture_into"]["id"])
        except linear_api.LinearError as error:
            return _linear_failure(error)
        return jsonify({"ok": True, "identifier": created.get("identifier"),
                        "url": created.get("url"), "status": board["capture_into"]["name"]})

    @app.route("/api/linear-room/issue/<issue_id>/work", methods=["POST"])
    def linear_room_issue_work(issue_id):
        """"Work on this": a Linear-lane session that starts on the issue as
        soon as she opens it. Staged the way /spinoff stages one: the brief
        is the session's `draft` and `autostart` makes the chat send it on
        open (ObservatoryPage), and the first send clears both. An open
        session already on this issue is handed back instead."""
        from routes.observatory import (_MODEL_CHOICES, _chats_dir, _lane_profile,
                                        _new_conv_id, _now)

        model = str((request.json or {}).get("model") or "").strip()
        if model and model not in _MODEL_CHOICES:
            return jsonify({"error": f"unknown model {model!r}"}), 400
        try:
            issue = linear_api.issue(issue_id)
        except linear_api.LinearError as error:
            return _linear_failure(error)
        if not issue:
            return jsonify({"error": "Linear has no such issue."}), 404

        profile = _lane_profile(LANE)
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            existing = _live_session_for(index, issue["identifier"])
            if existing:
                return jsonify({"ok": True, "id": existing, "existing": True})
            conv_id = _new_conv_id(index)
            index[conv_id] = {
                "bot": "keeper", "started": _now(), "last_at": _now(),
                "claude_session_id": None, "cost_usd": 0.0,
                "title": f"{issue['identifier']}: {issue['title']}"[:60],
                "journal": False, "lane": LANE, "cwd": profile["cwd"],
                "allowed_tools": list(profile["allowed_tools"]),
                "linear_issue": issue["identifier"],
                "draft": _work_brief(issue), "autostart": True,
            }
            if model:
                index[conv_id]["model"] = model
        return jsonify({"ok": True, "id": conv_id, "existing": False})
