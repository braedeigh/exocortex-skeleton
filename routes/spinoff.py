"""Spinoff — the shared spawn door for /spinoff.

A skill in any Claude session saves a brief under a slug (scripts/
spinoff_brief.py, which takes it on standard input) and calls this; it mints
an Observatory conversation (routes/observatory.py) config'd as a builder
session and starts it working. The session's first message is the brief's own
text, so she can read in the chat what it was asked to do; the files the brief
lists under "Where to look" (and the default Protocol, when the brief has
none) are pasted into its hidden instructions — see "The kickoff" below.

Briefs live in the database, not in files (briefstore.py, docs/
spinoff-briefs.md): the brief, the hidden instructions built from it and any
handoff are rows in exo.db, and a session's entry carries `spinoff_brief`, its
brief's row id. GET /api/spinoff/brief/<conv> reads them back for the
session's brief page. A brief still never rides a command line: it reaches the
door on standard input and the runner by file.

A spinoff lands in the ROOM ITS SENDER IS STANDING IN — a /spinoff run from a
Personal-room session mints a Personal child, from Coding a Coding one — unless
the caller names a room outright. The room isn't decoration: it picks the
child's cwd and whether it stops to ask before irreversible work (_lane_profile
in routes/observatory.py), so a spinoff off a conversation about the vault used
to land rooted in the app checkout, gated, in a different room from the work it
came out of. The sender is identified by EXOCORTEX_CONV_ID, which observatory.py
puts in every turn's environment; see _inherit_lane for what happens when
there's no sender to read.

A spinoff works in the shared checkout; it never gets a fresh copy of the repo
of its own. (It used to, in the Orchestra room — that part is in the shed:
shed/orchestra-2026-09-25/SHED.md.) The one exception is the steward door:
given an EXISTING agent/* branch, the child is stood on that branch in its own
git worktree (worktrees.adopt), because that branch's work lives nowhere else.

A spun-off session STARTS WORKING IMMEDIATELY — she doesn't have to open it, or
even be at the machine. A turn is hosted by a detached thread in whichever
process took the send, so it needs a process that outlives this call; the
standalone CLI door can't be that, and neither can a request. So the mint hands
off to scripts/spinoff_runner.py, launched detached, which posts the kickoff
through the real send route and stays alive until the turn ends.

Before any of that, the sender usually OFFERS rather than spawns: the skill
calls scripts/spinoff_offer.py, which puts `spinoff_offer` on the sender's own
conversation, and her chat grows a Go button (frontend SpinoffOffer.tsx). Go
(POST /api/spinoff/offer/<conv>/go) runs open_spinoff for each slug and takes
her to the new session, which asks whether to close the one she came from.
Not tapping it and simply talking on is the other answer; the offer waits
until she taps Go or ×, or the agent offers again.

The entry keeps `draft`+`autostart` anyway, as the fallback for a runner that
never starts: opening the session then fires the kickoff the old way. The two
can't both land — whichever send arrives first pops both fields, and a second
send into a running conversation is refused with a 409.
"""
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from flask import jsonify, request

import briefstore
import store
import worktrees
from routes.observatory import (_BUILDER_TOOLS, _CONV_ID_RE, _DEFAULT_LANE, _LANES,
                                _MODEL_CHOICES, _chats_dir, _conv_lane,
                                _lane_profile, _new_conv_id, _now)

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")

# How long a kickoff's paperwork sticks around. The .txt is the kickoff (the
# brief's text) handed to the runner and is deleted the moment it's been read; the
# .log is where a detached runner's stderr lands, and it is the ONLY trace when
# a spawn fails to start. Every log on disk here has been zero bytes — which is
# the argument for pruning them, not for removing the channel: a fortnight is
# long enough to still be diagnosing a spawn that never woke up.
KICKOFF_KEEP_DAYS = 14


def archive_spinoff(slug):
    """Move a finished session's brief FOLDER out of the live folder. Never deletes.

    Only for a session born before briefs moved to the database: it has a
    `spinoffs/<slug>/` folder, and closing it files that folder. A session born
    since has no folder (its brief is a row, which stays where it is), and
    this is a no-op for it.

    Slugs get REUSED — the spawn door rejoins an existing slug, and a later
    spinoff can legitimately take the same name — so an archive collision is a
    real case and it must not clobber the older record. The incoming one takes
    a numbered suffix instead.

    Best-effort and never raises: failing to tidy up must not fail a close.
    Returns the path it filed to, or None if there was nothing to file.
    """
    if not SLUG_RE.match(slug or ""):
        return None
    src = store.SPINOFF_DIR / slug
    if not src.is_dir():
        return None
    try:
        store.SPINOFF_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        dest = store.SPINOFF_ARCHIVE_DIR / slug
        n = 2
        while dest.exists():
            dest = store.SPINOFF_ARCHIVE_DIR / f"{slug}-{n}"
            n += 1
        # rename first: same filesystem in every normal install, and atomic.
        # shutil covers an archive dir pointed at another disk by env.
        try:
            src.rename(dest)
        except OSError:
            shutil.move(str(src), str(dest))
        return dest
    except (OSError, ValueError):
        return None


def _prune_kickoffs():
    """Drop kickoff paperwork older than KICKOFF_KEEP_DAYS.

    Runs on each spawn rather than on a clock: the folder only grows when
    something is spawned, so the thing that dirties it is the right thing to
    tidy it. Unlike a brief this carries no record — the .txt is a copy of the
    brief's text, and the .log is empty unless a spawn broke.
    """
    kick_dir = store.SPINOFF_DIR / ".kickoffs"
    cutoff = time.time() - KICKOFF_KEEP_DAYS * 86400
    try:
        for path in kick_dir.glob("*"):
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                continue
    except OSError:
        pass


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
    sender = _sender_conv(index)
    return _conv_lane(index[sender]) if sender else _DEFAULT_LANE


def _sender_conv(index):
    """The conversation this call is being made FROM, or None.

    Read off EXOCORTEX_CONV_ID, which every Observatory turn carries, and only
    believed if that id is really in the index — a stale or foreign id names
    no one. A web request (Go, the fork button, a helper button) has no such
    variable, so those callers name the parent outright instead.
    """
    sender = os.environ.get("EXOCORTEX_CONV_ID")
    return sender if sender and isinstance(index.get(sender), dict) else None


def _live_conv_for(index, slug):
    """The spinoff's existing, non-archived conversation — or None."""
    return next((cid for cid, entry in index.items()
                 if isinstance(entry, dict) and entry.get("spinoff_slug") == slug
                 and not entry.get("archived")), None)


# --- The kickoff: the brief itself, with its files preloaded -----------------
# A spinoff's first message IS its brief, so she can read in the chat what the
# session was asked to do. The files the brief lists under "## Where to look"
# are pasted into the session's hidden instructions (kept in the database as
# the brief's context — briefstore.py), because a session only ASKED to read them
# opened 60 of 69 across six measured spinoffs, and skipped mostly the tests.
# A brief with no Protocol of its own gets the default one in there too.
#
# Prompt: "The spinoff's first message should be the brief text, not 'Read
# <path>/BRIEF.md'. Where to look is one path per line; files listed are
# loaded. Should I have it read them or inject them? If it's sturdy enough to
# ask it to read them all, hybrid." (Measured: not sturdy — inject.)

PROTOCOL_FILE = (Path(__file__).resolve().parents[1]
                 / "claude-commands" / "spinoff" / "protocol.md")
PRELOAD_FILE_MAX = 60_000     # characters; a bigger file is read by the session
PRELOAD_TOTAL_MAX = 200_000   # the whole snapshot; the Keeper boots on ~214 KB

_LOOK_LINE_RE = re.compile(r"^(?P<path>.+?)(?::(?P<start>\d+)(?:-(?P<end>\d+))?)?$")


def _section(text, heading):
    """The body of `## heading` in a Markdown brief, or None if it's absent."""
    match = re.search(rf"^##\s+{re.escape(heading)}\s*$(.*?)(?=^##\s|\Z)",
                      text, re.M | re.S)
    return match.group(1) if match else None


def _where_to_look(brief_text, cwd):
    """Read the brief's "## Where to look" list. Returns (entries, errors).

    One path per line: `- path`, backticks optional, `path:12-80` for a line
    range, and anything after a space is a note for the reader. A relative
    path is taken from the child's cwd. Every line must name a file that
    exists — a list is refused whole rather than preloading half of it, since
    a missing file is almost always a typo the sender can fix in a second.
    Each entry is (as_written, Path, start, end)."""
    body = _section(brief_text, "Where to look")
    if body is None:
        return [], []
    entries, errors = [], []
    for line in body.splitlines():
        token = re.sub(r"^\s*[-*]\s+", "", line).strip()
        if not token:
            continue
        token = token.split()[0].strip("`")
        match = _LOOK_LINE_RE.match(token)
        path = Path(match.group("path")).expanduser()
        if not path.is_absolute():
            path = Path(cwd) / path
        if not path.is_file():
            errors.append(token)
            continue
        start = int(match.group("start")) if match.group("start") else None
        end = int(match.group("end")) if match.group("end") else start
        entries.append((token, path, start, end))
    return entries, errors


def _build_context(brief_text, entries):
    """Build the session's hidden instructions. Returns (text, preloaded, too_big).

    The default Protocol goes in when the brief has none of its own (the app's
    own briefs — triage, helpers, forks, stewards — carry theirs, and it shows
    in the chat with the rest of the brief). Then each listed file, fenced,
    under its path, until the size caps; what doesn't fit, or isn't text, is
    returned as `too_big` for the kickoff to name. `text` is None when there
    was nothing to put in it, so the brief gets no context at all."""
    parts, preloaded, too_big, total = [], [], [], 0
    if _section(brief_text, "Protocol") is None:
        parts.append(PROTOCOL_FILE.read_text(encoding="utf-8").strip())
    snapshots = []
    for as_written, path, start, end in entries:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            too_big.append(as_written)
            continue
        if start:
            text = "\n".join(text.splitlines()[start - 1:end])
        if len(text) > PRELOAD_FILE_MAX or total + len(text) > PRELOAD_TOTAL_MAX:
            too_big.append(as_written)
            continue
        total += len(text)
        # A fence one backtick longer than any run inside, so a Markdown file
        # full of code blocks can't close it early.
        fence = "`" * max(3, max((len(r) for r in re.findall(r"`+", text)), default=0) + 1)
        span = f" (lines {start}-{end})" if start else ""
        snapshots.append(f"### {path}{span}\n{fence}\n{text}\n{fence}")
        preloaded.append(as_written)
    if snapshots:
        parts.append(f"## Preloaded files (snapshot taken {_now()})\n\n"
                     "The files the brief lists, as they were when you were "
                     "spun off. Read a file yourself before you edit it.\n\n"
                     + "\n\n".join(snapshots))
    if not parts:
        return None, preloaded, too_big
    return "\n\n".join(parts) + "\n", preloaded, too_big


def _kickoff_text(brief_text, preloaded, too_big):
    """The first message: the brief as written, then a line naming what was
    preloaded and what the session must still read itself."""
    lines = [brief_text.rstrip()]
    footer = []
    if preloaded:
        footer.append("Preloaded into your instructions: " + ", ".join(preloaded))
    if too_big:
        footer.append("Too big to preload — read these yourself first: "
                      + ", ".join(too_big))
    if footer:
        lines += ["", "---", *footer]
    return "\n".join(lines) + "\n"


def open_spinoff(slug, start=True, lane=None, model=None, branch=None,
                 parent=None, via=None, brief_id=None):
    """Core shared by the route and scripts/spinoff_open.py (the agents' door).

    Mints (or rejoins) an Observatory conversation for the spinoff and, by
    default, starts it working immediately via _launch_runner — nobody has to
    open it. The reply's `started` says whether that launch happened;
    `staged`/`autostart` describe the fallback still sitting on the entry, not
    a wait for her send. A re-invocation against a spinoff that already has a
    live (non-archived) conversation is a rejoin, not a restart, and leaves
    that conversation untouched — including not re-firing it.

    `lane` names the room outright ("personal"/"coding"/"orchestra"/"research"
    — validated against observatory._LANES, so a lane added there is accepted
    here without a second list to keep in step); left None it's inherited from
    the sending session (_inherit_lane). The room supplies cwd
    and the safety-net defaults via _lane_profile; act_gate/guard_docs are
    deliberately NOT written onto the entry, same as the create route, so the
    room keeps driving them and moving the card between rooms re-scopes it.

    `start=False` mints WITHOUT launching, for callers whose fork must not run
    beside the thing it forked from: the observatory's fork-the-work route
    hands her a take-over session on purpose, to be opened after she stops the
    original, because two agents editing one session's files is the failure it
    exists to avoid.

    `model` pins the child to one of _MODEL_CHOICES ("fable", "opus", …); left
    None it inherits the CLI default like every other conversation. Validated
    here the same way `lane` is, and written onto the entry at mint so even
    the kickoff turn runs on the pinned model — the interim pin-after-spawn
    trick only caught the second turn onward.

    `branch` stands the child on an EXISTING agent/* branch, in its own git
    worktree — the steward door (routes/branches.py), and the same seam a
    future checker-escalation spawner calls: one door, a mode, not a new
    organ. Without `branch` there is no worktree at all. A failed adoption
    refuses the whole spawn rather than falling back to the shared checkout —
    a session that believes it stands on a branch and doesn't is the exact
    lie the worktree exists to prevent.

    `parent` / `via` record where the child came from, so sessions can be
    drawn as a family tree (see docs/spinoff-lineage.md). `parent` is the
    conversation id it was spun off from; left None it's the calling session
    (_sender_conv), which is right for the skill's script door. `via` says
    how: "skill", "go", "fork", "helper", "steward" — left None it's "skill"
    when there is a calling session and "app" when there isn't. Written only
    at mint; a rejoin never rewrites a child's parentage.

    The brief is read from the database: the newest one saved under `slug`
    (briefstore.to_open). `brief_id` names one row outright instead, and skips
    the rejoin — a continuation (continuation.py) keeps its job's slug, and the
    session it continues is still live under that slug when it is opened.

    The kickoff is the brief's text (_kickoff_text), and a brief whose "Where
    to look" names a file that doesn't exist is refused with a 400 before
    anything is minted. The listed files are preloaded into the brief's context
    (_build_context), kept in the database beside the brief; the entry carries
    `spinoff_brief`, and each turn is handed the context from there
    (routes/observatory.py begin_turn).
    """
    if not SLUG_RE.match(slug or ""):
        return {"error": "bad slug"}, 400
    if lane is not None and lane not in _LANES:
        return {"error": f"unknown room {lane!r}"}, 400
    if branch is not None and not branch.startswith("agent/"):
        # Stewards adopt agents' work. main (or anything hand-made) is never
        # a thing this door stands a session on.
        return {"error": "only an agent/* branch can be adopted"}, 400
    if model is not None and model not in _MODEL_CHOICES:
        return {"error": f"unknown model {model!r} "
                         f"(choices: {', '.join(_MODEL_CHOICES)})"}, 400

    _chats_dir()   # the index (and its .lock) lives inside it

    # Read first, WITHOUT the lock, only to decide the room and to skip minting
    # for an obvious rejoin. Cutting a worktree copies the tree and takes about
    # a second; the index lock is taken by every send in the app, so holding it
    # across that would stall live turns. The authoritative check is the locked
    # one below — this read can be stale and it costs nothing when it is.
    snapshot = store.read("bot_chats/index", {})
    rejoin = brief_id is None
    if rejoin and _live_conv_for(snapshot, slug):
        cid = _live_conv_for(snapshot, slug)
        return {"ok": True, "conversation_id": cid, "newly_spawned": False,
                "lane": _conv_lane(snapshot[cid]),
                "brief": snapshot[cid].get("spinoff_brief")}, 200

    # Find the brief to start from: the named row, else the newest one saved
    # under this slug.
    brief = briefstore.get(brief_id) if brief_id else briefstore.to_open(slug)
    if brief is None or brief["slug"] != slug:
        return {"error": f"no brief saved for {slug!r} — save one first: "
                         "scripts/spinoff_brief.py <slug> (the brief on standard input)"}, 400

    # The room decides where the child is rooted — the app checkout for Coding,
    # the parent of both repos for Personal — and cwd is the one thing a
    # session can never change afterwards, which is why it's settled here at
    # birth.
    room = lane or _inherit_lane(snapshot)
    # Who this is spun off from — named by the caller, else the session
    # making the call. Settled here, beside the room, for the same reason:
    # it's a fact about the birth.
    parent = parent or _sender_conv(snapshot)
    via = via or ("skill" if parent else "app")
    if branch is not None and room != "orchestra":
        # Adoption is steward work, which runs in the gated room — nobody is
        # watching it. Any other room here is a caller bug, refused loudly.
        return {"error": "adopting a branch needs the orchestra room"}, 400
    profile = _lane_profile(room)
    cwd, wt_path, wt_branch = profile["cwd"], None, None
    # Check the brief's file list before anything is made: a path that
    # doesn't exist refuses the spawn, so nothing needs undoing.
    brief_text = brief["body"]
    entries, missing = _where_to_look(brief_text, cwd)
    if missing:
        return {"error": "Where to look names files that don't exist: "
                         + ", ".join(missing)}, 400
    # Stand a steward on its branch, in its own worktree. Only with `branch`;
    # a plain spinoff stays in the room's cwd.
    if branch:
        try:
            wt_path, wt_branch = worktrees.adopt(slug, branch)
            cwd = str(wt_path)
        except (worktrees.WorktreeError, OSError, subprocess.SubprocessError) as e:
            return {"error": f"couldn't stand on {branch}: {e}"}, 409

    # The first message is the brief itself; its files and (if it has none of
    # its own) the Protocol ride in the hidden instructions.
    context, preloaded, too_big = _build_context(brief_text, entries)
    kickoff = _kickoff_text(brief_text, preloaded, too_big)

    raced = None
    with store.mutate("bot_chats/index", {}) as index:
        raced = _live_conv_for(index, slug) if rejoin else None
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
            # The family-tree link: parent id plus how it was spawned.
            index[conv_id]["spawned_via"] = via
            if parent:
                index[conv_id]["spawned_from"] = parent
            # Which brief row this session was started on. Its context, if
            # it has one, is handed to every turn from the database.
            index[conv_id]["spinoff_brief"] = brief["id"]
            if model:
                # On the entry, not the reply alone: per-turn resolution
                # (observatory's effective_model) reads it from here, so the
                # pin holds from the kickoff turn onward.
                index[conv_id]["model"] = model
            if wt_path:
                index[conv_id]["worktree"] = str(wt_path)
                index[conv_id]["branch"] = wt_branch

    # Somebody else minted this slug while we were adopting the branch. Theirs
    # wins (it's the one in the index); ours is an orphan directory nothing
    # points at, so it goes back — outside the lock, like every git call here.
    if raced:
        if wt_path:
            worktrees.remove(wt_path)
        theirs = store.read("bot_chats/index", {})[raced]
        return {"ok": True, "conversation_id": raced, "newly_spawned": False,
                "lane": _conv_lane(theirs), "brief": theirs.get("spinoff_brief")}, 200

    # Record on the brief which session it started, and keep that session's
    # hidden instructions beside it. Before the launch: the kickoff turn reads
    # the context from here.
    briefstore.opened(brief["id"], conv_id, preloaded, too_big, context)

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
        "model": model,
        "spawned_from": parent,
        "brief": brief["id"],
        "worktree": str(wt_path) if wt_path else None,
        "branch": wt_branch,
    }, 200


def _launch_runner(conv_id, kickoff):
    """Start the session working now, without waiting for her to open it.

    The turn has to be hosted by a process that outlives this call — a daemon
    thread started here would die with the CLI door — so the kickoff goes to a
    detached scripts/spinoff_runner.py, which posts it through the real send
    route and stays alive draining the stream until the turn ends.

    The kickoff travels by FILE, never on the command line: it's the whole
    brief, written by another agent, and an argv-borne prompt is one refactor
    away from being shell-interpolated — the brief-by-file doctrine exists for
    exactly that.

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
        _prune_kickoffs()
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


# --- The offer: a Go button instead of "shall I?" ----------------------------
# The sender stages the spawn on its OWN conversation and ends its turn; the
# chat shows a Go card. Same shape as request_input in routes/observatory.py:
# the agent reaches this through one script (scripts/spinoff_offer.py), never
# by writing the index itself. Her tap is the confirm the skill used to ask for
# in words, so a Go never spawns anything she wasn't shown.
#
# Prompt: "Make it such that the /spinoff skill comes with a UI. instead of it
# asking go, I can click a "go" button that emerges at the bottom of the chat,
# or just keep talking. Then it takes me to that chat and prompts me to close
# the existing chat or not"

_OFFER_MAX_SLUGS = 6   # "spin off 1 and 3", not a batch job


def _brief_title(slug):
    """The one-line title from the brief's `# Spinoff: <title>` heading, or the
    slug when the heading isn't there — the Go card names each session by it."""
    brief = briefstore.latest(slug)
    try:
        first = brief["body"].splitlines()[0]
    except (TypeError, IndexError):
        return slug
    title = re.sub(r"^#\s*(Spinoff:\s*)?", "", first).strip()
    return title or slug


def offer_spinoff(conv_id, slugs, lane=None):
    """Stage a Go button on `conv_id` for these briefs. Returns (payload, status).

    Every slug must already have its brief, checked NOW rather than at Go — the
    card shouldn't offer a session that can't start. A new offer REPLACES the
    old one: when the agent re-offers after she's talked it through, the button
    she sees is the current plan, not the first draft of it. `lane` is kept for
    Go; left None, Go lands the sessions in the sender's room like any spinoff."""
    if not (conv_id and _CONV_ID_RE.match(str(conv_id))):
        return {"error": "invalid conversation id"}, 400
    slugs = list(dict.fromkeys(slugs or []))
    if not slugs:
        return {"error": "no slugs to offer"}, 400
    if len(slugs) > _OFFER_MAX_SLUGS:
        return {"error": f"at most {_OFFER_MAX_SLUGS} spinoffs per offer"}, 400
    for slug in slugs:
        if not SLUG_RE.match(slug):
            return {"error": f"bad slug {slug!r}"}, 400
        if briefstore.latest(slug) is None:
            return {"error": f"no brief for {slug!r} — save it first "
                             "(scripts/spinoff_brief.py)"}, 400
    if lane is not None and lane not in _LANES:
        return {"error": f"unknown room {lane!r}"}, 400
    offer = {"slugs": slugs, "offered": _now()}
    if lane:
        offer["lane"] = lane
    _chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        entry["spinoff_offer"] = offer
    return {"ok": True, "spinoff_offer": offer}, 200


def read_offer(conv_id):
    """The staged offer on `conv_id` with each slug's title, or None."""
    entry = store.read("bot_chats/index", {}).get(conv_id)
    offer = entry.get("spinoff_offer") if isinstance(entry, dict) else None
    if not isinstance(offer, dict) or not offer.get("slugs"):
        return None
    return dict(offer, sessions=[{"slug": slug, "title": _brief_title(slug)}
                                 for slug in offer["slugs"]])


def go_offer(conv_id):
    """Her Go: spawn every offered spinoff. Returns (payload, status).

    The offer is TAKEN under the lock before anything spawns, so a double tap
    (or two open windows) can't start the work twice — the second Go finds
    nothing and says so. The room is the offer's own, else the SENDER'S: a Go
    arrives as a web request, which carries no EXOCORTEX_CONV_ID for
    _inherit_lane to read, so the sender is named here instead.

    One slug failing doesn't stop the rest; each comes back as spawned or with
    its error, and the client opens the first that spawned."""
    _chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        offer = entry.pop("spinoff_offer", None)
        room = _conv_lane(entry)
    if not isinstance(offer, dict) or not offer.get("slugs"):
        return {"error": "nothing offered here (already started?)"}, 409
    lane = offer.get("lane") or room
    spawned, errors = [], []
    # Outside the lock: open_spinoff takes it itself, and launches runners.
    for slug in offer["slugs"]:
        # The offer sits on the sender's own conversation, so the sender is
        # the parent even though Go arrives as a web request.
        payload, status = open_spinoff(slug, lane=lane, parent=conv_id, via="go")
        if status == 200:
            spawned.append({"slug": slug,
                            "conversation_id": payload["conversation_id"],
                            "lane": payload["lane"],
                            "newly_spawned": payload["newly_spawned"],
                            "started": payload.get("started", False)})
        else:
            errors.append({"slug": slug, "error": payload.get("error", "failed")})
    return {"ok": bool(spawned), "spawned": spawned, "errors": errors}, 200


def dismiss_offer(conv_id):
    """Her ×: the button goes, nothing spawns. Idempotent."""
    _chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        entry.pop("spinoff_offer", None)
    return {"ok": True}, 200


# --- The family tree: who was spun off from whom ------------------------------
# Every spinoff carries `spawned_from` (its parent's conversation id) and
# `spawned_via` (how it was born), written at mint by open_spinoff and
# back-filled for older ones by scripts/backfill_spawned_from.py. This reads
# them back as one flat list the frontend folds into a tree
# (frontend/src/features/observatory/SpinoffTreePage.tsx).

def spinoff_tree(index):
    """Every conversation that is part of a spinoff family, flat.

    A conversation is in if it was spun off (has spawned_via) or something was
    spun off from it. Archived ones stay in — the tree is history, and most of
    it is closed. Each node names its parent; roots are nodes whose parent is
    None or isn't in the list.
    """
    parents = {entry.get("spawned_from") for entry in index.values()
               if isinstance(entry, dict) and entry.get("spawned_from")}
    nodes = []
    for cid, entry in index.items():
        if not isinstance(entry, dict):
            continue
        if not (entry.get("spawned_via") or cid in parents):
            continue
        nodes.append({
            "id": cid,
            "title": entry.get("title") or cid,
            "slug": entry.get("spinoff_slug"),
            "lane": _conv_lane(entry),
            "started": entry.get("started"),
            "last": entry.get("last_at"),
            "archived": bool(entry.get("archived")),
            "running": bool(entry.get("running")),
            "parent": entry.get("spawned_from"),
            "via": entry.get("spawned_via"),
        })
    nodes.sort(key=lambda node: node.get("started") or "")
    return nodes


# --- The brief page: what a session was asked, and what it was handed -----------
# The session's own page in the Observatory has a "brief" button; this is what
# it shows (frontend/src/features/observatory/SessionBriefPage.tsx).

def session_brief(conv_id):
    """Everything kept about one session's brief, or None when it has none:
    the brief, the files pasted into its instructions, those instructions
    whole, and the handoffs it wrote or was started from."""
    index = store.read("bot_chats/index", {})
    entry = index.get(conv_id)
    if not isinstance(entry, dict):
        return None
    brief = briefstore.get(entry.get("spinoff_brief")) or briefstore.for_session(conv_id)
    handoffs = briefstore.handoffs(conv_id)
    if brief is None and not handoffs:
        return None
    context = briefstore.context(brief["id"]) if brief else None

    def named(conv):
        other = index.get(conv) if conv else None
        return {"id": conv, "title": (other or {}).get("title") or conv} if conv else None

    return {
        "conv": conv_id,
        "title": entry.get("title") or conv_id,
        "brief": brief and {
            "id": brief["id"], "slug": brief["slug"], "written_at": brief["written_at"],
            "written_by": named(brief["written_by"]), "opened_at": brief["opened_at"],
            "continues": named(brief["continues"]), "body": brief["body"],
            "preloaded": brief["preloaded"], "too_big": brief["too_big"],
        },
        "context": context,
        "handoffs": [{"id": h["id"], "at": h["at"], "body": h["body"],
                      "from": named(h["conv"]), "to": named(h["to_conv"]),
                      "written_here": h["conv"] == conv_id} for h in handoffs],
        "continued_by": named(entry.get("continued_by")),
    }


def register(app):

    # One session's brief, context and handoffs, for its brief page.
    @app.route("/api/spinoff/brief/<conv_id>", methods=["GET"])
    def spinoff_brief_read(conv_id):
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        found = session_brief(conv_id)
        if found is None:
            return jsonify({"error": "this session has no brief"}), 404
        return jsonify(found)

    # The family tree, flat: the page builds the nesting.
    @app.route("/api/spinoff/tree", methods=["GET"])
    def spinoff_tree_read():
        return jsonify({"nodes": spinoff_tree(store.read("bot_chats/index", {}))})

    # The Go card's three doors: read what's offered, start it, or wave it off.
    @app.route("/api/spinoff/offer/<conv_id>", methods=["GET"])
    def spinoff_offer_read(conv_id):
        return jsonify({"offer": read_offer(conv_id)})

    @app.route("/api/spinoff/offer/<conv_id>/go", methods=["POST"])
    def spinoff_offer_go(conv_id):
        payload, status = go_offer(conv_id)
        return jsonify(payload), status

    @app.route("/api/spinoff/offer/<conv_id>/dismiss", methods=["POST"])
    def spinoff_offer_dismiss(conv_id):
        payload, status = dismiss_offer(conv_id)
        return jsonify(payload), status

    @app.route("/api/spinoff/open", methods=["POST"])
    def spinoff_open():
        # `lane` is optional and names the room; omitted, the spinoff inherits
        # the sending session's. Spelled `lane` to match the sibling create
        # route (/api/observatory/conversations), `room` because that's what
        # the two of them are called out loud.
        data = request.json or {}
        lane = data.get("lane") or data.get("room")
        payload, status = open_spinoff(
            data.get("slug", ""), lane=(lane or "").strip() or None,
            model=(data.get("model") or "").strip() or None,
            # `branch` = stand on an EXISTING agent/* branch in its own
            # worktree — the steward door and the future escalation spawner
            # both come through here.
            branch=(data.get("branch") or "").strip() or None)
        return jsonify(payload), status
