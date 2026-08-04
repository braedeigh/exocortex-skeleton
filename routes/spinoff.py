"""Spinoff — the shared spawn door for /spinoff.

A skill in any Claude session writes a brief to SPINOFF_DIR/<slug>/BRIEF.md and
calls this; it mints an Observatory conversation (routes/observatory.py)
config'd as a builder session and starts it working. The brief travels by FILE,
never typed/shell-interpolated anywhere — only the fixed, short kickoff sentence
below is ever staged.

A spinoff lands in the ROOM ITS SENDER IS STANDING IN — a /spinoff run from a
Personal-room session mints a Personal child, from Orchestra an Orchestra one —
unless the caller names a room outright. The room isn't decoration: it picks the
child's cwd and whether it stops to ask before irreversible work (_lane_profile
in routes/observatory.py), so a spinoff off a conversation about the vault used
to land rooted in the app checkout, gated, in a different room from the work it
came out of. The sender is identified by EXOCORTEX_CONV_ID, which observatory.py
puts in every turn's environment; see _inherit_lane for what happens when
there's no sender to read.

An ORCHESTRA spinoff also gets its OWN COPY of the app checkout — a git
worktree on its own `agent/<slug>` branch, minted here and used as its cwd for
life (worktrees.py). That room is the unwatched one, and two unwatched agents
editing one folder is how sessions have twice committed each other's
half-written files. Coding and Personal do NOT get one: those are her own
hands, and they need the real checkout because that's what gunicorn serves and
what she refreshes. The trade an Orchestra session makes is that it cannot see
its change in a browser — its proof is a test run.

A spun-off session STARTS WORKING IMMEDIATELY — she doesn't have to open it, or
even be at the machine. A turn is hosted by a detached thread in whichever
process took the send, so it needs a process that outlives this call; the
standalone CLI door can't be that, and neither can a request. So the mint hands
off to scripts/spinoff_runner.py, launched detached, which posts the kickoff
through the real send route and stays alive until the turn ends.

The entry keeps `draft`+`autostart` anyway, as the fallback for a runner that
never starts: opening the session then fires the kickoff the old way. The two
can't both land — whichever send arrives first pops both fields, and a second
send into a running conversation is refused with a 409.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

from flask import jsonify, request

import store
import worktrees
from routes.observatory import (_BUILDER_TOOLS, _DEFAULT_LANE, _LANES,
                                _chats_dir, _conv_lane, _lane_profile,
                                _new_conv_id, _now)

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")


def _inherit_lane(index):
    """Which room a spinoff lands in when nobody named one: the SENDER'S room.

    Every Observatory turn runs with its own conversation id in
    EXOCORTEX_CONV_ID (routes/observatory.py's _spawn), and a /spinoff shells
    out from inside such a turn — so the child can be handed the room the
    parent is standing in by looking the parent up in the same index we're
    already holding.

    A sender we can't place — no env var at all (a plain terminal, cron, a
    test), an id that isn't in the index — falls to ORCHESTRA, the gated room,
    on the same fail-toward-ask principle as _conv_lane: an unknown sender
    guessed into Personal would silently hand a session more autonomy than
    anyone granted it.
    """
    sender = os.environ.get("EXOCORTEX_CONV_ID")
    entry = index.get(sender) if sender else None
    return _conv_lane(entry) if isinstance(entry, dict) else _DEFAULT_LANE


def _live_conv_for(index, slug):
    """The spinoff's existing, non-archived conversation — or None."""
    return next((cid for cid, entry in index.items()
                 if isinstance(entry, dict) and entry.get("spinoff_slug") == slug
                 and not entry.get("archived")), None)


def open_spinoff(slug, start=True, lane=None, worktree=None):
    """Core shared by the route and scripts/spinoff_open.py (the agents' door).

    Mints (or rejoins) an Observatory conversation for the spinoff and, by
    default, starts it working immediately via _launch_runner — nobody has to
    open it. The reply's `started` says whether that launch happened;
    `staged`/`autostart` describe the fallback still sitting on the entry, not
    a wait for her send. A re-invocation against a spinoff that already has a
    live (non-archived) conversation is a rejoin, not a restart, and leaves
    that conversation untouched — including not re-firing it.

    `lane` names the room outright ("personal"/"coding"/"orchestra"); left None it's
    inherited from the sending session (_inherit_lane). The room supplies cwd
    and the safety-net defaults via _lane_profile; act_gate/guard_docs are
    deliberately NOT written onto the entry, same as the create route, so the
    room keeps driving them and moving the card between rooms re-scopes it.

    `start=False` mints WITHOUT launching, for callers whose fork must not run
    beside the thing it forked from: the observatory's fork-the-work route
    hands her a take-over session on purpose, to be opened after she stops the
    original, because two agents editing one session's files is the failure it
    exists to avoid.

    `worktree=False` opts out of the private copy of the repo an ORCHESTRA
    spinoff otherwise gets (see worktrees.py). Only Orchestra gets one at all:
    Coding and Personal are her own hands, and they need the real checkout
    because that's the one gunicorn serves and the one she refreshes.
    """
    if not SLUG_RE.match(slug or ""):
        return {"error": "bad slug"}, 400
    if lane is not None and lane not in _LANES:
        return {"error": f"unknown room {lane!r}"}, 400

    brief = store.SPINOFF_DIR / slug / "BRIEF.md"
    if not brief.exists():
        return {"error": f"no brief at {brief}"}, 400

    _chats_dir()   # the index (and its .lock) lives inside it

    # Read first, WITHOUT the lock, only to decide the room and to skip minting
    # for an obvious rejoin. Cutting a worktree copies the tree and takes about
    # a second; the index lock is taken by every send in the app, so holding it
    # across that would stall live turns. The authoritative check is the locked
    # one below — this read can be stale and it costs nothing when it is.
    snapshot = store.read("bot_chats/index", {})
    if _live_conv_for(snapshot, slug):
        cid = _live_conv_for(snapshot, slug)
        return {"ok": True, "conversation_id": cid, "newly_spawned": False,
                "lane": _conv_lane(snapshot[cid]), "brief": str(brief)}, 200

    # The room decides where the child is rooted — the app checkout for Coding,
    # the parent of both repos for Personal, its OWN copy of the checkout for
    # Orchestra — and cwd is the one thing a session can never change
    # afterwards, which is why it's settled here at birth.
    room = lane or _inherit_lane(snapshot)
    profile = _lane_profile(room)
    cwd, wt_path, branch, wt_error = profile["cwd"], None, None, None
    if room == "orchestra" and worktree is not False:
        try:
            wt_path, branch = worktrees.mint(slug)
            cwd = str(wt_path)
        except (worktrees.WorktreeError, OSError, subprocess.SubprocessError) as e:
            # A spinoff that couldn't get its own copy still runs, in the shared
            # checkout — the same "degraded is still usable" call _launch_runner
            # makes. But it is NOT silent: the flag rides on the entry so the
            # card can say so, because the whole point of the copy is that
            # nobody has to remember which sessions are sharing a tree.
            wt_error = f"{type(e).__name__}: {e}"

    kickoff = (f"Read {brief} and follow its Protocol section exactly — "
               "it defines this session's job.")

    raced = None
    with store.mutate("bot_chats/index", {}) as index:
        raced = _live_conv_for(index, slug)
        if not raced:
            conv_id = _new_conv_id(index)
            index[conv_id] = {
                "bot": "keeper", "spinoff_slug": slug, "title": f"spin: {slug}",
                "started": _now(), "last_at": _now(), "claude_session_id": None,
                "cost_usd": 0.0, "journal": False, "lane": room,
                "cwd": cwd,
                "allowed_tools": list(profile["allowed_tools"]), "draft": kickoff,
                "autostart": True,
            }
            if wt_path:
                index[conv_id]["worktree"] = str(wt_path)
                index[conv_id]["branch"] = branch
            if wt_error:
                index[conv_id]["worktree_failed"] = wt_error

    # Somebody else minted this slug while we were cutting the copy. Theirs
    # wins (it's the one in the index); ours is an orphan directory nothing
    # points at, so it goes back — outside the lock, like every git call here.
    if raced:
        if wt_path:
            worktrees.remove(wt_path)
        return {"ok": True, "conversation_id": raced, "newly_spawned": False,
                "lane": _conv_lane(store.read("bot_chats/index", {})[raced]),
                "brief": str(brief)}, 200

    # Outside the index lock — launching a runner that immediately posts a send
    # (which takes that same lock) while still holding it would deadlock.
    started = _launch_runner(conv_id, kickoff) if start else False

    return {
        "ok": True,
        "conversation_id": conv_id,
        "newly_spawned": True,
        "lane": room,
        "started": started,
        "staged": True,
        "autostart": True,
        "brief": str(brief),
        "worktree": str(wt_path) if wt_path else None,
        "branch": branch,
        "worktree_failed": wt_error,
    }, 200


def _launch_runner(conv_id, kickoff):
    """Start the session working now, without waiting for her to open it.

    The turn has to be hosted by a process that outlives this call — a daemon
    thread started here would die with the CLI door — so the kickoff goes to a
    detached scripts/spinoff_runner.py, which posts it through the real send
    route and stays alive draining the stream until the turn ends.

    The kickoff travels by FILE, never on the command line: it's short and
    fixed today, but an argv-borne prompt is one refactor away from being
    shell-interpolated, and the brief-by-file doctrine exists for that reason.

    Returns True if the runner was launched. False is not fatal and is not
    retried — the entry still carries draft+autostart, so opening the session
    fires the kickoff the old way. Never raises: a spinoff that minted but
    couldn't self-start is still a usable spinoff.
    """
    runner = Path(__file__).resolve().parents[1] / "scripts" / "spinoff_runner.py"
    if not runner.exists():
        return False
    try:
        kick_dir = store.SPINOFF_DIR / ".kickoffs"
        kick_dir.mkdir(parents=True, exist_ok=True)
        kick_path = kick_dir / f"{conv_id}.txt"
        kick_path.write_text(kickoff, encoding="utf-8")
        log_path = kick_dir / f"{conv_id}.log"
        with open(log_path, "ab") as log:
            subprocess.Popen(
                [sys.executable, str(runner), conv_id, str(kick_path)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                # Its own session: the runner must survive this request, this
                # worker, and (from the CLI door) the script that spawned it.
                start_new_session=True,
            )
        return True
    except (OSError, ValueError):
        return False


def register(app):

    @app.route("/api/spinoff/open", methods=["POST"])
    def spinoff_open():
        # `lane` is optional and names the room; omitted, the spinoff inherits
        # the sending session's. Spelled `lane` to match the sibling create
        # route (/api/observatory/conversations), `room` because that's what
        # the two of them are called out loud.
        data = request.json or {}
        lane = data.get("lane") or data.get("room")
        # `worktree: false` keeps an Orchestra spinoff in the shared checkout.
        # Absent means yes — the protection has to be the default, or it's only
        # there when somebody remembers to ask for it.
        payload, status = open_spinoff(
            data.get("slug", ""), lane=(lane or "").strip() or None,
            worktree=False if data.get("worktree") is False else None)
        return jsonify(payload), status
