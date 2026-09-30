"""Observatory API — slice S1, the "pipe", of the bot-surface design (that
doc lives in the owner's private vault, not this repo — on this install,
`docs/bot-surface-design-2026-07-23.md` under the vault root).

SESSION-FIRST MODEL: each conversation (an entry in bot_chats/index.json) is
its own self-contained unit of config — it carries its own `cwd`,
`allowed_tools`, and (optionally) `system_prompt_file` directly, resolved by
`_conv_config()`. The "bot" layer that used to own this config has been
dissolved; "bots" survive only as (a) the legacy `/api/observatory/<bot_id>/
...` and `/api/bots/...` route aliases kept for cached PWA clients, and (b) a
`bot` display field carried on each entry (old sidecars/terrain read
`meta.get("bot")`). New conversations get their config at creation time, not
from a bot lookup at send time.

Each turn spawns one `claude -p --output-format stream-json` subprocess (no
resident daemon — the process exits when the reply ends; continuity comes
from `--resume`), relays its NDJSON events to the browser as SSE, and appends
every event to a conversation log the owner controls. Claude Code's own
transcript files are undocumented internals that churn between releases —
they are never the record here; `bot_chats/<conv>.jsonl` is.

Guarantees carried over from the terminal send door (routes/terminal.py):
- capture-first journaling: a journaling conversation's turn mints its B card
  BEFORE the model is called, so a failed model call can never lose a
  journal line. The journal gate is conversation-only now: `entry["journal"]
  is True`, full stop — no bot-level factor.
- off-the-record turns (record: false) skip the journal mint — and nothing
  else. They still appear in her own chat log, flagged `off_record: true`, so
  scrolling back through a conversation shows what she actually said instead
  of a row of anonymous holes. "Off the record" means "not in the diary", not
  "erased from the chat"; the only sends that still leave a bare gap marker
  are the app's own operator cues (`operator: true` — the red card's "Resume
  session?"), which she never typed. The surface must never promise more
  privacy than the machinery gives (Terra, 07-23), so the composer's own note
  says the same thing.

Headless mode authenticates exactly like interactive Claude Code (the owner's
subscription login, or an API key on a fresh install) — no separate billing.
"""
from flask import request, jsonify, Response, has_request_context
from datetime import datetime, timedelta
from pathlib import Path
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

import activityfeed
import config as app_config
import lanes
import peermail
import recap_summary
import sqlstore
import store
import toolcallstore
import worktrees
from routes import terminal
from routes.kitchen.shared import _mem_available_mb, MIN_SPAWN_MB
from scripts.extract_footprints import harvest_conversation

# Overridable for tests (a stub emitting canned NDJSON) and for installs where
# claude isn't on gunicorn's PATH.
CLAUDE_BIN = os.environ.get("EXOCORTEX_CLAUDE_BIN", "claude")

_BOT_ID_RE = re.compile(r"^[a-z0-9-]{1,30}$")
_CONV_ID_RE = re.compile(r"^[A-Za-z0-9.\-]{1,60}$")
# A journal card id, same shape routes/cards.py validates — the highlight door
# hangs her annotation off the quote card by id, so it checks the parent is a
# real one before asking stream.py to resolve it.
_CARD_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d{4}[bks]\d*$")

# LEGACY fallback only: the ~20 existing keeper conversations predate
# per-conversation config and have no `allowed_tools` field of their own —
# _conv_config() falls back to this (read-only) trio for them rather than
# backfilling the index. New conversations always get an explicit list.
_DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"]

# What a builder session (the Observatory's default for new sessions, and
# what spinoff conversations get) is allowed to touch — a full dev toolkit,
# unlike the read-only legacy default above.
_BUILDER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit",
                  "Bash", "WebFetch", "WebSearch", "Task"]

# Per-session model choices. A conversation with NO `model` field (all of them,
# before this existed) passes no --model flag at all and so inherits the CLI's
# own default from ~/.claude/settings.json — that inherit-the-default case is
# the point, not an oversight: changing the default there keeps flowing through
# to every session she hasn't deliberately pinned. Aliases only (the CLI
# resolves them to the latest snapshot); '[1m]' asks for the 1M-context variant.
_MODEL_CHOICES = ["fable", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"]


# Bare continuations — "go", "keep going", "yeah do it". They're a quarter of
# all last-sent prompts and they say nothing about what a session is doing, so
# they never become the card's `last_prompt`; the previous real ask stays up
# instead. Anchored and whole-string: "go on to the money page" is a real ask.
_CONTINUATION_RE = re.compile(
    r"^(go|ok(ay)?|y(es|ep|eah)|sure|do +it|go +ahead|keep +going|carry +on|"
    r"continue|next|k|proceed|please|thanks|thank +you|ty|good|nice|perfect|"
    r"cool|great|yay|done)\W*$", re.I)

# Long enough to be worth a line on the card. The regex above catches the known
# noise words; this is the backstop for the ones nobody thought of.
_MIN_PROMPT_CHARS = 12
# The card clamps to three lines and expands on tap, so this is the budget for
# the EXPANDED read -- roughly three lines' worth over again. It was 120, which
# is about one line: the card had nothing to expand INTO, and five of her open
# cards sat at exactly the cap, cut mid-word. Raising it is forward-only, since
# the trim happens here at send time and the discarded tail is already gone.
#
# Not the whole message on purpose. bot_chats/index is re-read in full on every
# roster poll (every few seconds, every session including archived ones), so
# what's stored here is paid for continuously -- a pasted wall of text would tax
# the poll forever to be read once. The full text is still in the session's
# jsonl if anything ever needs it.
_MAX_PROMPT_CHARS = 500

# Machine text wearing her voice. An upload reaches the agent as a bracketed
# filesystem path, which on the card read as her typing
# "[uploaded: /opt/.../20260809_191053_IMG_2926.png]". Each one is swapped for
# a short word for what it was; a send that was ONLY an upload then falls under
# the length floor and leaves the previous real ask up.
_UPLOAD_RE = re.compile(r"\[uploaded: (\S+?)\]")
_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif")


def _upload_word(match):
    """What one `[uploaded: path]` marker says on the card."""
    path = match.group(1).lower()
    if path.endswith(_IMAGE_SUFFIXES):
        return "📷 image"
    if path.endswith("_paste.txt"):
        return "📋 pasted text"
    return "📎 file"


def _card_prompt(text):
    """Her ask, trimmed to one line for the session card — or None when this
    send shouldn't be shown there at all.

    Whitespace is collapsed rather than split on the first newline: a prompt
    that opens with "ok so" and puts the meat on line two would otherwise show
    its throat-clearing and hide its point.

    [prompt: "display the last prompt I gave along with the generated summary"
    / "i want more of my last message to show on the card, at least 2-3 lines,
    and then it will drop off into ellipses... and then allow me to expand it
    if i want. for all times, not just when it's running"]"""
    one_line = " ".join(_UPLOAD_RE.sub(_upload_word, text or "").split())
    if not one_line or one_line.startswith("/"):
        return None            # slash commands are operator control, not an ask
    # Refuse a send that opens with a markdown heading: that's a machine brief
    # (a handoff's "# Continuing ..." kickoff), not her. She doesn't open a
    # message with an H1; every generated brief does. The previous ask stays up.
    if re.match(r"#{1,6} ", one_line):
        return None
    if len(one_line) < _MIN_PROMPT_CHARS or _CONTINUATION_RE.match(one_line):
        return None
    return one_line[:_MAX_PROMPT_CHARS]


def _cli_default_model():
    """What an UNPINNED session actually runs on: the `model` in Claude Code's
    own settings.json, or None if it says nothing (then the CLI picks, and
    honestly neither do we).

    Most sessions carry no `model` field at all — that's the designed case, not
    an oversight (see _MODEL_CHOICES) — so without this a roster showing "which
    model is this on" would answer "unset" for nearly everything, which is true
    of the session and useless to her. Read fresh each roster build rather than
    cached at import: changing the CLI default is exactly the sort of thing that
    should show up on the next poll without a service restart.

    Any trouble reading it degrades to None (the card just shows no model) --
    the roster must never 500 over a decoration."""
    try:
        raw = json.loads((Path.home() / ".claude" / "settings.json").read_text())
    except (OSError, ValueError):
        return None
    model = raw.get("model") if isinstance(raw, dict) else None
    return model if isinstance(model, str) and model.strip() else None


# --- Lanes: where a session stands, and whether it asks ---------------------
# A session BELONGS to a lane; it is not filtered into one. Before this, the
# live "Orchestra" section was a derived view (running or awaiting) over the
# same roster "My sessions" already rendered — so a working session was one
# card drawn twice, in two visual languages, and there was no way to say where
# anything lived. Now membership is assigned once, at creation, and exclusive:
# a card sits in its lane whether or not it happens to be running. Live-ness
# became a STATE the card wears (breathing dot, ticking files, Stop), not a
# section it migrates to. Her call, 07-27.
#
# The lane does NOT gate tools — every lane carries the full builder toolkit
# (her call: "it should be able to do honestly anything"). What it decides is
# WHERE the session stands and whether it STOPS AND ASKS — two independent
# switches, which is why there are three lanes and not two:
#
#   personal  — her, talking, in real time, about her life. Rooted at the
#               parent of both repos, the one place a session sees the app
#               code and the vault as peers. Gates OFF: she IS the check, and
#               making it ask is pure friction ("instead of worry about it
#               orchestrating").
#   coding    — her, building, in real time. Same gates-off as Personal (she's
#               still watching) but rooted in the APP CHECKOUT, so a build
#               session stands where the code is instead of one level up
#               beside the vault. That root is the point of the room: from the
#               shared root a build session can drift into the vault and leave
#               app code there, which the root CLAUDE.md calls a bug outright.
#   orchestra — work happening while she isn't watching. Rooted in the app
#               checkout too, but act_gate + doc-guard ON: irreversible /
#               out-of-lane actions raise an orange card and wait, because
#               nobody is there to catch them.
#
# So: Personal and Coding differ by GROUND, Coding and Orchestra by GATE. The
# split of the old Personal room into Personal + Coding is her 08-03 call —
# "separation of sessions that are personal and those that are coding".
#
# ORCHESTRA HAS NO ROOM ON THE PAGE ANY MORE (her 08-12 ask, "remove the
# orchestra section from my observatory for now"). Nothing here changed: the
# lane still exists, still gates, and is still _DEFAULT_LANE, because it is (a)
# what night-crew workers run in and (b) the fail-toward-ask home for any
# session this file can't place — retiring it here would silently WIDEN the
# autonomy of everything unplaceable, which is the one thing the gate exists to
# prevent. The frontend simply stops drawing and offering it: ROOMS in
# frontend/src/features/observatory/api.ts is the list with a room, ALL_LANES is
# the list that exists. Bringing the room back is a one-line change there.
#
# RESEARCH is the fourth lane (09-24): her research desk, and the ground every
# dispatched research worker stands on now that they've left tmux. Rooted in
# store.RESEARCH_ROOM_DIR — a folder whose CLAUDE.md teaches the room how to
# read her tables and how to write research back (scripts/research_ctl.py) —
# so a session there knows the research pipeline the way a Coding session
# knows the checkout. Gates OFF: she runs these herself, and a worker's every
# write already lands `reviewed: false` for her to check, so the act-gate has
# nothing to add. It is a DOOR on the roster, not a room block (like Helpers):
# routes/research_room.py lists it, frontend sessionFilters.roomRoster hides
# it from the rooms.
#
# LINEAR is the fifth (09-30): sessions that work in Linear, the outside
# issue tracker, with her — through the `linear` MCP server, installed at
# user scope so every session has its tools. Rooted in store.LINEAR_ROOM_DIR,
# whose CLAUDE.md (in the vault) names the team, the plan, and what must
# never be written to an outside service. It HAS to be watched: the act gate
# (tools/act_ask_gate.py) stops on every `mcp__` call, so a gated Linear
# session would ask before every read. Another door like Research's
# (routes/linear_room.py, frontend LinearDoor / sessionFilters.roomRoster).
#
# Per-session overrides (`act_gate` / `guard_docs` written explicitly) still
# win over the lane default — see _conv_config.
_LANES = lanes.LANES
_DEFAULT_LANE = "orchestra"

# The rooms she watches — no act-gate, no doc-guard, because she's sitting
# right there (or, for Research, because every write is already hers to
# review; for Linear, because the gate would stop on every Linear call). Named once so a fifth room can't quietly inherit autonomy by
# being spelled into a condition somewhere; anything not on this list asks.
_WATCHED_LANES = ("personal", "coding", "research", "linear")

# The helper sessions — a swarm's own and the room's (swarms.HELPER_ROLES).
# Whatever room they sit in, they only look things up (tools/helper_gate.py).
_HELPER_ROLES = ("swarm_helper", "room_helper")


def _root_dir():
    """The parent of both repos — the Personal lane's cwd. Derived as the
    common ancestor of the two Terrain roots rather than hardcoded, so an
    install that lays its repos out differently still gets a real directory.
    Falls back to the vault root if they share nothing but '/' (no sane
    session should be rooted at the filesystem root)."""
    skeleton = Path(store.BUILD_DIR).resolve()
    vault = Path(store.CONTENT_DIR).parent.resolve()
    try:
        common = Path(os.path.commonpath([str(skeleton), str(vault)]))
    except ValueError:
        return str(vault)   # different drives — can't happen on one filesystem
    return str(vault) if common == Path(common.root) else str(common)


def _lane_profile(lane):
    """The config a lane hands a session at BIRTH. cwd is the piece that can
    never change afterwards (Claude Code stores conversations per directory —
    `--resume` from elsewhere fails), which is why the lane is chosen up front
    rather than inferred later.

    Two switches, five rooms: Personal stands at the shared root, Research and
    Linear in their own room folders, Coding and Orchestra in the app
    checkout; only Orchestra asks."""
    watched = lane in _WATCHED_LANES
    # Where each lane stands. Anything not named here is the app checkout.
    if lane == "personal":
        cwd = _root_dir()
    elif lane == "research":
        cwd = str(store.RESEARCH_ROOM_DIR)
    elif lane == "linear":
        cwd = str(store.LINEAR_ROOM_DIR)
    else:
        cwd = str(store.BUILD_DIR)
    return {"cwd": cwd,
            "allowed_tools": list(_BUILDER_TOOLS),
            "act_gate": not watched, "guard_docs": not watched}


def _conv_lane(entry):
    """Which room a session lives in — the rule lives in lanes.py so the SQL
    sessions table (codestore.py) derives it the same way."""
    return lanes.derive_lane(entry)


# --- Doc-protection guard --------------------------------------------------
# Keep app-spawned builder/spinoff sessions from editing the hand-curated
# identity docs (the seed scaffold, the project CLAUDE.md, persona lore, vault
# doctrine). Terra's cut (07-26): bind the read-only to the SESSION TYPE, not to
# the files — a session spawned through the Observatory or a /spinoff can't
# scribble these, but the owner's own direct vault terminal never runs through
# here, so she still re-cuts doctrine "at the edge" whenever she chooses. This
# is DRIFT-protection (a confused session reaches for the Edit tool), NOT a
# lock: it denies the file-writing tools, not a `Bash` redirect. Structural
# over prose — the same instinct as tools/stream/keeper_capture.py, one
# session-config knob further on.
#
# Enforced by handing the turn a `permissions.deny` block via `claude
# --settings` (deny wins over --allowedTools; verified against the CLI). The
# globs resolve at runtime from store paths, NOT hardcoded — so this is
# committed code that travels to a fresh install, not a gitignored per-machine
# settings.json. A session opts out with `guard_docs: false`.

# File-writing tools a builder session carries; a deny rule is emitted per tool
# per protected path. A session with none of these — the read-only legacy
# Keeper — gets no guard (it can't write anyway).
_GUARD_WRITE_TOOLS = ("Edit", "Write", "NotebookEdit")

# Protected paths, RELATIVE to each root (the skeleton checkout and the vault),
# in the spirit of _TERRAIN_DENYLIST — a small curated set, easy to extend as
# new hand-curated docs appear. Dirs are protected recursively, files exactly.
# A pattern absent under a given root (e.g. the vault has no content-scaffold/)
# just yields an inert deny rule that never matches — harmless.
_PROTECTED_DOC_DIRS = ("content-scaffold", "claude-commands")
_PROTECTED_DOC_FILES = ("CLAUDE.md", "docs/BEDROCK.md")


def _protected_doc_globs(cwd=None):
    """Absolute path globs the guard denies writes to, resolved from store dirs
    (never hardcoded — the vault is instance-specific). Both the skeleton
    checkout (store.BUILD_DIR) and the vault root (store.CONTENT_DIR's parent —
    the same root _default_bots()/_terrain_repos() use) contribute.

    The session's OWN cwd counts as a third root when it's a worktree
    (worktrees.py). These globs are ABSOLUTE, so the copy's CLAUDE.md and
    claude-commands/ sit at paths neither fixed root matches: the guard would
    read as on and protect nothing, and an unattended session could rewrite the
    doctrine files in its copy and carry them home on its branch. The guard has
    to follow the session to wherever it's standing."""
    roots = [Path(store.BUILD_DIR), Path(store.CONTENT_DIR).parent]
    if cwd and worktrees.worktree_root_for(cwd):
        roots.append(Path(cwd))
    globs = set()
    for root in roots:
        for d in _PROTECTED_DOC_DIRS:
            globs.add(f"{root / d}/**")
        for f in _PROTECTED_DOC_FILES:
            globs.add(str(root / f))
    return sorted(globs)


def _guard_settings_json(cwd=None):
    """The `--settings` payload: a `permissions.deny` rule for every
    (write-tool × protected-glob) pair. Absolute paths carry the leading `//`
    Claude Code uses for filesystem-absolute rules (matches the existing
    agents/mailclaude/clerk settings). `cwd` is the session's ground, so a
    worktree session's own copy of the docs is covered too."""
    deny = [f"{tool}(/{glob})" for glob in _protected_doc_globs(cwd)
            for tool in _GUARD_WRITE_TOOLS]
    return json.dumps({"permissions": {"deny": deny}})


# --- Act-vs-ask autonomy gate (S4) — the ONE piece that grants autonomy -----
# A PreToolUse hook (tools/act_ask_gate.py) that generalizes the doc-guard above
# from "always ask" into a real decision: ACT (defer) for the reversible/in-lane,
# ASK (deny → the agent raises an orange request via scripts/request_input.py)
# for the irreversible/out-of-lane. Keys on REVERSIBILITY + LANE, never the
# agent's confidence; fails toward ASK (Bash is allow-listed). Bound to the
# session type like the doc-guard, default on, opt out with `act_gate: false`.
# Purely additive — the hook only ever DENIES, so it can't widen a session.

def _act_gate_hook_command():
    """The command Claude Code runs as the gate: gunicorn's own python on
    tools/act_ask_gate.py, resolved from store.BUILD_DIR so it travels to a
    fresh install rather than being hardcoded. `--approvals-dir` tells the hook
    where the per-conversation approval sidecars live so it can honour a command
    she's OK'd (see _approvals_path / resolve_approval below)."""
    gate = Path(store.BUILD_DIR) / "tools" / "act_ask_gate.py"
    return f"{sys.executable} {gate} --approvals-dir {_approvals_dir()}"


def _session_settings(config, tools):
    """The combined `--settings` dict for one turn: the doc-guard's
    permissions.deny (guard_docs), the act-vs-ask PreToolUse hook (act_gate)
    and, for a helper, the lookups-only hook (helper_gate).
    One payload, since Claude Code takes a single --settings. Each half binds to
    the session type (a write tool / Bash present) and defaults on with its own
    opt-out. A read-only legacy session triggers neither → {} → no --settings."""
    settings = {}
    if config.get("guard_docs", True) and any(t in _GUARD_WRITE_TOOLS for t in tools):
        settings.update(json.loads(_guard_settings_json(config.get("cwd"))))
    if config.get("act_gate", True) and "Bash" in tools:
        settings["hooks"] = {"PreToolUse": [{
            "matcher": "Bash|Task|mcp__.*",
            "hooks": [{"type": "command", "command": _act_gate_hook_command()}],
        }]}
    # Keep a helper to lookups: every tool call it makes goes through
    # tools/helper_gate.py, which lets through reading, git's reading verbs,
    # the helper's own scripts and a spinoff brief, and denies the rest — so
    # when something needs building it starts a session instead. Its matcher
    # is every tool: `allowed_tools` only pre-approves, it forbids nothing.
    if config.get("helper_gate"):
        gate = Path(store.BUILD_DIR) / "tools" / "helper_gate.py"
        settings.setdefault("hooks", {}).setdefault("PreToolUse", []).append({
            "matcher": "*",
            "hooks": [{"type": "command", "command":
                       f"{sys.executable} {gate} --spinoff-dir {store.SPINOFF_DIR}"}],
        })
    # Turn background Bash into a detached job that wakes this conversation.
    # The harness's own background mode dies when the turn ends, and nothing is
    # left to be told the result; scripts/run_detached.py --hook rewrites the
    # call instead. Only for a turn with a conversation id — that's who it wakes.
    if config.get("conv_id") and "Bash" in tools:
        detach = Path(store.BUILD_DIR) / "scripts" / "run_detached.py"
        settings.setdefault("hooks", {}).setdefault("PreToolUse", []).append({
            "matcher": "Bash",
            "hooks": [{"type": "command", "command": f"{sys.executable} {detach} --hook"}],
        })
    return settings


# --- LEGACY: bot lookups, kept only for the legacy per-bot alias routes ------
# (cached PWA clients still hitting /api/observatory/<bot_id>/... and
# /api/bots/...). New code should use _conv_config(entry) instead.

def _default_bots():
    return [{
        "id": "keeper",
        "name": "Keeper",
        # The vault root: personas live beside the content dir, and running
        # there lets Claude Code pick up the vault's own CLAUDE.md protocol.
        "cwd": str(store.CONTENT_DIR.parent),
        "journal": True,
        "allowed_tools": list(_DEFAULT_ALLOWED_TOOLS),
    }]


def _bots():
    bots = store.read("bots", None)
    if not isinstance(bots, list) or not bots:
        return _default_bots()
    return [b for b in bots if isinstance(b, dict) and _BOT_ID_RE.match(str(b.get("id", "")))]


def _bot(bot_id):
    return next((b for b in _bots() if b["id"] == bot_id), None)


def _conv_config(entry):
    """Resolve one conversation's own config — the session-first replacement
    for a bot lookup. `allowed_tools` lazily migrates: the ~20 existing
    keeper conversations have no field of their own and fall back to the
    read-only legacy trio (no backfill of the index file). `cwd` falls back
    to the vault root — the same default the old keeper bot always carried."""
    tools = entry.get("allowed_tools")
    if not (isinstance(tools, list) and tools):
        tools = _DEFAULT_ALLOWED_TOOLS
    model = entry.get("model")
    # The LANE supplies the defaults for both safety nets; an explicitly
    # written field still wins, so the ✎ dialog's per-session "asks first"
    # override survives a lane change. Absent field = follow the lane, which
    # is what makes reassigning a session's lane actually re-scope it.
    lane = _conv_lane(entry)
    defaults = _lane_profile(lane)
    guard_docs = entry.get("guard_docs")
    act_gate = entry.get("act_gate")
    return {
        "lane": lane,
        "allowed_tools": list(tools),
        "cwd": entry.get("cwd") or str(store.CONTENT_DIR.parent),
        "system_prompt_file": entry.get("system_prompt_file"),
        # None = inherit the CLI default (see _MODEL_CHOICES).
        "model": model if model in _MODEL_CHOICES else None,
        # Doc-protection (the seed scaffold, CLAUDE.md, persona lore): on for
        # Orchestra, off for Personal — re-cutting doctrine by talking to it IS
        # a Personal session's job. See _guard_settings_json().
        "guard_docs": defaults["guard_docs"] if guard_docs is None else guard_docs is True,
        # Act-vs-ask autonomy gate: on for Orchestra (nobody's watching), off
        # for Personal (she is). See _session_settings() / tools/act_ask_gate.py.
        "act_gate": defaults["act_gate"] if act_gate is None else act_gate is True,
        # A helper only looks things up; it never builds. Bound to the role,
        # with no per-session opt-out. See _session_settings() / tools/helper_gate.py.
        "helper_gate": entry.get("role") in _HELPER_ROLES,
    }


def _chats_dir():
    d = store.DATA_DIR / "bot_chats"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _is_journalstart(text):
    """True when a send is the Keeper's wake command (`/journalstart`, with or
    without arguments after it)."""
    first = (text or "").strip().split(None, 1)
    return bool(first) and first[0] == "/journalstart"


def attach_boot_package(conv_id):
    """Build the Keeper's boot package and save it as this conversation's
    snapshot. Returns the file's path (for `system_prompt_file`), or None if it
    couldn't be written.

    Built ONCE, at the wake, and frozen: every later turn that day appends the
    same file to the system prompt, so the Keeper's picture of its morning
    never shifts under it mid-conversation, and an unchanging prefix is what
    prompt caching rewards. Why a system prompt at all: a slash command's
    `!` output is swapped for a "too large, saved to <file>" note well below
    the package's ~214 KB (measured 2026-09-25), so the command itself can't
    carry it. See scripts/boot_context.py for what goes in."""
    try:
        from scripts import boot_context
        text = boot_context.build()
        folder = _chats_dir() / "boot"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{conv_id}.md"
        path.write_text(text, encoding="utf-8")
        return str(path)
    except Exception:
        # A failed build must not cost the wake: /journalstart's own text
        # tells a Keeper with no package in its system prompt to read the
        # boot files by hand.
        return None


def _new_conv_id(index):
    """Legible timestamp id, '-2'-suffixed on same-second collisions (the
    same shape as terminal.py's schedule ids)."""
    base = datetime.now().strftime("%Y-%m-%d.%H%M%S")
    if base not in index:
        return base
    i = 2
    while f"{base}-{i}" in index:
        i += 1
    return f"{base}-{i}"


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _build_cmd(config, resume_sid):
    """The claude invocation for one turn. `config` is a resolved conversation
    config (see _conv_config) — allowed_tools/cwd/system_prompt_file/model. The
    prompt goes in via stdin (never argv — no length limit, nothing
    shell-visible). stream-json in -p mode requires --verbose;
    --include-partial-messages is what makes the stream token-granular
    rather than message-granular.

    Model is resolved PER TURN, not at session birth: every turn is a fresh
    subprocess reattached with --resume, so changing a session's model takes
    effect on its next turn with the history intact."""
    cmd = [CLAUDE_BIN, "-p",
           "--output-format", "stream-json",
           "--verbose",
           "--include-partial-messages"]
    model = config.get("model")
    if model:
        cmd += ["--model", model]
    if resume_sid:
        cmd += ["--resume", resume_sid]
    tools = config.get("allowed_tools")
    tools = list(tools) if isinstance(tools, list) else []
    if tools:
        cmd += ["--allowedTools", ",".join(str(t) for t in tools)]
    # One --settings payload carries both structural safety nets, each bound to
    # the SESSION TYPE (not the files/commands) and defaulting on: the
    # doc-guard's permissions.deny (guard_docs) and the act-vs-ask PreToolUse
    # hook (act_gate). Deny wins over --allowedTools; a read-only legacy session
    # triggers neither and gets no --settings at all. See both guard sections up
    # top.
    settings = _session_settings(config, tools)
    if settings:
        cmd += ["--settings", json.dumps(settings)]
    # Add the session's extra system prompt by PATH, not by contents. Claude
    # reads the file itself, so there's no size limit — the contents used to go
    # in as one argv string, and Linux refuses any single argument over 128 KB,
    # which a Keeper's ~214 KB boot package is. A missing file is skipped: a
    # broken persona ref shouldn't kill the turn; the session just runs bare.
    prompt_file = config.get("system_prompt_file")
    if prompt_file and Path(prompt_file).is_file():
        cmd += ["--append-system-prompt-file", str(prompt_file)]
    # Tell every Observatory session that the other agents exist and how to
    # reach them (peermail.prompt). Only a turn that knows its own
    # conversation id gets it: that id is its return address. The same turns
    # are told when to stop for her (_QUESTIONS_PROMPT) — they're the ones
    # whose conversation a question can be filed against.
    if config.get("conv_id"):
        cmd += ["--append-system-prompt",
                peermail.prompt(config["conv_id"]) + "\n" + _QUESTIONS_PROMPT]
    # Keep the input open for the life of the turn, so messages can be handed
    # in mid-turn (see _TurnInput). `--replay-user-messages` makes the agent
    # echo each message back as it reads it, which is how the turn knows when
    # every handed-in message has been picked up and it's safe to close.
    if config.get("stream_input"):
        cmd += ["--input-format", "stream-json", "--replay-user-messages"]
    return cmd


def _spawn(config, text, resume_sid, cwd_override=None):
    # Claude Code stores conversations PER DIRECTORY — resuming a session id
    # from a different cwd fails with "No conversation found". Every
    # conversation therefore carries the cwd it was born in (imported
    # terminal sessions keep their original one) and is always resumed there.
    cwd = cwd_override or config.get("cwd")
    if not (cwd and os.path.isdir(cwd)):
        cwd = None
    # The turn learns its OWN conversation id from the environment, so a session
    # can call scripts/request_input.py to raise its "I need you" flag without
    # being told which conversation it is. Threaded through `config` (not a new
    # _spawn arg) so the existing test spies on _spawn keep their signatures.
    env = None
    conv_id = config.get("conv_id")
    if conv_id:
        env = {**os.environ, "EXOCORTEX_CONV_ID": str(conv_id)}
    # stderr goes to a spooled temp file, NOT a pipe: nobody reads stderr
    # until the process ends, and an unread pipe blocks claude cold once it
    # writes ~64KB of warnings (verbose mode makes that a real number).
    stderr_f = tempfile.TemporaryFile()
    proc = subprocess.Popen(
        _build_cmd(config, resume_sid),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr_f,
        cwd=cwd, text=True, bufsize=1, env=env,
    )
    # Hand over the prompt. A streaming-input turn gets it as one JSON message
    # and its input stays open (_TurnInput closes it when the turn is done);
    # otherwise it's plain text and the input closes now, which is what tells
    # the agent that's everything.
    if config.get("stream_input"):
        proc.stdin.write(_stream_message(text))
        proc.stdin.flush()
    else:
        proc.stdin.write(text)
        proc.stdin.close()
    return proc, stderr_f


def _stream_message(text):
    """One user message in Claude Code's streaming-input format."""
    return json.dumps({"type": "user",
                       "message": {"role": "user", "content": text}}) + "\n"


# --- where a turn lives, and why it isn't here anymore -----------------------
# A turn used to be run by a daemon thread inside whichever gunicorn worker
# handled the send. That thread is the ONLY thing turning the agent's output
# into a record, and `daemon=True` means it dies the instant its worker process
# exits — no unwind, no `finally`, no error written down. The agent process
# survived (orphaned, still thinking, still costing money) but nothing read its
# stdout, so the transcript simply stopped and the card went GREY, exactly as
# if the reply had finished normally.
#
# Measured on this install across every silent death still on disk: 10 of 11
# landed within a second or two of a `Worker exiting` in the journal — 7 from a
# `systemctl reload` (the documented deploy step) and 3 from gunicorn's own
# `--max-requests` recycling, which fires on a request counter and so goes off
# most often while the Observatory is being actively used. Two triggers, one
# mechanism, and there will eventually be a third: a worker exiting is not an
# event this app can design away.
#
# So the turn no longer lives in the worker. `_spawn_host` starts
# scripts/turn_host.py in its own session (setsid), and THAT process owns the
# agent, writes the transcript, and clears the `running` flag. A reload or a
# recycle now takes out only the viewer. The web worker's job shrinks to:
# stage the job, start the host, and tail the files like any other watcher.
#
# What still kills a turn, honestly: `systemctl restart`, because it empties
# the whole service cgroup and the host is in it. That one is already covered
# by scripts/live_turns.py refusing the deploy, and it's why restart stays
# reserved for unit-file changes.
#
# Prompt that produced it: "just do c if it works to actually solve it in a
# final way" — c being "move the turn out of the worker" over the two cheaper
# patches that each covered only one trigger.

def _live_path(conv_id):
    """The current turn's token-delta sidecar.

    The transcript deliberately holds no `stream_event` frames — token deltas
    are transport, not record — but they're what makes a reply appear letter by
    letter instead of paragraph by paragraph. With the turn hosted in another
    process there's no in-memory queue to hand them over on, so they go in a
    file beside the transcript: written by the host, tailed by every watcher,
    and deleted the moment the turn ends.

    Per-turn and short-lived by design. Nothing reads it as history, its
    absence just means "no turn in flight", and losing it costs a typewriter
    effect rather than a single word of the record.
    """
    return _chats_dir() / f"{conv_id}.live"


def _turn_job_path(conv_id):
    return _chats_dir() / ".turns" / f"{conv_id}.json"


def _current_trace_id():
    """This request's trace id, or None. Guarded on has_request_context because
    the run dispatcher and the spinoff runner reach _spawn_host from a plain
    process with no request at all, where touching the `request` proxy raises
    rather than returning a default."""
    if not has_request_context():
        return None
    return getattr(request, "trace_id", None)


def _spawn_host(config, text, resume_sid, conv_id, log_path):
    """Start this turn in its own process. True if it's away, False to fall back.

    The prompt goes in a job FILE, not argv — same rule `_build_cmd` follows for
    the same two reasons: no length limit, and nothing legible in `ps`. The host
    deletes it as soon as it has read it.

    A False here is not fatal. The caller drops back to running the turn in this
    worker, which is what every turn did before — worse, but only in the way it
    was already worse, and a bad interpreter path or a full disk shouldn't cost
    her the reply.
    """
    host = Path(__file__).resolve().parents[1] / "scripts" / "turn_host.py"
    if not host.exists():
        return False
    try:
        job_path = _turn_job_path(conv_id)
        job_path.parent.mkdir(parents=True, exist_ok=True)
        job_path.write_text(json.dumps({
            "conv_id": conv_id,
            "config": config,
            "text": text,
            "resume_sid": resume_sid,
            "log_path": str(log_path),
            "live_path": str(_live_path(conv_id)),
            # Told, not inherited. In production these arrive the same way
            # either route — systemd's Environment= lines, passed down by
            # Popen — but a host that reads its own environment is a host that
            # writes to a different data dir than the worker that started it
            # the moment anything resolves them differently. Naming them here
            # makes the job self-describing and the path testable.
            "data_dir": str(store.DATA_DIR),
            "content_dir": str(store.CONTENT_DIR),
            # Same reasoning one line up, and it's what lets a test drive the
            # real host against a stub agent instead of the installed one.
            "claude_bin": CLAUDE_BIN,
            # If this send is being traced, the turn host picks the SAME trace
            # id up and records its half under it. A send is the one action in
            # this app that genuinely spans two processes, and a trace that
            # stopped at the spawn would stop exactly where the interesting
            # part starts. See runtime_trace.
            "trace_id": _current_trace_id(),
        }), encoding="utf-8")
    except (OSError, TypeError, ValueError):
        return False
    try:
        # stderr goes to a file rather than a pipe for the same reason _spawn
        # does it: nobody is on the other end, and a filled pipe would wedge
        # the host. One rolling file per conversation, so a host that dies
        # before it can write its own error still leaves the reason on disk.
        err_path = job_path.with_suffix(".log")
        with open(err_path, "ab") as errf:
            subprocess.Popen(
                [sys.executable, str(host), str(job_path)],
                stdin=subprocess.DEVNULL, stdout=errf, stderr=errf,
                # The whole point: its own session, so it is not in this
                # worker's process group and outlives both a graceful reload
                # and a --max-requests recycle.
                start_new_session=True,
            )
    except (OSError, ValueError):
        try:
            job_path.unlink()
        except OSError:
            pass
        return False
    return True


# Live turns, per worker: conv_id -> Popen. Only the explicit stop and close
# endpoints ever kill a turn through this — a client disconnect never touches
# it (the whole point: closing the phone's PWA must not shoot the reply
# mid-write; only a deliberate Stop or Close does).
# Cross-worker stops go through the index's stop_requested flag instead.
_running_procs = {}
_stop_requested = set()

# How stale a `running` flag can be before it's presumed dead (a worker that
# crashed mid-turn never cleared it). The last resort: consulted only when the
# proc isn't in THIS worker's registry and the turn carries no process record
# (see "Which processes a turn is" below) that could say so outright.
_RUNNING_STALE_SEC = 600

# How often a live turn re-stamps `last_at` while it works (see the heartbeat
# in _run_turn). Has to stay well under _RUNNING_STALE_SEC — and under the run
# dispatcher's STALE_SEC, which is the same 600 — or the heartbeat can't
# prevent the thing it exists to prevent.
_HEARTBEAT_SEC = 30

# How long token deltas may sit in the sidecar's buffer before they're flushed
# to disk for watchers to see. Trades syscalls against how live the typing
# looks; a tenth of a second reads as instant.
_LIVE_FLUSH_SEC = 0.1


# --- Which processes a turn is, and killing all of them ----------------------
# A running turn records the processes it is made of in its index entry, as
# `turn_proc`: the machine's boot id, plus pid and kernel start time for the
# turn host (scripts/turn_host.py writes that before it starts the agent) and
# for `claude` itself (_run_turn writes that as the turn begins). It is cleared
# in the same write that clears `running`.
#
# A pid alone can't be trusted — the kernel hands a dead one out again — so
# a process only counts as "the same one" when its start time (field 22 of
# /proc/<pid>/stat, in clock ticks since boot) matches what was written down
# AND the boot id hasn't changed. That's a stricter version of the reuse check
# scripts/run_detached.py makes with the command line.
#
# What the record buys:
#   - A dead host is noticed at once, instead of after ten minutes of stale
#     heartbeat: _effective_running stops calling it running, and
#     mark_dead_turns turns the card red and says so in the transcript.
#   - Close can kill the agent from whichever worker took the request, and
#     wait until it's truly gone before removing the folder it stands in.
#
# Killing is by process TREE, not process group. Claude Code starts every
# Bash command in a session of its own (setsid — visible in `ps -o sid`), so
# a group kill of `claude` misses exactly the test run or dev server it
# started; and `claude` shares the host's group, so it would take the host
# with it. Instead the tree is walked through the kernel's child lists,
# freezing each process with SIGSTOP before reading its children (so nothing
# in it can start one the walk would miss), and then SIGKILLed. A run_detached watcher is left alone with everything under
# it: it was put outside the turn on purpose, to outlive it.
#
# Prompt that produced it: "Stop and Close kill only claude, not what it
# started ... A turn host that crashes still dies silently."

def _boot_id():
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return None


def _proc_stat(pid):
    """(state, parent pid, start time) from /proc/<pid>/stat, or None if the
    process doesn't exist. Parsed from after the LAST ')': the command name
    in parentheses may itself contain spaces and parentheses."""
    try:
        raw = Path(f"/proc/{int(pid)}/stat").read_text()
    except (OSError, TypeError, ValueError):
        return None
    fields = raw[raw.rfind(")") + 2:].split()
    try:
        return fields[0], int(fields[1]), int(fields[19])
    except (IndexError, ValueError):
        return None


def _proc_stamp(pid):
    """What to write down about a live process so it can be recognised later."""
    stat = _proc_stat(pid)
    return {"pid": int(pid), "start": stat[2] if stat else None}


def _same_proc(stamp, boot):
    """Is the process in `stamp` still alive, and still the one recorded?
    A zombie counts as dead: it has exited and is only waiting to be reaped."""
    if not isinstance(stamp, dict) or not stamp.get("pid"):
        return False
    if boot and boot != _boot_id():
        return False
    stat = _proc_stat(stamp["pid"])
    if stat is None or stat[0] == "Z":
        return False
    return stamp.get("start") is None or stat[2] == stamp["start"]


def _record_turn_proc(conv_id, role, pid):
    """Write `role` ("host" or "agent") into the turn's process record — only
    while the index still calls the turn running, so a late write can never
    pin a record onto a turn that has already ended."""
    stamp = _proc_stamp(pid)
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if isinstance(entry, dict) and entry.get("running"):
            record = entry.get("turn_proc")
            if not isinstance(record, dict):
                record = entry["turn_proc"] = {}
            record["boot"] = _boot_id()
            record[role] = stamp


def _host_gone(entry):
    """True when a turn's host is recorded and is verifiably no longer alive.
    A turn with no host on record (the in-worker fallback, an older entry, a
    helper run) is never judged by this — it falls to the heartbeat."""
    record = entry.get("turn_proc")
    if not (isinstance(record, dict) and isinstance(record.get("host"), dict)):
        return False
    return not _same_proc(record["host"], record.get("boot"))


def _is_detached_watcher(pid):
    try:
        cmdline = Path(f"/proc/{int(pid)}/cmdline").read_bytes()
    except (OSError, TypeError, ValueError):
        return False
    return b"run_detached.py" in cmdline and b"--watch" in cmdline


def _children(pid):
    """The processes `pid` started, from the kernel's own list of them
    (/proc/<pid>/task/<thread>/children) — a handful of reads for a turn's
    small tree, where scanning all of /proc is hundreds. That list is only
    promised accurate while the process is stopped, which is why _kill_tree
    freezes each process before asking. A kernel built without it falls back
    to the full scan."""
    try:
        threads = os.listdir(f"/proc/{pid}/task")
    except OSError:
        return []
    found = []
    for thread in threads:
        try:
            with open(f"/proc/{pid}/task/{thread}/children", "rb") as f:
                found.extend(int(c) for c in f.read().split())
        except FileNotFoundError:
            return [int(e.name) for e in os.scandir("/proc") if e.name.isdigit()
                    and (_proc_stat(e.name) or (None, None))[1] == pid]
        except (OSError, ValueError):
            continue
    return found


def _kill_tree(root):
    """Freeze, then kill, `root` and everything under it. Each process is
    stopped BEFORE its children are listed, so nothing can start a child the
    walk would miss; then the whole frozen tree is killed at once. A
    run_detached watcher and everything under it are skipped."""
    import signal
    frozen, stack = [], [root]
    while stack:
        pid = stack.pop()
        if pid in frozen:
            continue
        try:
            os.kill(pid, signal.SIGSTOP)
        except OSError:
            continue            # already gone
        frozen.append(pid)
        stack.extend(c for c in _children(pid) if not _is_detached_watcher(c))
    for pid in frozen:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _kill_turn(proc):
    """Kill a turn's agent and everything it started. The one kill every stop
    path uses — Stop, Close, an interrupting message, the host's stop poll."""
    pid = getattr(proc, "pid", None)
    if isinstance(pid, int) and pid > 0:
        _kill_tree(pid)
    try:
        proc.kill()
    except OSError:
        pass


def _effective_running(conv_id, entry):
    if not entry.get("running"):
        return False
    proc = _running_procs.get(conv_id)
    if proc is not None:
        return proc.poll() is None
    if _host_gone(entry):
        return False
    try:
        last = datetime.fromisoformat(entry.get("last_at", ""))
    except (TypeError, ValueError):
        return True
    return (datetime.now() - last).total_seconds() < _RUNNING_STALE_SEC


def _kill_local_proc(conv_id):
    """Kill a live turn IF this worker owns its process. Returns True when it
    did. Records the conv_id in _stop_requested so the turn thread reads the
    death as an intentional stop, not a crash (see the returncode check in the
    stream finalizer). A turn owned by the OTHER gunicorn worker isn't visible
    here — callers fall back to the index's stop_requested flag for that."""
    proc = _running_procs.get(conv_id)
    if proc is not None and proc.poll() is None:
        _stop_requested.add(conv_id)
        _kill_turn(proc)
        return True
    return False


def _kill_recorded_agent(entry):
    """Kill a turn's agent tree from its process record — from any process,
    not just the one that started it. Returns the agent's stamp if it was
    alive and killed, else None. The caller must already have marked the turn
    stop_requested in the index, so the host reads the death as deliberate."""
    record = entry.get("turn_proc") if isinstance(entry, dict) else None
    if not isinstance(record, dict):
        return None
    agent = record.get("agent")
    if not _same_proc(agent, record.get("boot")):
        return None
    _kill_tree(agent["pid"])
    return agent


# How long Close waits for a killed turn to be gone before removing its
# worktree. A direct kill lands in milliseconds; without a process record the
# host's stop poll (turn_host._STOP_POLL_SEC, 2s) has to notice first.
_CLOSE_WAIT_SEC = 10.0


def _wait_turn_gone(conv_id, agent, boot, timeout=_CLOSE_WAIT_SEC):
    """Wait until a stopped turn has actually ended. True if it did in time.
    With the agent's stamp in hand, waits on the process itself; without one,
    on the index's `running` flag, which the host clears as the turn ends."""
    deadline = time.monotonic() + timeout
    while True:
        if agent is not None:
            if not _same_proc(agent, boot):
                return True
        else:
            entry = store.read("bot_chats/index", {}).get(conv_id)
            if not (isinstance(entry, dict) and _effective_running(conv_id, entry)):
                return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)


def mark_dead_turns(index=None):
    """Put down every turn whose host has died mid-reply. Returns their ids.

    A host that dies unexpectedly (OOM, a stray kill, a crash) never reaches
    the end of _run_turn, so nothing clears `running` or writes an error — the
    card read "running" for ten minutes and then went grey, as if the reply
    had finished. This does the host's last job for it: clears the flag,
    records the error so the card goes red, writes the error into the
    transcript so the chat says where it stopped, and kills an agent the dead
    host left orphaned (still thinking, still costing money, nobody reading).

    Called from the roster read and the once-a-minute dispatcher tick. Reads
    /proc only for turns with a host on record, so it costs nothing when no
    turn is running."""
    if index is None:
        index = store.read("bot_chats/index", {})
    suspects = [cid for cid, e in index.items()
                if isinstance(e, dict) and e.get("running") and _host_gone(e)]
    dead = []
    for conv_id in suspects:
        with store.mutate("bot_chats/index", {}) as live_index:
            entry = live_index.get(conv_id)
            # Re-checked under the lock: the host may have finished cleanly
            # between the read above and here.
            if not (isinstance(entry, dict) and entry.get("running") and _host_gone(entry)):
                continue
            record = entry.pop("turn_proc")
            host_pid = (record.get("host") or {}).get("pid")
            error = (f"the turn's host process (pid {host_pid}) died unexpectedly — "
                     "the reply stopped here, and nothing after this point was recorded")
            entry["running"] = False
            entry["last_at"] = _now()
            entry["last_error"] = error
            entry.pop("stop_requested", None)
        dead.append(conv_id)
        _kill_recorded_agent({"turn_proc": record})
        try:
            with open(_chats_dir() / f"{conv_id}.jsonl", "a", encoding="utf-8") as log:
                log.write(json.dumps({"type": "error", "error": error, "ts": _now()}) + "\n")
        except OSError:
            pass
        try:
            os.unlink(_live_path(conv_id))
        except OSError:
            pass
    return dead


def _stderr_tail(stderr_f):
    try:
        stderr_f.seek(0)
        return stderr_f.read().decode("utf-8", "replace").strip()[-500:]
    except (OSError, ValueError):
        return ""


# --- Handing messages to a running agent -------------------------------------
# A turn used to take one prompt and close its input. Now (when
# config.TURN_STREAM_INPUT is on) the input stays open for the whole turn, and
# a companion thread checks the session's mailbox (peermail.py) about once a
# second. A message waiting there is written straight into the running agent,
# which reads it after whatever step it's on and decides what to do with it.
# Tested against the real CLI: a message handed in during a slow Bash step was
# read the moment the step finished, acted on, and the agent went back to its
# own work in the same turn.
#
# The same thread also does the two other jobs that need doing WHILE a turn
# runs: it stops the turn when a message asks to interrupt it, and it folds the
# turn's new tool calls into exo.db every few seconds (toolcallstore.
# live_ingest), so other agents see this one's work as it happens.
#
# Prompt that produced it: "keep the agents input open. change them to queue
# messages to the server so they can inject whenever it's ready."

# How often the companion checks the mailbox, and how often it folds tool
# calls into SQL. The mailbox check is one indexed query.
_INBOX_POLL_SEC = 1.0
_LIVE_INGEST_SEC = 3.0
# A turn whose final result is in, but which is still waiting on the echo of a
# handed-in message, closes anyway after this long with nothing happening —
# the backstop if an echo is ever missed, so a turn can't hang open forever.
_ECHO_WAIT_SEC = 30.0


class _TurnInput:
    """The running agent's open input, shared by the loop that reads its
    output and the thread that hands messages in. One lock around every write
    and the close, so a message can never be written into an input that's
    being shut."""

    def __init__(self, proc):
        stdin = getattr(proc, "stdin", None)
        self.stdin = stdin
        self.open = stdin is not None and not getattr(stdin, "closed", True)
        self.lock = threading.Lock()
        # What's been handed in that the agent hasn't echoed back yet: each
        # entry is the text written and the mailbox rows it carried. The turn
        # may only close once this is empty — closing earlier would drop a
        # message the agent was about to start on — and whatever is still in
        # it when the turn ends goes back to the mailbox (_run_turn's finally).
        self.unread = []
        self.result_at = None       # monotonic time of the last final result
        self.last_event_at = time.monotonic()
        # How many steps (top-level tool calls) this turn has taken, so a
        # message read mid-turn can say where it landed ("after step 14").
        self.steps = 0

    def hand_in(self, text, rows=()):
        """Write one message into the agent. Caller holds the lock. False if
        the input is already shut."""
        if not self.open:
            return False
        try:
            self.stdin.write(_stream_message(text))
            self.stdin.flush()
        except (OSError, ValueError):
            self.open = False
            return False
        self.unread.append({"text": text, "rows": list(rows)})
        return True

    def saw_echo(self, text):
        """The agent read one handed-in message. Returns the mailbox rows it
        carried (empty for a text this turn didn't hand in)."""
        with self.lock:
            for i, item in enumerate(self.unread):
                if item["text"] == text:
                    return self.unread.pop(i)["rows"]
        return []

    def leftover(self):
        """Every row handed in and never read — the turn is ending."""
        with self.lock:
            rows = [r for item in self.unread for r in item["rows"]]
            self.unread = []
        return rows

    def saw_result(self):
        """The agent finished answering everything it had. Close its input
        unless a handed-in message is still unread — then it will answer that
        too, in the same turn, and emit another result."""
        with self.lock:
            self.result_at = time.monotonic()
            if not self.unread:
                self._close()

    def close(self):
        with self.lock:
            self._close()

    def _close(self):
        if self.open:
            self.open = False
            try:
                self.stdin.close()
            except (OSError, ValueError):
                pass


# A message of hers that started a turn within this long of being sent never
# really waited, so it gets no "started a new turn" note — that covers an
# answer sent from a roster card into an idle session.
_WAITED_SEC = 5


def _arrival(row, after_step=None):
    """Where one of her mailbox messages landed, for the note under it in the
    chat: read mid-turn after a given step, started a new turn after she
    pressed "send now", or started the next turn after waiting for one to
    end. None when it didn't wait at all."""
    if after_step is not None:
        return {"how": "injected", "after_step": after_step}
    if row["mode"] == "interrupt":
        return {"how": "interrupt"}
    try:
        waited = (datetime.now() - datetime.fromisoformat(row["at"])).total_seconds()
    except (TypeError, ValueError):
        return None
    return {"how": "next-turn"} if waited >= _WAITED_SEC else None


def _deliver_lines(conv_id, log_path, rows, conv_journals, after_step=None):
    """Write delivered messages into the recipient's transcript and journal,
    and return the text the agent is handed.

    The owner's messages are written exactly as a normal send writes them —
    a `user` line, journaled if the session journals and she's on the record —
    so they look the same in the chat however they got there, plus an
    `arrived` note saying where it landed (_arrival). An agent's message is a
    `peer` line, which the chat draws as a colored card, and is never
    journaled: the journal is what she and the Keeper said.

    Called when the agent actually has the message: as a mailbox turn starts,
    or mid-turn when its echo shows it was read (`after_step` = the steps the
    turn had taken by then)."""
    text = peermail.compose(rows)
    for r in rows:
        if r["kind"] == "B":
            journaled = False
            slash = r["text"].lstrip().startswith("/")
            if r["record"] and conv_journals and not slash:
                journaled = bool(terminal._capture_journal(r["text"], r["text"]))
            elif conv_journals and not slash:
                terminal._note_off_record(r["text"])
            line = {"type": "user", "text": r["text"], "ts": _now(),
                    "journaled": journaled}
            if not r["record"]:
                line["off_record"] = True
            arrived = _arrival(r, after_step)
            if arrived:
                line["arrived"] = arrived
            peermail.append_line(log_path, line)
        else:
            peermail.append_line(log_path, peermail.peer_line(r, "in"))
    # When what the agent receives isn't simply her words, tell the journal's
    # fallback capture doors it's not a journal line — otherwise they'd find
    # it in Claude Code's transcript and mint it as if she'd typed it.
    if conv_journals and text != (rows[0]["text"] if len(rows) == 1 else None):
        terminal._note_off_record(text)
    return text


def _journals(conv_id):
    entry = store.read("bot_chats/index", {}).get(conv_id)
    return isinstance(entry, dict) and entry.get("journal") is True


def _deliver_midturn(proc, conv_id, log_path, turn_input):
    """Hand the running agent whatever is waiting for it. Returns True if the
    turn was stopped for an interrupt.

    Handing in isn't reading: the agent reads a handed-in message when its
    current step ends. So the rows are claimed as 'handed', and only land in
    the transcript when the echo comes back (_run_turn's read loop)."""
    rows = peermail.waiting(conv_id)
    # Her "send now" on a message already handed in but still unread: that
    # message is sitting in the agent's input behind a long step, so the only
    # way to get it read sooner is the interrupt below.
    rushed = any(r["kind"] == "B" and r["mode"] == "interrupt"
                 for r in peermail.handed(conv_id, kind="B"))
    if not rows and not rushed:
        return False
    policy = peermail.policy_of(conv_id)
    modes = {r["id"]: peermail.effective_mode(r["mode"], policy, r["kind"])
             for r in rows}
    # Stop the turn for an interrupt. The messages stay waiting (and the
    # unread handed-in ones go back to waiting as the turn ends): the moment
    # the turn is down, the end-of-turn drain starts a new one with all of
    # them together. Marked in _stop_requested first, so the death reads as
    # deliberate rather than a crash (the same belt the Stop button uses).
    if rushed or "interrupt" in modes.values():
        _stop_requested.add(conv_id)
        turn_input.close()
        _kill_turn(proc)
        return True
    handable = [r for r in rows if modes[r["id"]] == "inject"]
    if not handable:
        return False            # all 'queue' — they wait for the turn to end
    with turn_input.lock:
        if not turn_input.open:
            return False        # the turn is closing; the end-of-turn drain has them
        won = peermail.claim(handable, "handed")
        if not won:
            return False
        # Her message clears what was waiting on her, exactly as when it
        # starts a turn (_her_message_arrived), and the agent reads what it
        # cleared (_reopen_note). An agent's message alone clears nothing.
        # It looks first and clears only once the hand-in lands, so a failed
        # write leaves the questions up for the end-of-turn drain to clear
        # (with its own note) — and it clears only the set it listed, so a
        # set the agent re-filed in the meantime stays.
        hers = any(r["kind"] == "B" for r in won)
        open_now = (_open_questions(store.read("bot_chats/index", {}).get(conv_id))
                    if hers else [])
        text = peermail.compose(won) + _reopen_note(open_now)
        if not turn_input.hand_in(text, won):
            # The input shut between the check and the write. Put them back so
            # the end-of-turn drain delivers them rather than losing them.
            peermail.unclaim(won)
            return False
        if hers:
            with store.mutate("bot_chats/index", {}) as index:
                entry = index.get(conv_id)
                if isinstance(entry, dict):
                    _her_message_arrived(conv_id, entry, expected=open_now)
    peermail.note_delivered(conv_id, won)
    return False


def _record_read(conv_id, log_path, turn_input, echoed):
    """The agent echoed a handed-in message back, which means it has read it:
    mark its mailbox rows read and write them into the transcript, noting the
    step they landed after. Never lets its own error touch the turn."""
    read = turn_input.saw_echo(echoed)
    if not read:
        return
    try:
        peermail.mark_read(read)
        _deliver_lines(conv_id, log_path, read, _journals(conv_id),
                       after_step=turn_input.steps)
    except Exception as e:
        print(f"recording a read message failed for {conv_id}: {e}", file=sys.stderr)


def _note_model_call(event, open_calls, log, conv_id):
    """Keep the record of each model call as it streams by (docs/swarms.md,
    stage 1).

    Two moments matter. When a call STARTS, its usage says how much the model
    is reading — the session's context size right now — so a top-level call
    stores that on the session (`context_tokens`, `context_model`); the
    self-continuing cap reads it. When a call FINISHES, its final output
    count (thinking included) exists only here in the live stream, so it's
    written into the transcript as a `call-usage` line, which
    toolcallstore.py folds into `model_calls`. Subagent calls are tracked by
    the tool call that started them, so a subagent's numbers never overwrite
    the main conversation's."""
    inner = event.get("event") or {}
    parent = event.get("parent_tool_use_id")
    kind = inner.get("type")
    if kind == "message_start":
        message = inner.get("message") or {}
        open_calls[parent] = message.get("id")
        usage = message.get("usage") or {}
        if parent is None and usage:
            context = sum(int(usage.get(k) or 0) for k in (
                "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
            with store.mutate("bot_chats/index", {}) as index:
                entry = index.get(conv_id)
                if isinstance(entry, dict):
                    entry["context_tokens"] = context
                    if message.get("model"):
                        entry["context_model"] = message["model"]
    elif kind == "message_delta" and open_calls.get(parent):
        usage = inner.get("usage") or {}
        details = usage.get("output_tokens_details") or {}
        log.write(json.dumps({
            "type": "call-usage", "message_id": open_calls[parent],
            "parent_tool_use_id": parent,
            "output_tokens": usage.get("output_tokens"),
            "thinking_tokens": details.get("thinking_tokens"),
            "ts": _now()}) + "\n")
        log.flush()


def _turn_companion(proc, conv_id, log_path, turn_input, done):
    """The thread that runs beside a turn: mailbox, interrupts, live SQL,
    and the echo backstop. Never lets an error of its own touch the turn."""
    last_ingest = 0.0
    while not done.wait(_INBOX_POLL_SEC):
        if proc.poll() is not None:
            return
        try:
            if _deliver_midturn(proc, conv_id, log_path, turn_input):
                return
        except Exception as e:
            print(f"mailbox check failed for {conv_id}: {e}", file=sys.stderr)
        if time.monotonic() - last_ingest > _LIVE_INGEST_SEC:
            last_ingest = time.monotonic()
            try:
                toolcallstore.live_ingest(log_path, conv_id)
            except Exception as e:
                print(f"live tool-call ingest failed for {conv_id}: {e}",
                      file=sys.stderr)
        if (turn_input.open and turn_input.result_at is not None
                and time.monotonic() - turn_input.last_event_at > _ECHO_WAIT_SEC):
            turn_input.close()


def _run_turn(proc, stderr_f, conv_id, log_path, resume_sid, live_q=None,
              live_path=None):
    """Own one turn end-to-end, detached from any HTTP connection: keep the
    jsonl log, and persist the resume id the moment it exists — so a turn
    interrupted by anything (closed PWA, dropped proxy, worker recycle) is
    still resumable and its finished text is still in the record.

    Runs in ONE of two places, and the difference is the two optional
    arguments. Normally it runs inside scripts/turn_host.py — its own process,
    outlives the web service — and hands token deltas over in `live_path`, a
    file any watcher in any process can tail. The fallback, when the host can't
    be started, is the old in-worker thread, which relays through the in-memory
    `live_q` instead. Everything else about the turn is identical either way,
    which is the point of it being one function: there is no second
    implementation to drift.

    Every reply is logged, including the reply to an off-the-record turn.
    Journaling is decided at the send door, not here; dropping the reply too
    meant an off-record aside (or an approve-and-resume) tore a hole in the
    chat that swallowed the answer as well as the question."""
    session_id = resume_sid
    sid_saved = False
    cost = None
    # `last_at` means "this session was doing something at this moment", and
    # three separate readers use it to decide a turn has died: the run
    # dispatcher's liveness probe, _effective_running's cross-worker fallback,
    # and the roster card. It used to be written only at the send door and in
    # the `finally` below — never while the turn ran — so a turn that thought
    # for longer than ten minutes read as frozen to all three at once: the
    # dispatcher failed it mid-flight, the one-turn-per-conversation guard fell
    # open, and the card went quiet. The heartbeat keeps it honest DURING the
    # turn.
    #
    # It runs on its own wall clock rather than off the event loop below, and
    # that distinction is the whole point. The loop only sees events, and the
    # non-stream_event ones are exactly what gets written to the jsonl — the
    # same signal the dispatcher's other witness already reads. Beating on them
    # left both witnesses blind in the same places: a long Bash step, a Task
    # subagent, an extended think all emit nothing but token deltas, or nothing
    # at all, for minutes at a stretch. Those are the turns most expensive to
    # lose, and they were the ones the liveness machinery couldn't see.
    #
    # It only ever stamps a turn the index still calls running, so it cannot
    # resurrect one that Stop or the `finally` has already put down — and it
    # stops itself the moment it finds one, so a missed `beat_stop` can't leave
    # a thread writing forever. _HEARTBEAT_SEC is deliberately slow: this writes
    # through store.mutate on the shared index the roster already polls.
    beat_stop = threading.Event()

    def _heartbeat() -> None:
        while not beat_stop.wait(_HEARTBEAT_SEC):
            try:
                with store.mutate("bot_chats/index", {}) as index:
                    beat_entry = index.get(conv_id)
                    if not (isinstance(beat_entry, dict) and beat_entry.get("running")):
                        return          # the turn is down — stop beating
                    beat_entry["last_at"] = _now()
            except Exception:
                continue                # a contended write is not a dead turn

    threading.Thread(target=_heartbeat, daemon=True).start()
    # Write down which process the agent is, so any process can recognise it
    # later — to kill it on Close, or to find it orphaned if the host dies
    # (see "Which processes a turn is" above).
    if isinstance(getattr(proc, "pid", None), int):
        try:
            _record_turn_proc(conv_id, "agent", proc.pid)
        except Exception:
            pass    # bookkeeping must never cost the turn
    # Stamp when this turn began, so the mailbox can say which step its
    # waiting messages are stuck behind without mistaking a step an earlier,
    # killed turn left open for this one's (_inbox_status).
    try:
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if isinstance(entry, dict) and entry.get("running"):
                entry["turn_started"] = _now()
    except Exception:
        pass
    # What killed this turn, if anything — hoisted out of the log-writing block
    # so the index update in `finally` can persist it. That's what puts a red
    # card on the roster: an error used to exist only as an event in the live
    # stream and a line in the jsonl, so a turn that died with nobody watching
    # left a card that looked merely idle.
    turn_error = None
    # The token-delta sidecar, opened fresh for this turn (see _live_path).
    # Truncating rather than appending is deliberate: whatever a previous turn
    # left behind is not this turn's typing.
    live_f = None
    last_flush = 0.0      # so the first delta flushes on sight — see below
    # The agent's open input and the thread that hands it messages (see the
    # "Handing messages to a running agent" block above).
    turn_input = _TurnInput(proc)
    # The model call in flight, per subagent (None = the main conversation) —
    # see _note_model_call.
    open_calls = {}
    companion_done = threading.Event()
    threading.Thread(target=_turn_companion,
                     args=(proc, conv_id, log_path, turn_input, companion_done),
                     daemon=True).start()
    if live_path:
        try:
            live_f = open(live_path, "w", encoding="utf-8")
        except OSError:
            live_f = None   # no typewriter; the transcript is untouched
    try:
        with open(log_path, "a", encoding="utf-8") as log:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue  # non-JSON noise on stdout — skip, don't die
                if not isinstance(event, dict):
                    continue
                turn_input.last_event_at = time.monotonic()
                # The agent echoing a message it has just read. The echo
                # itself isn't logged; what it means is: the handed-in
                # messages it carried are read now, so they go into the
                # transcript here, in the words she or the sending agent used,
                # at the spot in the turn where the agent actually took them.
                if event.get("type") == "user" and event.get("isReplay"):
                    content = (event.get("message") or {}).get("content")
                    if isinstance(content, str):
                        _record_read(conv_id, log_path, turn_input, content)
                    continue
                # Count the turn's steps: each top-level tool call the agent
                # makes (a subagent's calls belong to the step that started it).
                if event.get("type") == "assistant" and not event.get("parent_tool_use_id"):
                    content = (event.get("message") or {}).get("content")
                    if isinstance(content, list):
                        turn_input.steps += sum(
                            1 for block in content
                            if isinstance(block, dict) and block.get("type") == "tool_use")
                if event.get("type") == "result":
                    turn_input.saw_result()
                if isinstance(event, dict):
                    if event.get("session_id") and event["session_id"] != session_id:
                        # `--resume` forks a NEW session id each turn. Save it
                        # on FIRST sight, not at the clean end — an interrupted
                        # turn must still resume into what claude remembers.
                        session_id = event["session_id"]
                        sid_saved = False
                    if not sid_saved and session_id:
                        with store.mutate("bot_chats/index", {}) as index:
                            entry = index.get(conv_id)
                            if isinstance(entry, dict):
                                entry["claude_session_id"] = session_id
                        sid_saved = True
                    if event.get("total_cost_usd") is not None:
                        cost = event["total_cost_usd"]
                # Token deltas (stream_event) are transport, not record — the
                # assistant message events they build carry the same text.
                if event.get("type") == "stream_event":
                    try:
                        _note_model_call(event, open_calls, log, conv_id)
                    except Exception:
                        pass    # accounting must never cost the turn
                if event.get("type") != "stream_event":
                    log.write(json.dumps(event) + "\n")
                    log.flush()   # the log is what a re-attaching client reads
                elif live_f is not None:
                    # Deltas go to the sidecar, flushed on a short timer rather
                    # than per token: flushing every token is tens of thousands
                    # of syscalls across a long turn, and a tenth of a second is
                    # still far below the point where an eye stops reading it as
                    # typing.
                    live_f.write(json.dumps(event) + "\n")
                    # The FIRST delta goes out immediately (last_flush starts
                    # at zero): that one is "it has started talking", and
                    # holding it back for the timer is a tenth of a second of
                    # dead air at the exact moment she's watching for a sign of
                    # life. After that the timer takes over.
                    if time.monotonic() - last_flush > _LIVE_FLUSH_SEC:
                        live_f.flush()
                        last_flush = time.monotonic()
                if live_q is not None:
                    live_q.put(event)
                # A stop from the OTHER gunicorn worker lands as an index
                # flag; check it per message-granular event, never per token
                # delta (that would re-read the index thousands of times).
                if event.get("type") != "stream_event" and conv_id not in _stop_requested:
                    idx_entry = store.read("bot_chats/index", {}).get(conv_id)
                    if isinstance(idx_entry, dict) and idx_entry.get("stop_requested"):
                        _stop_requested.add(conv_id)
                        _kill_turn(proc)
            proc.wait()
            # Deliberate, not a crash, if this process asked for the kill —
            # or if another one did: Close kills the agent directly from
            # whichever worker took the request (_kill_recorded_agent), so
            # the only sign of intent this process gets is the index flag.
            stopped = conv_id in _stop_requested
            if not stopped and proc.returncode != 0:
                idx_entry = store.read("bot_chats/index", {}).get(conv_id)
                stopped = isinstance(idx_entry, dict) and bool(idx_entry.get("stop_requested"))
            if proc.returncode != 0 and not stopped:
                err = _stderr_tail(stderr_f)
                turn_error = err or f"claude exited {proc.returncode}"
                ev = {"type": "error", "error": turn_error}
                log.write(json.dumps(ev) + "\n")
                if live_q is not None:
                    live_q.put(ev)
    finally:
        beat_stop.set()   # before the index write below, so the two can't race
        companion_done.set()
        turn_input.close()
        # Put back whatever was handed in and never read (a stop, an
        # interrupt, the echo backstop): the agent never saw it, so it goes
        # back to waiting and the end-of-turn drain delivers it. Done before
        # `running` clears below, so no drain can start a turn without it.
        try:
            peermail.unclaim(turn_input.leftover())
        except Exception as e:
            print(f"putting unread messages back failed for {conv_id}: {e}",
                  file=sys.stderr)
        # One last fold into SQL, so the turn's final tool calls don't wait
        # for the hourly pass.
        try:
            toolcallstore.live_ingest(log_path, conv_id)
        except Exception:
            pass
        _running_procs.pop(conv_id, None)
        _stop_requested.discard(conv_id)
        try:
            stderr_f.close()
        except OSError:
            pass
        # The sidecar dies with the turn: it is this turn's typing and nothing
        # else. A watcher that loses it mid-read just falls back to the
        # transcript, which has every committed word.
        if live_f is not None:
            try:
                live_f.close()
            except OSError:
                pass
        if live_path:
            try:
                os.unlink(live_path)
            except OSError:
                pass
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if isinstance(entry, dict):
                entry["claude_session_id"] = session_id
                entry["last_at"] = _now()
                entry["running"] = False
                entry.pop("stop_requested", None)
                entry.pop("turn_proc", None)
                _end_turn_done(conv_id, entry)
                # How the turn ended, so the roster can show it. A clean turn
                # clears any error the PREVIOUS one left — the flag means "the
                # last thing this session did was fail", not "it failed once".
                if turn_error:
                    entry["last_error"] = turn_error
                else:
                    entry.pop("last_error", None)
                if cost is not None:
                    entry["cost_usd"] = round(
                        float(entry.get("cost_usd") or 0.0) + float(cost), 6)
        if live_q is not None:
            live_q.put({"type": "done", "conversation_id": conv_id})
            live_q.put(None)   # viewer sentinel — the stream is over


# --- Terrain repo roots ------------------------------------------------------
# The heatmap itself (constants, cache, payload builder, the two endpoints)
# lives in routes/terrain.py since 08-03. What stays here is the one piece the
# session engine also needs: which repos exist and where they stand —
# fork-the-work maps a session's write surface into them below. terrain.py
# reads this dynamically (routes.observatory attribute access), so a test
# monkeypatching it here re-roots the map too.

def _terrain_repos():
    """(id, name, root) for the two repos Terrain covers. Roots follow the
    same conventions as elsewhere in this module: the skeleton's own dir
    (store.BUILD_DIR — the app code) and the vault root (store.CONTENT_DIR's
    parent, same as _default_bots()'s keeper cwd)."""
    return (
        {"id": "skeleton", "name": "App code", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "name": "Personal vault", "root": Path(store.CONTENT_DIR).parent},
    )


def _sse(obj):
    return f"data: {json.dumps(obj)}\n\n"


# --- watching a turn, from anywhere ------------------------------------------
# NOBODY owns a turn from inside the web app any more — it runs in its own
# process (see _spawn_host) — so every watcher is in the same position: the tab
# that sent it, the other gunicorn worker, a phone reconnecting an hour later.
# They all read the same two files.
#
# This reads them the way `tail -f` does: remember a byte offset, read what's
# new, hand over the whole lines, keep the partial one for next time. The
# transcript is already flushed per event by _run_turn ("the log is what a
# re-attaching client reads"), so it is a live feed that happens to be durable
# — and it does not care one bit which process, service or machine is doing
# the writing. _stream_events below is the reader; both doors use it.
_FOLLOW_POLL_SEC = 0.4        # how often to look for new lines
_FOLLOW_RUNNING_EVERY = 5     # ...and how many of those before re-asking the
                              # index whether the turn is still alive (that is
                              # a database read; the file check is a seek)
_FOLLOW_KEEPALIVE_SEC = 15    # silence the client can sit through before a
                              # comment goes down the pipe to hold it open
_FOLLOW_MAX_SEC = 30 * 60     # close and let the client reconnect with ?from=,
                              # so one stream can't be held open forever


def _read_whole_lines(path, offset):
    """Complete lines after `offset`, and the offset just past the last one.

    A final line with no newline yet is a write in progress — it is left alone
    and picked up on the next read. Without that, a client can be handed half
    an event and a torn line can never be repaired.
    """
    try:
        with path.open("rb") as fh:
            fh.seek(offset)
            chunk = fh.read()
    except OSError:
        return [], offset
    end = chunk.rfind(b"\n")
    if end == -1:
        return [], offset
    whole = chunk[: end + 1]
    return whole.decode("utf-8", "replace").splitlines(), offset + len(whole)


def _stream_events(conv_id, skip_events=0, start_offset=0, first_frame=None,
                   live_from_start=False):
    """One live view of a turn, for every watcher there is.

    Both doors onto a running turn come through here now — the send that
    started it and a `/follow` from somewhere else — because with the turn
    hosted in its own process, the sender has no privileged view of it either.
    It's a watcher like any other, and one implementation means the phone that
    reconnects can't render a turn differently from the tab that sent it.

    Two files, tailed together. The transcript is the spine (every committed
    event, durable, flushed per write) and the `.live` sidecar carries token
    deltas. Interleaving between the two is best-effort on purpose: deltas only
    ever paint a preview that the next authoritative `assistant` message
    overwrites, so a delta arriving a beat late costs nothing, and paying for
    strict ordering between two files would buy nothing back.

    Where to start is asked two ways, because the two callers know two
    different things. `skip_events` is a COUNT, for a client reconnecting with
    the `?from=` the last stream reported. `start_offset` is a BYTE position,
    for the send route, which just appended her message and knows exactly where
    the file ended. Pass one or the other, never both.
    """
    path = _chats_dir() / f"{conv_id}.jsonl"
    live = _live_path(conv_id)

    def generate():
        if first_frame is not None:
            yield _sse(first_frame)
        offset, sent = start_offset, 0
        # WHERE TO PICK THE TYPING UP depends on whether this watcher was here
        # when the turn began.
        #
        # The send that started it was: it wants the sidecar from byte zero, or
        # it misses the opening words — and because the host truncates the file
        # as it starts, "the end" at this moment is a moving target it would
        # lose a race against.
        #
        # Anyone joining later was not. They already hold every committed word
        # from history, so replaying a half-typed sentence would make the reply
        # jump backwards and type itself out a second time. They start at the
        # end and take only what comes next.
        live_offset = 0
        if not live_from_start:
            try:
                live_offset = live.stat().st_size
            except OSError:
                live_offset = 0
        started = last_spoke = time.monotonic()
        ticks = 0
        running = True
        while True:
            # DELTAS BEFORE THE TRANSCRIPT, every cycle, and the order is
            # load-bearing. A delta appends to the client's in-flight buffer;
            # the `assistant` message that follows replaces it authoritatively.
            # Read the other way round, a cycle that picks up both at once
            # hands over the finished message FIRST and then the deltas that
            # built it — which re-fills a buffer the message had just settled,
            # and paints the tail of the reply twice on screen.
            # The sidecar is truncated at the start of every turn. A watcher
            # still holding an offset from the last one would be seeking past
            # the end of the new file and would sit there reading nothing for
            # the rest of the turn, so a file that has SHRUNK means "new turn"
            # and the offset goes back to the top.
            try:
                if live.stat().st_size < live_offset:
                    live_offset = 0
            except OSError:
                live_offset = 0   # deleted: the turn ended, or hasn't begun
            deltas, live_offset = _read_whole_lines(live, live_offset)
            for raw in deltas:
                try:
                    yield _sse(json.loads(raw))
                except ValueError:
                    continue
                last_spoke = time.monotonic()
            lines, offset = _read_whole_lines(path, offset)
            for raw in lines:
                sent += 1
                if sent <= skip_events:
                    continue      # catching up to where the client already is
                try:
                    yield _sse(json.loads(raw))
                except ValueError:
                    continue      # a torn historical line, same as elsewhere
                last_spoke = time.monotonic()
            # `running` is only ever set False after a read, so the events
            # written between the last read and the flag clearing are always
            # sent before this loop leaves.
            if not running or time.monotonic() - started > _FOLLOW_MAX_SEC:
                break
            # Checked on the very first pass, not after the first interval:
            # watching a turn that has already finished is the common case (a
            # reconnect that missed the end) and it must return at once rather
            # than sit here waiting to ask.
            if ticks % _FOLLOW_RUNNING_EVERY == 0:
                entry = store.read("bot_chats/index", {}).get(conv_id)
                running = bool(isinstance(entry, dict)
                               and _effective_running(conv_id, entry))
                if not running:
                    continue      # one last read, then out
            ticks += 1
            if time.monotonic() - last_spoke > _FOLLOW_KEEPALIVE_SEC:
                # nginx gives up on a silent proxied stream at 60s, and a long
                # tool stretch says nothing for longer than that.
                yield ": keepalive\n\n"
                last_spoke = time.monotonic()
            time.sleep(_FOLLOW_POLL_SEC)
        # `done` closes the turn for the send client (which used to get it off
        # the in-process queue); `follow_end` tells a reconnecting one that the
        # reply ENDED rather than that its connection died — the two are
        # indistinguishable to an SSE reader otherwise. Both go to everyone:
        # the reducer treats a second closer as a no-op, and one shape for all
        # watchers is worth more than saving a frame.
        yield _sse({"type": "done", "conversation_id": conv_id})
        yield _sse({"type": "follow_end", "count": sent})

    return generate


# --- Keeper rollover control: let the UI fire (and poll) the same close/open
# job scripts/keeper_rollover.py runs at 3 AM via cron. That script OWNS the
# cross-process lock (an fcntl.flock on bot_chats/rollover.lock) that keeps
# the cron run and a UI-triggered manual run from ever overlapping — this
# module only PEEKS at the same lock file. Shared convention, not a shared
# import: same path (store.DATA_DIR/"bot_chats"/"rollover.lock"), same
# non-blocking-probe-and-release shape, deliberately re-implemented here
# rather than imported from scripts/keeper_rollover.py — a route module
# reaching across sys.path into scripts/ for two lines of logic isn't worth
# it. Keep this probe in sync with that script's own rollover_running() if
# the lock's shape ever changes. ------------------------------------------

def _rollover_lock_path():
    return store.DATA_DIR / "bot_chats" / "rollover.lock"


def rollover_running():
    """Non-destructive probe, mirroring scripts/keeper_rollover.py's own
    rollover_running(): open the lock file, try a non-blocking exclusive
    lock, and release it again immediately on success (a probe must never
    itself hold the lock) -> False; BlockingIOError means another process
    holds it -> True. No lock file yet means no real rollover has ever run
    on this box -> False."""
    path = _rollover_lock_path()
    if not path.exists():
        return False
    try:
        fh = open(path, "a+")
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        return False
    finally:
        fh.close()


# --- Request-for-input: a running session's structural "I need you" ---------
# A session that hits a real fork it can't resolve raises this DETERMINISTICALLY
# (via scripts/request_input.py, which reads its own conv id from
# EXOCORTEX_CONV_ID) rather than the app inferring "it's asking a question" from
# the last message — structural over prose, the same instinct as the doc-guard
# and keeper_capture. The flag rides the roster's meta spread (bots_list)
# straight onto the Orchestra card, which glows orange and shows the question;
# the owner's next send clears it (_send_to_conversation, above). Pure
# augmentation — nothing wakes the session; her answer IS the next --resume
# turn. She is the transport (no timer/liveness machinery — that's the trap).
#
# SEVERAL QUESTIONS AT ONCE. A session files every open question in one call,
# and the set REPLACES whatever it filed before — the list is "what's open
# now", not a log. They're kept as a list (`awaiting_questions`, what the
# roster card and the in-chat card number) and joined into `awaiting_input`,
# which everything older reads as a yes/no plus one line of text.
#
# THE CHAT KEEPS EVERY SET. Each filing also writes a `questions` line into the
# transcript, so the chat draws the block where it was asked and it stays there,
# above her answer, after the index flag comes off — marked answered once she
# replies, or replaced when a newer set was filed after it. Prompt: "when an
# agent sends up a question block, for it to persist in the chat above what i
# send."
#
# Prompt: "i don't have to approve anything if there are no questions. if
# there are questions, i want them all summarized into a card at the bottom of
# the session ... and on the front page, i want the orange sessions to have
# these questions printed out with an input box beneath it".

# What every Observatory turn is told about stopping (see _build_cmd). The rule
# is that there is no approval without a question: a session doesn't end its
# turn on "say go and I'll…"; it either keeps working or files real questions.
_QUESTIONS_PROMPT = (
    "## When to stop for the owner\n"
    "Don't stop to ask for approval. If nothing is genuinely undecided, keep"
    " going: don't end a turn with \"say go and I'll…\", \"shall I?\" or"
    " \"want me to…?\" — do the thing. Stop only for a real question that she"
    " alone can answer and that changes what you'd build. Then file ALL your"
    " open questions in one call, one argument each, and end your turn:\n"
    "`./venv/bin/python3 scripts/request_input.py \"question 1\" \"question 2\"`"
    " (from the app checkout). That turns your card orange and prints the"
    " questions on the roster and at the bottom of your chat, with a box she"
    " answers in; her answer arrives as your next message. Each question must"
    " stand on its own — she reads them on a card, away from the chat — so"
    " name the choice and your recommendation in it. Filing again replaces the"
    " earlier set.\n"
)

_REQUEST_INPUT_MAX = 1000   # a question, not an essay
_REQUEST_INPUT_MAX_COUNT = 12   # a handful she can answer in one reply, not a survey


def request_input(conv_id, questions):
    """Set the open questions on a conversation — the one validated entry point
    the agent CLI (and any future HTTP door) share, so agents never write
    session state directly. `questions` is one string or a list of them.
    Returns (payload, status): 200 on success, 400 on a bad id / no question,
    404 on an unknown conversation. Loud, precise failures — same narrow-door
    doctrine as open_spinoff()."""
    if not (conv_id and _CONV_ID_RE.match(str(conv_id))):
        return {"error": "invalid conversation id"}, 400
    # Tidy the questions: trim each, cap each, drop blanks, cap the count.
    if isinstance(questions, str) or questions is None:
        questions = [questions]
    cleaned = [str(q or "").strip()[:_REQUEST_INPUT_MAX] for q in questions]
    cleaned = [q for q in cleaned if q][:_REQUEST_INPUT_MAX_COUNT]
    if not cleaned:
        return {"error": "empty question"}, 400
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        entry["awaiting_questions"] = cleaned
        entry["awaiting_input"] = "\n".join(cleaned)
    # Keep the set in the transcript too, where it was asked. The index field
    # above is "what's open now" and comes off when she replies; this line is
    # the record, so the chat can draw the block in its place above her answer
    # for good (events.ts, case 'questions'). One O_APPEND write, the same as a
    # peer card, because the turn that filed it is writing this log right now.
    peermail.append_line(_chats_dir() / f"{conv_id}.jsonl",
                         {"type": "questions", "questions": cleaned, "ts": _now()})
    return {"ok": True, "awaiting_input": entry["awaiting_input"],
            "awaiting_questions": cleaned}, 200


def _reopen_note(questions):
    """The questions her send just took off the card, handed back to the
    agent. Her next message clears them whether or not it answers them —
    she may be asking about something else entirely — so the agent is told
    what was open and re-files whatever is still unanswered. Empty when
    nothing was open."""
    questions = [q for q in questions if q and q.strip()]
    if not questions:
        return ""
    listed = "\n".join(f"{n}. {q}" for n, q in enumerate(questions, 1))
    return ("\n\n[System: this message cleared the open questions you had filed"
            " for the owner:\n" + listed + "\nIf it doesn't answer one of them,"
            " re-file every one still open with scripts/request_input.py before"
            " you end your turn, or it is gone from her card.]")


def _open_questions(entry):
    """The questions a session entry has open, as a list — empty when none.
    Falls back to the single `awaiting_input` line for an older flag."""
    if not isinstance(entry, dict):
        return []
    listed = [q for q in (entry.get("awaiting_questions") or []) if q and q.strip()]
    if listed:
        return listed
    return [entry["awaiting_input"]] if entry.get("awaiting_input") else []


def _her_message_arrived(conv_id, entry, expected=None):
    """Take down everything that was waiting on her, because a message of hers
    just reached the session. Returns the questions it cleared, for
    _reopen_note. Caller holds the index mutate and passes the entry.
    `expected` = clear the questions only if they're still this set (the
    caller already told the agent about exactly these); a set filed since
    stays up.

    The same moment has two doors, and both come here: a message that starts
    a turn (begin_turn) and one handed into a turn already running
    (_deliver_midturn) — her answer from the roster's orange card takes the
    second whenever the session is still working.
      - The open questions and the orange flag come off, so the card stops
        glowing the moment she replies (request_input). Clearing isn't
        forgetting: the caller hands them back to the agent (_reopen_note),
        since her message may be about something else.
      - Any unresolved gated-command card is dropped (_dismiss_pending).
      - A done countdown stops: she's still talking to it, so it isn't done;
        it marks itself done again when it really is (the Done section).
      - A session she saved for later is picked back up: talking to it is
        coming back to it (the Save for later section).

    Prompt: "Answered the question but the popup stuck. Please make it such
    that if I answer from the front page it marks it answered and continues."
    """
    cleared = _open_questions(entry)
    if expected is None or cleared == expected:
        entry.pop("awaiting_questions", None)
        entry.pop("awaiting_input", None)
    else:
        cleared = []
    _dismiss_pending(conv_id)
    _clear_done(entry)
    entry.pop("saved_at", None)
    return cleared


# --- Done: a finished session closes itself, unless she keeps it -------------
# A session whose job is finished says so through scripts/session_done.py. That
# stamps `done_at` and `closes_at` on its entry; the card shows "done — closes
# at …" with a Keep open button, and the minute tick
# (scripts/coming_up_dispatcher.py) closes it once `closes_at` has passed,
# DONE_GRACE_MINUTES after the stamp. Only HER turn clears the stamp — her
# reply is "not done after all" without a separate gesture. A turn someone else
# starts (a peer's message, a finished job waking it, a sudo answer) leaves it
# standing: a done session answering "nothing more to do" is still done, and
# wiping the stamp there is what left finished sessions with no Done notice.
# If that turn leaves the session unable to close (it asked her, launched a
# job), the stamp comes off when the turn ends (_end_turn_done).
#
# `final_at` is when its final output finished: the end of the turn that
# stamped it done. The roster's unread dot on a done session keys on that, not
# on last_at, so later housekeeping turns don't light the dot again. Closing is the same close her
# × does (close_conversation), and sending into a closed session reopens it.
#
# Prompt: "also need to make sure that sessions that are completely done get
# auto closed."

DONE_GRACE_MINUTES = 120
_DONE_NOTE_MAX = 300
# Where scripts/run_detached.py keeps its jobs — the same env override and
# default as that script's JOBS_DIR, read here so a session with a job still
# running is never closed under it.
_JOBS_DIR = Path(os.environ.get("EXOCORTEX_JOBS_DIR") or "/var/tmp/exo-jobs")


def _unfinished_jobs(conv_id):
    """Detached jobs this conversation launched that haven't finished yet."""
    jobs = []
    try:
        for meta_path in _JOBS_DIR.glob("*/meta.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if meta.get("conv_id") == conv_id and not meta.get("finished_at"):
                jobs.append(meta.get("label") or meta.get("id"))
    except OSError:
        pass
    return jobs


def _why_not_done(conv_id, entry):
    """The reason a session can't be marked done or closed yet, or None."""
    if entry.get("pinned"):
        return "the pinned Keeper session stays open"
    if entry.get("saved_at"):
        return "the owner saved it for later, to pick back up herself"
    if entry.get("awaiting_input"):
        return "it is still waiting on an answer from the owner"
    if entry.get("spinoff_offer"):
        return "it has a Go button waiting for the owner"
    if _read_approvals(conv_id).get("pending"):
        return "it has a command waiting for the owner's approval"
    jobs = _unfinished_jobs(conv_id)
    if jobs:
        return "a detached job is still running: " + ", ".join(jobs)
    return None


def mark_done(conv_id, note=""):
    """Stamp a session done, starting its countdown to closing. The one door
    scripts/session_done.py uses. Returns (payload, status): 400 on a bad id
    or a reason it can't be done yet, 404 on an unknown conversation."""
    if not (conv_id and _CONV_ID_RE.match(str(conv_id))):
        return {"error": "invalid conversation id"}, 400
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        reason = _why_not_done(conv_id, entry)
        if reason:
            return {"error": f"not done: {reason}"}, 400
        entry["done_at"] = _now()
        entry["closes_at"] = (datetime.now() + timedelta(minutes=DONE_GRACE_MINUTES)
                              ).isoformat(timespec="seconds")
        # Its final output is the rest of this turn (the closing report comes
        # after the stamp), so final_at is written when the turn ends.
        entry.pop("final_at", None)
        if entry.get("running"):
            entry["final_pending"] = True
        else:
            entry["final_at"] = entry["done_at"]
        note = (note or "").strip()[:_DONE_NOTE_MAX]
        if note:
            entry["done_note"] = note
        else:
            entry.pop("done_note", None)
    return {"ok": True, "done_at": entry["done_at"],
            "closes_at": entry["closes_at"]}, 200


_DONE_FIELDS = ("done_at", "done_note", "closes_at", "final_at", "final_pending")


def _clear_done(entry):
    """Take a session's done stamp off, countdown and all."""
    for field in _DONE_FIELDS:
        entry.pop(field, None)


def _end_turn_done(conv_id, entry):
    """At a turn's end, settle a done stamp: the turn that stamped it records
    when its final output finished; a later turn that left the session unable
    to close (asking her, a job running) takes the stamp off."""
    if not entry.get("done_at"):
        return
    if entry.pop("final_pending", None):
        entry["final_at"] = _now()
    elif _why_not_done(conv_id, entry):
        _clear_done(entry)


def keep_open(conv_id):
    """Cancel a done countdown — her Keep open button. Returns (payload, status)."""
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        _clear_done(entry)
    return {"ok": True}, 200


# --- Save for later: park a session she'll come back to --------------------
# Her "not now, but keep it" for a session: `saved_at` on its entry. A saved
# session stays open and holds everything it had, open questions included, but
# asks nothing of her until she picks it back up: the idle check never wakes
# it, it can't be marked done or auto-closed (_why_not_done names it), the room
# helper won't move it (room_helper.py), and the roster lifts it out of the
# rooms into a shut "Saved for later" section (frontend SavedLane.tsx). Her own
# message into it picks it back up (_clear_waiting_on_her), as does the Pick
# back up button.
#
# Prompt: "i'm also wanting to be able to save projects for later that the
# system check doesn't send checks to ... i want to do it later and keep that
# open but i don't want to look at it right now and i don't want it to be
# checking if it's still open every day."

def save_for_later(conv_id, saved=True):
    """Save a session for later, or pick it back up (saved=False). Saving
    also stops a done countdown, since a saved session stays open. The Keeper
    can't be saved: it's the door to her day. Returns (payload, status)."""
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict) or entry.get("archived"):
            return {"error": "not found"}, 404
        if saved and entry.get("pinned"):
            return {"error": "the pinned Keeper session can't be saved for later"}, 400
        if saved:
            entry["saved_at"] = entry.get("saved_at") or _now()
            _clear_done(entry)
        else:
            entry.pop("saved_at", None)
    return {"ok": True, "saved_at": entry.get("saved_at")}, 200


def close_conversation(conv_id):
    """Close a session: stop any live turn, take it off the roster, clean up.
    Nothing is deleted — the jsonl log and index entry stay. The pinned Keeper
    session always stays open. Returns (payload, status).

    Closing STOPS a running turn, the agent and everything it started: killed
    here if this worker owns the process, else killed from the turn's process
    record (any worker can), with stop_requested set either way so the host
    reads the death as deliberate. Pinned is checked FIRST, so refusing to
    close the Keeper never kills its turn."""
    _chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        if entry.get("pinned"):
            return {"error": "the pinned Keeper session stays open"}, 400
        killed_here = _kill_local_proc(conv_id)
        was_running = killed_here or _effective_running(conv_id, entry)
        if not killed_here and entry.get("running"):
            entry["stop_requested"] = _now()
        record = dict(entry.get("turn_proc") or {})
        entry["archived"] = _now()
        _clear_done(entry)
        reap = entry.get("worktree")
        filed = entry.get("spinoff_slug")
    # Kill the agent directly rather than wait for its host's stop poll —
    # AFTER the lock is released, so stop_requested is already on disk when
    # the host sees its agent die.
    agent = _kill_recorded_agent({"turn_proc": record}) if was_running else None
    # Outside the lock (git is slow, every send wants this lock). Closing is
    # the ONE moment a worktree can be removed safely: it's the session's
    # cwd, and a conversation can only ever be resumed from the directory it
    # was born in — so while the session is open, deleting the copy would
    # silently make it unresumable forever. The BRANCH survives; that's
    # where the work is until it's merged.
    # Not while anything still stands in it: a turn being closed is waited
    # out first, or an agent a few steps from noticing the stop would go on
    # writing into a folder that's gone. One that won't die in time keeps its
    # worktree — a leftover folder costs disk, a pulled one costs the work.
    if reap and was_running and not _wait_turn_gone(conv_id, agent, record.get("boot")):
        print(f"close {conv_id}: turn still alive after {_CLOSE_WAIT_SEC}s — "
              f"leaving its worktree {reap}", file=sys.stderr)
        reap = None
    if reap:
        worktrees.remove(reap)
    # Closing is also when the brief stops being live work and becomes a
    # record. It is MOVED, never deleted — the brief is the only thing that
    # says what this session was asked to do, and git can show what changed
    # but never what was wanted. Import here, not at module top: spinoff
    # imports this module.
    if filed:
        from routes.spinoff import archive_spinoff
        archive_spinoff(filed)
    return {"ok": True}, 200


def close_done_sessions(now=None):
    """Close every session whose done countdown has run out. Returns the ids
    closed. Called once a minute by scripts/coming_up_dispatcher.py.

    Re-checks at close time what mark_done checked, plus that no turn is
    running: something may have started since the stamp (a turn clears it
    anyway, but a job or an approval can appear without one)."""
    now = now or datetime.now()
    due = []
    for conv_id, entry in store.read("bot_chats/index", {}).items():
        if not isinstance(entry, dict) or entry.get("archived"):
            continue
        try:
            closes_at = datetime.fromisoformat(str(entry.get("closes_at")))
        except ValueError:
            continue
        if closes_at <= now and not _effective_running(conv_id, entry) \
                and not _why_not_done(conv_id, entry):
            due.append(conv_id)
    closed = []
    for conv_id in due:
        _, status = close_conversation(conv_id)
        if status == 200:
            closed.append(conv_id)
    return closed


# --- Idle check: a session quiet for a day asks itself whether it's done ------
# The backstop for sessions that finished without running session_done.py.
# Once a session has sat idle IDLE_CHECK_HOURS, the minute tick wakes it with
# one System message asking it to look at its own job: finished → it runs
# session_done.py (the usual countdown and Keep open button follow); not
# finished → it says in a line what's left, and stays. `idle_check_at` marks
# the ask, so each quiet spell is asked about once; the woken turn moves
# `last_at`, so a session that stays gets asked again a day later. Sessions
# that can't be done anyway (_why_not_done) — saved-for-later ones among
# them — and ones already counting down are skipped. At most IDLE_CHECKS_PER_TICK wake per minute, oldest first, so
# a backlog of old sessions trickles in instead of starting all at once.
#
# Prompt: "1 day i think it will check itself and see if it should still be
# running and if not close itself"

IDLE_CHECK_HOURS = 24
IDLE_CHECKS_PER_TICK = 2
IDLE_CHECK_SOURCE = "idle-check"


def idle_check_message(idle_hours):
    """What the woken session is told, and how the chat and journal show it.
    Returns (text, system) — the follow-up queue's pair, as in
    scripts/run_detached.py wake_message."""
    done_script = Path(__file__).resolve().parents[1] / "scripts" / "session_done.py"
    python = Path(__file__).resolve().parents[1] / "venv" / "bin" / "python3"
    summary = f"Idle check — no activity for {idle_hours} hours; is this session done?"
    text = (
        f"[Idle check — this session has had no activity for {idle_hours} hours]\n"
        "Look at what this session was started for and where it stands. "
        "Don't start new work.\n"
        "- If the job is completely finished (work committed, result reported, "
        "nothing waiting on the owner), close it: "
        f'`{python} {done_script} "<one line: what was finished>"`.\n'
        "- If it isn't, say in one or two lines what's left and why this "
        "session should stay open, then end the turn."
    )
    system = {"display": summary, "journal": summary, "source": IDLE_CHECK_SOURCE,
              "item_id": None}
    return text, system


def idle_check_sessions(now=None):
    """Wake sessions idle past IDLE_CHECK_HOURS with the idle-check question.
    Returns the ids woken. Called once a minute by
    scripts/coming_up_dispatcher.py."""
    now = now or datetime.now()
    cutoff = now - timedelta(hours=IDLE_CHECK_HOURS)
    # Pick the sessions that are idle, unasked since, and could be done.
    candidates = []
    for conv_id, entry in store.read("bot_chats/index", {}).items():
        if not isinstance(entry, dict) or entry.get("archived") or entry.get("done_at"):
            continue
        last_seen = str(entry.get("last_at") or entry.get("started") or "")
        try:
            last = datetime.fromisoformat(last_seen)
        except ValueError:
            continue
        if last > cutoff or str(entry.get("idle_check_at") or "") >= last_seen:
            continue
        if _effective_running(conv_id, entry) or _why_not_done(conv_id, entry):
            continue
        candidates.append((last, conv_id))
    # Stamp the ask BEFORE queueing, so a crash between the two costs one
    # check rather than a check every minute.
    woken = []
    for last, conv_id in sorted(candidates)[:IDLE_CHECKS_PER_TICK]:
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if not isinstance(entry, dict):
                continue
            entry["idle_check_at"] = _now()
        idle_hours = int((now - last).total_seconds() // 3600)
        text, system = idle_check_message(idle_hours)
        queue_followup(conv_id, text, system=system)
        woken.append(conv_id)
    return woken


# --- Act-vs-ask APPROVALS: the inline Approve/Deny for a gated command -------
# When the gate (tools/act_ask_gate.py) would deny a Bash command in a real
# spawned turn, it records it as `pending` in a per-conversation sidecar
# (bot_chats/approvals/<conv_id>.json) instead of a bare deny. That `pending`
# rides the roster onto the session's Orchestra card as `awaiting_approval`,
# which shows Approve / Deny. Approve moves the command into `once` (one-shot,
# the hook consumes it on next use) or `always` (sticky for this session); the
# hook then lets that exact command through. This is a plain shared-file sidecar
# (not a store collection) precisely because the stdlib-only hook — a separate
# process that can't import store — reads and writes the same file; both sides
# keep to the same shape and atomic-replace writes.

def _approvals_dir():
    return store.DATA_DIR / "bot_chats" / "approvals"


def _approvals_path(conv_id):
    return _approvals_dir() / f"{conv_id}.json"


def _read_approvals(conv_id):
    try:
        data = json.loads(_approvals_path(conv_id).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_approvals(conv_id, data):
    path = _approvals_path(conv_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


def _pending_approval(conv_id):
    """The command awaiting her tap on this conversation, or None — read onto
    the roster so the Orchestra card can raise the Approve/Deny UI."""
    pending = _read_approvals(conv_id).get("pending")
    if isinstance(pending, dict) and pending.get("command"):
        return pending
    return None


# Running token/cost totals per conversation, so the roster doesn't re-read
# every transcript on every poll. Keyed by conversation id; each entry
# remembers how far into the .jsonl it has already counted, so a poll only
# ever reads the bytes appended since the last one. Per-worker (gunicorn runs
# more than one) — each worker just converges on the same numbers by itself.
_TOKEN_TOTALS = {}


def _session_tokens(conv_id):
    """Tokens and dollars this session has spent, summed from its transcript.

    Claude Code writes one `result` record per completed turn carrying that
    turn's `usage` and `total_cost_usd`, so the whole job is adding those up.
    We report OUTPUT tokens — the same number the in-session working line
    counts, and the one that means "how much did this agent actually write."
    Input is dominated by cache reads (hundreds of thousands of tokens a turn,
    at a tenth the price), so totalling everything would produce a big
    frightening number that says nothing about the work.

    Honest lag: a turn's record only lands when the turn ENDS, so a session
    mid-turn shows its total as of the last finished turn. The live count for
    the turn in flight is the composer's working line, which is the estimate
    it already shows.

    Prompt that produced it: "make it such that the number of tokens a session
    has used displays on the session card and maybe inside of the session
    somewhere."
    """
    path = _chats_dir() / f"{conv_id}.jsonl"
    try:
        size = path.stat().st_size
    except OSError:
        return None
    state = _TOKEN_TOTALS.get(conv_id)
    # A shrunken file means it was rewritten under us — recount from scratch.
    if state is None or size < state["offset"]:
        state = {"offset": 0, "output": 0, "cost": 0.0}
    if size > state["offset"]:
        try:
            with open(path, "rb") as f:
                f.seek(state["offset"])
                chunk = f.read(size - state["offset"])
        except OSError:
            return None
        # Only consume up to the last complete line: a turn may be appending
        # right now, and half a JSON object counted once is wrong forever.
        cut = chunk.rfind(b"\n")
        if cut >= 0:
            for raw in chunk[:cut].splitlines():
                if not raw.strip():
                    continue
                try:
                    rec = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    continue
                if rec.get("type") != "result":
                    continue
                usage = rec.get("usage")
                if isinstance(usage, dict):
                    try:
                        state["output"] += int(usage.get("output_tokens") or 0)
                    except (TypeError, ValueError):
                        pass
                try:
                    state["cost"] += float(rec.get("total_cost_usd") or 0)
                except (TypeError, ValueError):
                    pass
            state["offset"] += cut + 1
        _TOKEN_TOTALS[conv_id] = state
    if not state["output"] and not state["cost"]:
        return None
    return {"output": state["output"], "cost_usd": round(state["cost"], 4)}


def resolve_approval(conv_id, decision, sticky):
    """Her Approve/Deny on a pending gated command — the validated door the
    approve/deny routes share. On approve the command joins `always` (sticky) or
    `once` (one-shot); either way `pending` clears. Returns (payload, status):
    400 bad id, 404 nothing pending. The caller resumes the turn (her tap + the
    resume send IS the retry — same transport as request_input)."""
    if not (conv_id and _CONV_ID_RE.match(str(conv_id))):
        return {"error": "invalid conversation id"}, 400
    rec = _read_approvals(conv_id)
    pending = rec.get("pending") if isinstance(rec, dict) else None
    if not (isinstance(pending, dict) and pending.get("command")):
        return {"error": "no pending approval"}, 404
    command = pending["command"]
    if decision == "approve":
        key = "always" if sticky else "once"
        bucket = rec.get(key)
        if not isinstance(bucket, list):
            bucket = []
        if command not in bucket:
            bucket.append(command)
        rec[key] = bucket
    rec["pending"] = None
    _write_approvals(conv_id, rec)
    return {"ok": True, "decision": decision, "sticky": bool(sticky),
            "command": command}, 200


def _dismiss_pending(conv_id):
    """Drop any unresolved approval card when she replies to the session by
    hand instead of tapping (a reply moves things on; a card she can't clear is
    the graveyard Orchestra warns against). Best-effort; leaves once/always
    intact. If the command is still blocked, the agent's retry re-raises it."""
    rec = _read_approvals(conv_id)
    if rec.get("pending"):
        rec["pending"] = None
        try:
            _write_approvals(conv_id, rec)
        except OSError:
            pass


# --- Follow-ups: turns the SERVER starts once a conversation is free ---------
# Some messages aren't typed by her in the moment: the "Approved — retry"
# cue after an Approve/Deny tap, and a Coming up reminder at its set time.
# Each has to wait for the conversation's current turn to end (one turn at a
# time), and the waiting used to live in her browser — which gave up after 30
# seconds, and stopped entirely when her phone locked. Approvals were being
# recorded but never resumed that way.
#
# So the waiting lives here. A follow-up goes into a per-conversation queue
# file; `drain_followups` starts the first one whenever the conversation is
# idle, and it's called at the three moments that can make it idle or matter:
# right after queueing, the instant a turn ends (scripts/turn_host.py, and the
# in-worker fallback), and once a minute from scripts/coming_up_dispatcher.py
# as a safety net for a turn process killed mid-turn.
#
# Prompt that produced it: "I also need some kind of fix to things like this
# dropping. Usually when you send off a worker, it drops and you don't run
# when you come back ... Maybe install a poller ... Otherwise just fix it."

# What the agent is told after her tap — the same words the page used to send.
APPROVE_CUE = "Approved — go ahead and retry that exact command now."
DENY_CUE = ("I've denied that command — don't run it. Find another way, or stop "
            "and tell me why.")

# How long a server-sent decision counts as "already resumed" when an older
# cached page fires its own resume for it too.
_RESUMED_MEMORY_SEC = 600


def _followups_path(conv_id):
    return _chats_dir() / "followups" / f"{conv_id}.json"


class _FollowupFile:
    """The queue file, locked for the whole read-modify-write. Shape:
    {"items": [<follow-up>...], "resumed": [{"kind", "command", "at"}...]}."""

    def __init__(self, conv_id):
        self.path = _followups_path(conv_id)

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = open(self.path.with_suffix(".lock"), "w")
        fcntl.flock(self._lock, fcntl.LOCK_EX)
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        data.setdefault("items", [])
        data.setdefault("resumed", [])
        self.data = data
        return data

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
                tmp.write_text(json.dumps(self.data), encoding="utf-8")
                os.replace(tmp, self.path)
        finally:
            fcntl.flock(self._lock, fcntl.LOCK_UN)
            self._lock.close()
        return False


def queue_followup(conv_id, text, record=False, decision=None, system=None):
    """Put a follow-up in this conversation's queue, then try to start it.
    Returns "sent" if it started now, "queued" if it's waiting for the
    current turn to end."""
    # Send it to whoever is doing this session's work now. A session that
    # handed off is retired: a follow-up queued there later (a detached job
    # finishing, a reminder) would start a turn on it, and starting a turn
    # un-archives it. The same forwarding peermail.send does for mail.
    import continuation
    conv_id = continuation.successor(conv_id)
    with _FollowupFile(conv_id) as data:
        data["items"].append({"text": text, "record": bool(record),
                              "decision": decision, "system": system,
                              "queued_at": _now()})
        if isinstance(decision, dict):
            # Remember it so a cached page's own resume for the same tap is
            # ignored (see _already_resumed) — kept even while still queued.
            data["resumed"].append({"kind": decision.get("kind"),
                                    "command": decision.get("command"),
                                    "at": time.time()})
            data["resumed"] = data["resumed"][-20:]
    return "sent" if drain_followups(conv_id) else "queued"


def _already_resumed(conv_id, decision):
    """Has the server already queued the resume for this exact decision?"""
    if not _followups_path(conv_id).exists():
        return False
    cutoff = time.time() - _RESUMED_MEMORY_SEC
    with _FollowupFile(conv_id) as data:
        return any(r.get("kind") == decision.get("kind")
                   and r.get("command") == decision.get("command")
                   and (r.get("at") or 0) >= cutoff
                   for r in data["resumed"])


def drain_followups(conv_id):
    """Start the next queued follow-up if the conversation is free. Returns
    True if a turn was started. Never starts more than one: when that turn
    ends, its own end-of-turn drain starts the next."""
    if not _followups_path(conv_id).exists():
        return False
    with _FollowupFile(conv_id) as data:
        if not data["items"]:
            return False
        item = data["items"][0]
        result = begin_turn(conv_id, item["text"], item.get("record", False),
                            decision=item.get("decision"),
                            system=item.get("system"), fallback=False)
        if result["ok"] or result["status"] == 404:
            # Started — or the conversation is gone, and nothing will ever run
            # it. Either way this item is done.
            data["items"].pop(0)
            return bool(result["ok"])
        # Busy, low on memory, or the turn process wouldn't launch: leave it
        # at the head of the queue for the next end-of-turn or minute tick.
        return False


def move_system_followups(from_conv, to_conv):
    """Move waiting system reminders from one conversation's queue to
    another's — the nightly rollover hands them from the retiring Keeper to
    the new one. Approval cues stay put: they belong to the session that
    asked. Returns how many moved."""
    if not _followups_path(from_conv).exists():
        return 0
    with _FollowupFile(from_conv) as old:
        moving = [it for it in old["items"] if it.get("system")]
        old["items"] = [it for it in old["items"] if not it.get("system")]
    if moving:
        with _FollowupFile(to_conv) as new:
            new["items"].extend(moving)
    return len(moving)


def drain_all_followups():
    """The once-a-minute safety net: try every conversation with a waiting
    follow-up. Returns how many turns were started."""
    folder = _chats_dir() / "followups"
    if not folder.is_dir():
        return 0
    started = 0
    for path in sorted(folder.glob("*.json")):
        if _CONV_ID_RE.match(path.stem) and drain_followups(path.stem):
            started += 1
    return started


# --- The mailbox: messages that start a turn of their own ---------------------
# peermail.py keeps the messages; the running turn's companion hands in what
# it can mid-turn (_deliver_midturn). Whatever is still waiting when the
# session is idle — a message sent to an idle agent, anything marked `queue`,
# or everything left when a turn ends or is interrupted — goes out HERE, all
# of it together in one turn, each message labelled with who sent it.
# Called at the same moments as drain_followups: right after a message is
# sent, when a turn ends, and once a minute as the safety net.

def after_turn(conv_id):
    """What happens the moment a turn ends, before anything queued starts.

    A session that handed off to a continuation is archived now that its last
    reply is written (continuation.hand_off flags it). Otherwise, a Coding
    session past its context cap is asked for its handoff (continuation.check),
    which queues a System follow-up — so it has to run BEFORE the drains below
    it in the turn host, or a waiting message would take the turn first. And
    if the session is in a swarm, its helper is nudged to update."""
    import continuation
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if isinstance(entry, dict) and entry.pop("archive_after_turn", None):
            entry["archived"] = True
            successor = entry.get("continued_by")
        else:
            successor = None
    # Pass the retired session's unread mail and reminders to its successor.
    # Otherwise the drains that run next would start a turn here, and
    # starting a turn un-archives — the old session would come back to life.
    if successor:
        peermail.readdress(conv_id, successor)
        move_system_followups(conv_id, successor)
        drain_inbox(successor)
        return
    # A helper's chat (a swarm's or the room's) is never continued and
    # belongs to no swarm as a member: its only end-of-turn job is rewriting
    # its chat summary (helper_chat.py).
    if isinstance(entry, dict) and entry.get("role") in ("swarm_helper", "room_helper"):
        try:
            import helper_chat
            helper_chat.rewrite_notes(conv_id)
        except Exception as e:
            print(f"helper notes failed for {conv_id}: {e}", file=sys.stderr)
        return
    continuation.check(conv_id)
    # A member of a swarm just did something: its helper updates its
    # summaries (debounced — see swarm_helper.poke).
    try:
        import swarm_helper
        import swarms
        swarm_id = swarms.swarm_of(conv_id)
        if swarm_id is not None:
            swarm_helper.poke(swarm_id, "turn")
    except Exception as e:
        print(f"swarm helper poke failed for {conv_id}: {e}", file=sys.stderr)


def drain_inbox(conv_id, fallback=False):
    """Start a turn with everything waiting for this session, if it's idle.
    Returns True if a turn started."""
    rows = peermail.waiting(conv_id)
    stranded = peermail.handed(conv_id)
    if not rows and not stranded:
        return False
    entry = store.read("bot_chats/index", {}).get(conv_id)
    if not isinstance(entry, dict):
        return False
    # Mail for a session that handed off goes to its successor instead of
    # waking it (continuation.py) — mail can arrive between the handoff and
    # the archive, and the minute tick would otherwise deliver it here.
    if entry.get("continued_by"):
        import continuation
        successor = continuation.successor(conv_id)
        if successor != conv_id:
            peermail.readdress(conv_id, successor)
            return drain_inbox(successor, fallback=fallback)
    if _effective_running(conv_id, entry):
        return False
    # Messages handed into a turn that is over now but never read — its host
    # died before it could put them back (_run_turn's finally does, normally).
    # The agent never saw them, so they go out with this turn.
    if stranded:
        peermail.unclaim(stranded)
        rows = peermail.waiting(conv_id)
        if not rows:
            return False
    # A swarm helper's mail is answered by a helper run, not a chat turn —
    # each run starts fresh from the summaries (swarm_helper.py).
    if entry.get("role") == "swarm_helper":
        import swarm_helper
        return swarm_helper.answer_mail(conv_id)
    won = peermail.claim(rows, "batched")
    if not won:
        return False            # someone else is delivering them
    result = begin_turn(conv_id, None, batch=won, fallback=fallback)
    if result["ok"]:
        peermail.note_delivered(conv_id, won)
        return True
    # Busy after all, low on memory, or the turn wouldn't launch: back to
    # waiting, for the next end-of-turn or the minute tick.
    peermail.unclaim(won)
    return False


def drain_all_inbox():
    """The once-a-minute safety net for the mailbox. Returns turns started."""
    started = 0
    for conv_id in peermail.any_waiting():
        if _CONV_ID_RE.match(conv_id) and drain_inbox(conv_id):
            started += 1
    return started


def _inbox_status(conv_id, entry):
    """Why her messages are still waiting, for the line under each queued row.

    `running` — a turn is going; without one they start a turn as soon as
    there's room. `step` — the step the agent is in right now, read from the
    live tool_calls table (a call with no result yet, from THIS turn): its
    tool, what it's working on, and how long it has run. A handed-in message
    is read the moment that step ends. `policy` — 'queue-only' means this
    session takes messages only between turns."""
    entry = entry if isinstance(entry, dict) else {}
    running = _effective_running(conv_id, entry)
    step = None
    started = entry.get("turn_started")
    if running and started:
        conn = sqlstore.open_db()
        try:
            found = conn.execute(
                "SELECT name, target, at FROM tool_calls WHERE conv = ?"
                " AND parent_tool_use_id IS NULL AND result_at IS NULL AND at >= ?"
                " ORDER BY at LIMIT 1", (conv_id, started)).fetchone()
        finally:
            conn.close()
        if found:
            try:
                seconds = max(0, int((datetime.now() - datetime.fromisoformat(
                    found[2])).total_seconds()))
            except (TypeError, ValueError):
                seconds = None
            step = {"name": found[0], "target": (found[1] or "")[:200],
                    "seconds": seconds}
    return {"running": running, "step": step, "policy": peermail.policy_of(conv_id)}


def peer_send(from_conv, to_conv, text, mode="inject"):
    """One agent messages another — the door scripts/peers.py uses. Stores the
    message, draws it as a card in the sender's own chat so the owner sees
    what was sent, and wakes the recipient if it's idle. Raises ValueError /
    KeyError from peermail.send."""
    if from_conv is not None and not isinstance(
            store.read("bot_chats/index", {}).get(from_conv), dict):
        raise KeyError(from_conv)
    row = peermail.send(to_conv, text, from_conv=from_conv, kind="A", mode=mode)
    if from_conv:
        peermail.append_line(_chats_dir() / f"{from_conv}.jsonl",
                             peermail.peer_line(row, "out"))
    # This message may have made (or grown) a swarm. A new swarm gets its
    # helper, which names it straight away.
    try:
        import swarm_helper
        import swarms
        swarms.sync()
        swarm_id = swarms.swarm_of(row["to_conv"])
        if swarm_id is not None:
            conn = sqlstore.open_db()
            try:
                named = conn.execute("SELECT helper_conv FROM swarms WHERE id = ?",
                                     (swarm_id,)).fetchone()
            finally:
                conn.close()
            if named and not named[0]:
                swarm_helper.poke(swarm_id, "formed")
    except Exception as e:
        print(f"swarm update failed after a message: {e}", file=sys.stderr)
    started = row["status"] == "waiting" and drain_inbox(row["to_conv"])
    return {**row, "started": bool(started)}


def release_peer_message(message_id):
    """The owner lets a held message through: mark it on the sender's card,
    then deliver it like any other. None if it wasn't held."""
    row = peermail.release(message_id)
    if row is None:
        return None
    if row["from_conv"]:
        peermail.append_line(_chats_dir() / f"{row['from_conv']}.jsonl",
                             {"type": "peer-status", "id": row["id"],
                              "status": "waiting", "ts": _now()})
    drain_inbox(row["to_conv"])
    return row


# --- Fork-the-work: offload a bloated long-runner onto a fresh spinoff -------
# From a running session's Orchestra card, read what it is WRITING/creating
# right now (live, same harvest path terrain.py's live overlay uses) and stage a
# clean-context spinoff seeded with that file surface — the durable truth is the
# FILES, so this dodges conversation handoff entirely. TAKE-OVER, not parallel:
# the fork continues the same work and the original should be stopped (two live
# sessions writing the same files clobber each other; parallel needs git
# worktree isolation — a separate, bigger task). Reads are excluded on purpose —
# lookup noise that would bury the signal. Staging only (open_spinoff), never an
# auto-run.


def _fork_work_surface(conv_id, meta):
    """The files a session is writing/creating right now, grouped by repo and
    made repo-relative. Live-parsed (not the batch sidecar) so it reflects this
    moment. Returns [] when the session has written nothing yet — nothing to
    fork."""
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    if not path.is_file():
        return []
    try:
        files = harvest_conversation(
            path, meta.get("cwd"), meta.get("last_at") or meta.get("started"))
    except OSError:
        return []
    repos = _terrain_repos()
    grouped = {}   # repo name -> [(relpath, created_bool), ...]
    for abspath, counts in (files or {}).items():
        if not isinstance(counts, dict):
            continue
        if int(counts.get("writes") or 0) + int(counts.get("creates") or 0) <= 0:
            continue   # a pure read — not part of the work surface
        # A worktree session writes to its own copy of the checkout, which is
        # under neither repo root — so without this every file falls through
        # and the session looks like it has written nothing at all: it vanishes
        # off Terrain and ▶ fork refuses with "isn't writing any files yet".
        # The copy IS the repo, so it's read as the repo.
        abspath = worktrees.as_skeleton_path(abspath)
        for repo in repos:
            try:
                rel = os.path.relpath(abspath, repo["root"])
            except ValueError:
                continue
            if rel == os.curdir or rel.startswith(os.pardir):
                continue   # not under this repo
            grouped.setdefault(repo["name"], []).append(
                (rel.replace(os.sep, "/"), int(counts.get("creates") or 0) > 0))
            break
    return [(name, sorted(items)) for name, items in sorted(grouped.items())]


def _fork_slug(title):
    """A valid, unique-enough spinoff slug from the source title (SLUG_RE in
    routes/spinoff.py: lowercase/digits/hyphens, <=39 chars)."""
    base = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:20] or "session"
    return f"fork-{base}-{datetime.now().strftime('%m%d-%H%M%S')}".strip("-")[:39]


def _fork_brief_md(title, surface):
    """The staged spinoff's BRIEF: the file surface + take-over Protocol. The
    prior session's RECALL is deliberately not handed over — the files are the
    durable truth, and reading them IS the handoff."""
    lines = [f"# Fork: take over the work of “{title}”", "",
             "## The task",
             f"A long-running session (**{title}**) was building the surface below. Its",
             "conversation got long, so this is a **clean-context take-over**: you continue",
             "the SAME work from the files themselves, not from its chat history.", "",
             "## The work surface (what it was writing / creating)"]
    for repo_name, items in surface:
        lines.append(f"**{repo_name}**")
        lines += [f"- `{rel}`{'  — created fresh' if created else ''}" for rel, created in items]
        lines.append("")
    lines += [
        "## Protocol",
        "1. **Read every file above** — that IS the current state of the work; the prior",
        "   session's recall is not handed to you (the files are the durable truth).",
        "2. Infer what is in progress and **continue it** — do not restart from scratch.",
        "3. **Take-over, not parallel:** the original session should be stopped first — two",
        "   sessions writing these same files clobber each other.",
        "4. Follow this repo's CLAUDE.md conventions; test behavior; commit when a thing ships.",
        "",
        "## Result",
        "<Leave empty. Fill in what you continued and shipped.>",
        ""]
    return "\n".join(lines)


# --- the hovercard's last line of conversation -------------------------------
# Hover an agent orb on /terrain and the card wants the last thing actually SAID
# in that session. The whole transcript is the wrong thing to ship for that — a
# long session's jsonl runs to megabytes — so this reads only the tail of the
# file and walks it backwards until it finds speech.
#
# Prompt that produced it: "if you scroll up close and hover over an agent, it
# shows a hovering popup with the last message and the summary and card
# information".

# How much of the tail to read. Generous on purpose: the last *speech* can sit
# behind a long run of tool events, and 256KB is still one cheap seek.
_PREVIEW_TAIL_BYTES = 262_144
# What the card can actually hold before it stops being a hovercard.
_PREVIEW_CHARS = 700
# How much of a long transcript the Activity pane's first read covers. Enough
# for the last several turns of a busy session; the older hours are in the
# conversation itself and in the tool_calls table.
_ACTIVITY_WINDOW_BYTES = 3 * 1024 * 1024


def _message_prose(message):
    """The prose out of one claude message. `content` is either a string or a
    list of blocks, of which only the text ones carry words — a message that was
    nothing but tool calls comes back empty, which is what lets the caller keep
    walking back to the last thing that was really said."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = [b.get("text") for b in content
             if isinstance(b, dict) and b.get("type") == "text"
             and isinstance(b.get("text"), str) and b.get("text").strip()]
    return "\n\n".join(parts).strip()


def _conversation_last_said(path):
    """The last thing SAID in a conversation — the agent's newest reply, or her
    ask when that's the newest thing in the log. Returns (role, text), or
    (None, "") for a session that hasn't spoken yet.

    Reads at most the last `_PREVIEW_TAIL_BYTES` and walks those lines in
    reverse, so a megabyte-long session costs the same as a fresh one. The seek
    lands mid-line, so the first (torn) line is dropped."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as fh:
            if size > _PREVIEW_TAIL_BYTES:
                fh.seek(size - _PREVIEW_TAIL_BYTES)
                fh.readline()
            lines = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None, ""
    for line in reversed(lines):
        try:
            ev = json.loads(line)
        except ValueError:
            continue   # a torn line (crash mid-append) shouldn't hide the rest
        if not isinstance(ev, dict):
            continue
        if ev.get("type") == "assistant":
            text = _message_prose(ev.get("message"))
            if text:
                return "assistant", text
        elif ev.get("type") == "user":
            # {"type": "user", "text": ...} is HER, typed. A user event carrying
            # a `message` instead is claude echoing a tool result back to itself
            # — machinery, not speech, so it never becomes the card's line.
            text = ev.get("text")
            if isinstance(text, str) and text.strip():
                return "user", text.strip()
    return None, ""


# --- Searching the archive -------------------------------------------------
# Every conversation is one NDJSON file (bot_chats/<conv>.jsonl) of raw Claude
# Code stream events, so "search everything I've ever said" is a walk over
# those files — no index, no schema, nothing to keep in step with the record.
# That's deliberate: an index is a second copy of the truth that can drift, and
# at this scale (tens to low hundreds of transcripts) the walk is milliseconds.
# When it stops being milliseconds, THAT is when an index earns its place.
#
# The response says how many transcripts it actually read, so a slow day is
# visible rather than silently partial.
_SEARCH_MIN_QUERY = 2          # one letter matches everything; not a search
_SEARCH_HITS_PER_SESSION = 3   # enough to recognise the conversation, not read it
_SEARCH_SNIPPET_PAD = 100      # characters either side of the match
_SEARCH_MAX_SESSIONS = 80      # newest-first; anything past this is reported


def _speech(path):
    """Every human-meaningful line in a transcript, oldest first, as
    (turn_index, who, text).

    Only SPEECH — her typed messages and the agent's prose replies. Tool calls,
    tool results and the usage records are machinery: they'd match a query for
    a filename thousands of times and bury the one moment she actually meant.
    `{"type": "user", "text": ...}` is her, typed; a user event carrying a
    `message` instead is claude echoing a tool result back to itself, which is
    exactly the machinery being excluded (same distinction _conversation_last_
    said draws).

    A torn line (a crash mid-append) is skipped rather than allowed to hide the
    rest of the file."""
    out = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                if ev.get("type") == "assistant":
                    text = _message_prose(ev.get("message"))
                    if text:
                        out.append((len(out), "K", text))
                elif ev.get("type") == "user":
                    text = ev.get("text")
                    if isinstance(text, str) and text.strip():
                        out.append((len(out), "B", text.strip()))
    except OSError:
        return []
    return out


def _snippet(text, needle, pad=_SEARCH_SNIPPET_PAD):
    """The match with room to breathe either side, and where the match sits
    inside what's returned — the client needs the offset to mark the words, and
    recomputing it there would mean re-implementing this trimming in two
    languages. Collapses whitespace first so a snippet out of a code block
    doesn't arrive as a column of newlines."""
    flat = " ".join(text.split())
    at = flat.lower().find(needle)
    if at < 0:
        return None
    start = max(0, at - pad)
    end = min(len(flat), at + len(needle) + pad)
    body = flat[start:end]
    return {"text": ("…" if start > 0 else "") + body + ("…" if end < len(flat) else ""),
            "at": (at - start) + (1 if start > 0 else 0),
            "len": len(needle)}


def register(app):
    # The /api/bots/* rules below are kept as aliases of the canonical
    # /api/observatory/* paths purely for cached PWA clients (old service-
    # worker installs, bookmarked API calls) — they can be dropped once those
    # have aged out.
    @app.route("/api/observatory")
    @app.route("/api/bots")
    def bots_list():
        """Roster: every open (non-archived) conversation, pinned first then
        newest, with cached card summaries attached. Session-first: returns
        BOTH shapes for the transition. `sessions` is the flat list (each
        item is the raw index entry plus `id` — `draft` rides along for
        free). `bots` is the old per-bot-roster shape, synthesized as a
        single "keeper" entry wrapping the same list, kept for cached PWA
        clients that still expect it."""
        chats = _chats_dir()
        index = store.read("bot_chats/index", {})
        # A turn whose host died is put down before the roster is drawn, so
        # its card is red the moment anyone looks rather than a minute later.
        if mark_dead_turns(index):
            index = store.read("bot_chats/index", {})
        # Ordered by CREATION time, newest first (her 07-27 call), NOT by
        # last activity: a card's spot is fixed the moment it's made, so the
        # roster never reshuffles under her when an agent replies. Recency
        # still shows — the unread accent, the busy/ready dot, the "Xm ago"
        # stamp — it just no longer moves the card. `started` back-fills to
        # last_at for any legacy entry minted before it was stamped.
        sessions = sorted(
            (dict(meta, id=cid) for cid, meta in index.items()
             if isinstance(meta, dict) and not meta.get("archived")),
            key=lambda c: c.get("started") or c.get("last_at", ""), reverse=True)
        # Pinned sessions surface first (the Keeper session lives at the
        # top); the sort above stays stable within each group.
        sessions.sort(key=lambda c: 0 if c.get("pinned") else 1)
        # Mark the sessions that handed their work on to a continuation as
        # retired, so the rooms and swarm pages can sink them to the bottom.
        # Read off the WHOLE index, archived successors included — the same
        # rule as swarms.overview's `retired`.
        # `retired_at` — when its successor started, which is when its final
        # output (the handoff) finished; the unread dot keys on it.
        handed_on = {e.get("spawned_from"): e.get("started") for e in index.values()
                     if isinstance(e, dict) and e.get("spawned_via") == "continue"}
        for c in sessions:
            if c["id"] in handed_on:
                c["retired"] = True
                if handed_on[c["id"]]:
                    c["retired_at"] = handed_on[c["id"]]
        # Resolved ONCE for the whole roster, not per card — it's one file read
        # and the answer is the same for every unpinned session.
        cli_model = _cli_default_model()
        for c in sessions:
            if c.get("running"):
                # Same staleness check bot_conversation applies: a flag
                # orphaned by a dead worker must not read as busy forever
                # on the roster either.
                c["running"] = _effective_running(c["id"], c)
            # Haiku card summaries, same machinery as the tmux /sessions
            # page — cached, background-refreshed, never blocking here.
            summary = recap_summary.get_summary(
                "bot:" + c["id"], chats / f"{c['id']}.jsonl",
                builder=recap_summary.build_bot_dialogue)
            if summary:
                c["summary"] = summary
            # Which model this session's next turn will actually use: its own
            # pin, else the CLI default. Sits BESIDE the raw `model` (which
            # stays exactly as stored) rather than replacing it — same split as
            # act_gate / act_gate_set below, and for the same reason: the ✎
            # dialog's picker must seed from the raw field, or an inherited
            # default would save back as a deliberate pin.
            effective_model = c.get("model") or cli_model
            if effective_model:
                c["model_effective"] = effective_model
            # A gated command the session is blocked on, waiting for her tap —
            # rides onto the Orchestra card exactly like awaiting_input does.
            pending = _pending_approval(c["id"])
            if pending:
                c["awaiting_approval"] = pending
            # What this session has cost so far — read incrementally from its
            # own transcript, so a roster poll costs a seek and not a re-parse.
            tokens = _session_tokens(c["id"])
            if tokens:
                c["tokens"] = tokens
            # Which room the card lives in, and whether it stops to ask —
            # both RESOLVED here (never raw), so the client never has to
            # re-derive a lane for the entries that predate the field.
            #
            # `act_gate_set` is the RAW override beside the resolved answer:
            # true/false when she pinned one, ABSENT when the field is unwritten
            # and the room is driving it. The ✎ dialog seeds its picker from
            # this, never from the resolved `act_gate` — seeding from the
            # resolved value made an inherited "asks" look like a choice, and
            # saving wrote it back as one, so moving Orchestra → Personal kept
            # every gate. Resolved is for showing; raw is for editing.
            c["lane"] = _conv_lane(c)
            if c.get("act_gate") is not None:
                c["act_gate_set"] = c["act_gate"] is True
            c["act_gate"] = _conv_config(c)["act_gate"]
        bots = [{"id": "keeper", "name": "Keeper", "journal": True,
                 "conversations": sessions}]
        # The model picker's options ride along with the roster so the server
        # stays the single authority on what the settings route will accept
        # (the client only supplies display labels).
        return jsonify({"sessions": sessions, "bots": bots,
                        "model_choices": list(_MODEL_CHOICES)})

    @app.route("/api/observatory/search")
    def observatory_search():
        """Search everything ever said, across every session, archived included.

        `?q=` is a plain case-insensitive substring — not a query language. She
        is looking for a thing she remembers saying, and every operator syntax
        ever shipped is a thing to get wrong at the moment she's already
        struggling to remember the words.

        Returns one entry per session that matches, newest first, each with up
        to _SEARCH_HITS_PER_SESSION snippets and the offset of the match inside
        each — enough to recognise the conversation from the results, not
        enough to read it there. Reading is what opening the session is for.

        JOURNALLED SESSIONS ARE INCLUDED, unlike the terrain hovercard's
        preview, which withholds them. Different act: the hovercard quotes her
        diary at a passing cursor, this answers a question she deliberately
        typed into her own archive. Excluding them would silently fail exactly
        the search she most wants — the Keeper session is journalled, and it's
        where most of what she'd go looking for was said. Each hit says whether
        it came from a journalled session so the client can mark it.

        Prompt that produced it: "i'm also wanting a way to see past sessions
        and the contents of them ... navigate to another page where i can
        scroll around and search inside of it and see stuff."
        """
        q = (request.args.get("q") or "").strip()
        if len(q) < _SEARCH_MIN_QUERY:
            return jsonify({"query": q, "results": [], "scanned": 0, "truncated": False})
        needle = q.lower()
        index = store.read("bot_chats/index", {})
        chats = _chats_dir()
        # Newest first, so a capped scan drops the oldest rather than an
        # arbitrary slice of the directory.
        entries = sorted(
            ((cid, meta) for cid, meta in index.items() if isinstance(meta, dict)),
            key=lambda kv: kv[1].get("last_at") or kv[1].get("started") or "",
            reverse=True)
        truncated = len(entries) > _SEARCH_MAX_SESSIONS
        entries = entries[:_SEARCH_MAX_SESSIONS]

        results = []
        scanned = 0
        for cid, meta in entries:
            path = chats / f"{cid}.jsonl"
            if not path.is_file():
                continue
            scanned += 1
            # The title is worth matching too: "the housing one" is a real way
            # to look for a conversation, and it may never say "housing" inside.
            title = meta.get("title") or ""
            hits = []
            for turn, who, text in _speech(path):
                if needle not in text.lower():
                    continue
                snip = _snippet(text, needle)
                if snip:
                    hits.append(dict(snip, turn=turn, who=who))
                if len(hits) >= _SEARCH_HITS_PER_SESSION:
                    break
            title_hit = needle in title.lower()
            if not hits and not title_hit:
                continue
            results.append({
                "id": cid,
                "title": title or cid,
                "title_hit": title_hit,
                "lane": _conv_lane(meta),
                "journal": meta.get("journal") is True,
                "archived": bool(meta.get("archived")),
                "pinned": bool(meta.get("pinned")),
                "started": meta.get("started"),
                "last_at": meta.get("last_at"),
                "hits": hits,
            })
        return jsonify({"query": q, "results": results,
                        "scanned": scanned, "truncated": truncated})

    @app.route("/api/observatory/atlas")
    def observatory_atlas():
        """The sorter's map: life fronts + exocortex sub-domains (the
        vocabulary), and every session (archived included — the atlas is a
        librarian's view, not the live roster) merged with its gists.json
        entry if `scripts/sort_bot_chats.py` has sorted it yet.

        Reads everything defensively: a missing/malformed fronts.json,
        exo_domains.json, or gists.json degrades to an empty list / unsorted
        sessions, never a 500 — the sorter's sidecar is written by a
        separate process and may not exist yet."""
        fronts_raw = store.read("fronts", {})
        fronts_list = fronts_raw.get("fronts") if isinstance(fronts_raw, dict) else None
        fronts = [{"id": f["id"], "name": f.get("name", f["id"])}
                  for f in (fronts_list or []) if isinstance(f, dict) and f.get("id")]

        domains_raw = store.read("exo_domains", {})
        domains_list = domains_raw.get("domains") if isinstance(domains_raw, dict) else None
        domains = [{"id": d["id"], "name": d.get("name", d["id"]),
                    "description": d.get("description", "")}
                   for d in (domains_list or []) if isinstance(d, dict) and d.get("id")]

        index = store.read("bot_chats/index", {})
        gists_raw = store.read("bot_chats/gists", {})
        gists = gists_raw if isinstance(gists_raw, dict) else {}

        sessions = []
        for conv_id, meta in index.items():
            if not isinstance(meta, dict):
                continue
            g = gists.get(conv_id)
            if not isinstance(g, dict):
                g = {}
            tags = g.get("tags")
            sessions.append({
                "id": conv_id,
                "title": g.get("title") or meta.get("title") or "Untitled",
                "gist": g.get("gist"),
                "tags": tags if isinstance(tags, list) else [],
                "front": g.get("front"),
                "domain": g.get("domain"),
                "bot": meta.get("bot"),
                # Which room it lived in. The archive is read inside the
                # Observatory now, where the room is how she thinks about a
                # session — so a past one has to be able to say which it was.
                "lane": _conv_lane(meta),
                "journal": meta.get("journal") is True,
                "started": meta.get("started"),
                "last_at": meta.get("last_at"),
                "archived": bool(meta.get("archived")),
                "pinned": bool(meta.get("pinned")),
            })
        sessions.sort(key=lambda s: s.get("last_at") or s.get("started") or "",
                      reverse=True)
        return jsonify({"fronts": fronts, "domains": domains, "sessions": sessions})

    # GET /api/observatory/terrain and /terrain/file live in routes/terrain.py
    # (split 08-03) — registered separately by server.py under the same
    # feature flag.

    @app.route("/api/observatory/keeper/rollover", methods=["POST"])
    @app.route("/api/bots/keeper/rollover", methods=["POST"])
    def keeper_rollover_start():
        """Fire the same close/open job cron runs at 3 AM, on demand — the
        Automations page's manual-run button. Spawned detached and never
        waited on: a rollover can run for several minutes (waiting out a
        mid-flight /endsession, then a full /journalstart turn), far longer
        than this request should stay open. `sys.executable` is gunicorn's
        venv python — the same interpreter cron invokes the script with, so
        imports resolve identically either way. The 409 here is a courtesy
        (fast, friendly feedback) — the real exclusion guarantee is the
        lock scripts/keeper_rollover.py takes for itself the moment it
        starts a real run."""
        if rollover_running():
            return jsonify({"error": "a rollover is already running"}), 409
        skeleton_root = Path(__file__).resolve().parents[1]
        script = skeleton_root / "scripts" / "keeper_rollover.py"
        log_path = store.DATA_DIR / "keeper_rollover.ui.log"
        with open(log_path, "a") as log_f:
            subprocess.Popen(
                [sys.executable, str(script), "roll"],
                stdout=log_f, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        return jsonify({"ok": True, "started": True}), 202

    @app.route("/api/observatory/keeper/rollover/status")
    @app.route("/api/bots/keeper/rollover/status")
    def keeper_rollover_status():
        """What the Automations card polls: whether a rollover is in flight
        right now, which pinned Keeper conversation is currently the diary
        door (same scan scripts/keeper_rollover.py's _find_pinned does —
        latest last_at among non-archived pinned bot=="keeper" entries), and
        the scheduled_runs.json registry entry the script writes its outcome
        to (last_run/last_status/last_conv_id/last_cost_usd), if it has ever
        run."""
        index = store.read("bot_chats/index", {})
        candidates = [(cid, meta) for cid, meta in index.items()
                      if isinstance(meta, dict) and meta.get("bot") == "keeper"
                      and meta.get("pinned") and not meta.get("archived")]
        pinned_conv_id = None
        if candidates:
            candidates.sort(key=lambda c: c[1].get("last_at", ""), reverse=True)
            pinned_conv_id = candidates[0][0]
        runs = store.read("scheduled_runs.json", {"runs": []}).get("runs", [])
        registry = next((r for r in runs if isinstance(r, dict)
                         and r.get("id") == "keeper_rollover"), None)
        return jsonify({"running": rollover_running(),
                        "pinned_conv_id": pinned_conv_id,
                        "registry": registry})

    @app.route("/api/observatory/conversation/<conv_id>/close", methods=["POST"])
    @app.route("/api/bots/conversation/<conv_id>/close", methods=["POST"])
    def bot_conv_close(conv_id):
        """Close a session by hand — her ×. The work is close_conversation."""
        payload, status = close_conversation(conv_id)
        return jsonify(payload), status

    @app.route("/api/observatory/conversation/<conv_id>/keep", methods=["POST"])
    def bot_conv_keep(conv_id):
        """Keep open: cancel a done session's countdown to closing."""
        payload, status = keep_open(conv_id)
        return jsonify(payload), status

    @app.route("/api/observatory/conversation/<conv_id>/save", methods=["POST"])
    def bot_conv_save(conv_id):
        """Save for later ({"saved": true}, the default) or pick back up
        ({"saved": false}). The work is save_for_later."""
        saved = (request.get_json(silent=True) or {}).get("saved", True) is not False
        payload, status = save_for_later(conv_id, saved)
        return jsonify(payload), status

    @app.route("/api/observatory/conversation/<conv_id>/evidence", methods=["GET"])
    def observatory_conv_evidence(conv_id):
        """What an unattended session actually changed, read from git.

        Only ever evidence. This endpoint used to carry a second half — the
        session's own REPORT.md prose — travelling beside the numbers with the
        surface labelling which was which, because a well-written explanation of
        broken code reads exactly like a good outcome. The reports were removed
        2026-08-22 (nobody read them; see claude-commands/spinoff.md), and what
        survived is the half that was never the agent's word for it.
        """
        entry = store.read("bot_chats/index", {}).get(conv_id)
        if not isinstance(entry, dict):
            return jsonify({"error": "not found"}), 404
        ev = None
        if entry.get("worktree") and entry.get("branch"):
            ev = worktrees.evidence(entry["worktree"], entry["branch"])
        return jsonify({"conversation_id": conv_id,
                        "slug": entry.get("spinoff_slug"),
                        "evidence": ev})

    @app.route("/api/observatory/conversations", methods=["POST"])
    def observatory_conv_create():
        """Create a session in a LANE. Body: {title, journal, model, lane},
        and optionally `swarm` (a live swarm's id) to start it inside a swarm.

        The lane picks cwd and the two safety-net defaults (see _lane_profile):
        `orchestra` roots in the app checkout and asks before irreversible
        work; `coding` roots in the app checkout and just acts; `personal`
        roots at the parent of both repos and just acts; `research` roots in
        the research-room folder and just acts. All four carry the full
        builder toolkit — the lane gates asking, not ability.

        `act_gate`/`guard_docs` are deliberately NOT written here: leaving them
        absent is what lets the lane keep driving them, so moving a session
        between lanes actually re-scopes it. The ✎ dialog writes them only when
        she overrides. Same idea for `model` — an omitted one writes no field
        and so follows the CLI default. `bot: "keeper"` is a display field for
        old sidecars/terrain only."""
        data = request.json or {}
        title = (data.get("title") or "").strip()[:60]
        # Journal is OPT-IN and rare: the diary is the pinned Keeper session's
        # door; every other session is a workshop unless deliberately toggled.
        journal = data.get("journal") is True
        model = (data.get("model") or "").strip()
        if model and model not in _MODEL_CHOICES:
            return jsonify({"error": f"unknown model {model!r}"}), 400
        lane = (data.get("lane") or _DEFAULT_LANE).strip()
        if lane not in _LANES:
            return jsonify({"error": f"unknown lane {lane!r}"}), 400
        profile = _lane_profile(lane)
        # `front` — set when the session is started from a front's room. Two
        # things follow from it, and they're separable:
        #   TAG: the front lands on the index entry, so the room's sessions
        #     panel can find it. This is EXPLICIT filing and it outranks
        #     whatever scripts/sort_bot_chats.py would later infer.
        #   SEED: unless seed=false, the front's brief (its open to-dos, buy
        #     list and threads) is written to disk and pointed at by
        #     system_prompt_file, so the conversation opens already knowing
        #     which part of her life it's in.
        front = (data.get("front") or "").strip()
        brief_path = None
        if front:
            from routes import fronts as fronts_mod
            if not fronts_mod.is_known_front(front):
                return jsonify({"error": f"unknown front {front!r}"}), 400
            if data.get("seed") is not False:
                brief_path = fronts_mod.write_front_brief(front)
        # `swarm` — set when the session is started from a swarm's page. The
        # swarm must be live; the session joins it once it exists, below.
        swarm_id = data.get("swarm")
        if swarm_id is not None:
            import swarms
            if not isinstance(swarm_id, int) or swarm_id not in swarms.sync():
                return jsonify({"error": f"unknown swarm {swarm_id!r}"}), 400
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            conv_id = _new_conv_id(index)
            index[conv_id] = {"bot": "keeper", "started": _now(), "last_at": _now(),
                              "claude_session_id": None, "cost_usd": 0.0,
                              "title": title or "New session", "journal": journal,
                              "lane": lane, "cwd": profile["cwd"],
                              "allowed_tools": list(profile["allowed_tools"])}
            if model:
                index[conv_id]["model"] = model
            if front:
                index[conv_id]["front"] = front
            # Only written for a seeded front session — a bare create must
            # leave the field absent so persona sessions keep owning it.
            if brief_path:
                index[conv_id]["system_prompt_file"] = brief_path
        # Join the swarm and tell the session where it woke up. It's a member
        # before it has messaged anyone (swarms.join), and a seed file (added
        # to a front brief when there is one) names the swarm, its summary and
        # its members. The helper is poked so its summaries pick the newcomer up.
        if swarm_id is not None:
            import swarm_helper
            swarms.join(swarm_id, conv_id)
            seed = swarms.seed_text(swarm_id)
            if seed:
                if brief_path:
                    seed_path = Path(brief_path)
                    seed = seed_path.read_text(encoding="utf-8") + "\n" + seed
                else:
                    folder = _chats_dir() / "swarm_seed"
                    folder.mkdir(parents=True, exist_ok=True)
                    seed_path = folder / f"{conv_id}.md"
                seed_path.write_text(seed, encoding="utf-8")
                with store.mutate("bot_chats/index", {}) as index:
                    index[conv_id]["system_prompt_file"] = str(seed_path)
            try:
                swarm_helper.poke(swarm_id, "joined")
            except Exception as e:
                print(f"swarm helper poke failed after a join: {e}", file=sys.stderr)
        return jsonify({"ok": True, "id": conv_id, "lane": lane,
                        "front": front or None, "seeded": bool(brief_path),
                        "swarm": swarm_id})

    @app.route("/api/observatory/<bot_id>/conversations", methods=["POST"])
    @app.route("/api/bots/<bot_id>/conversations", methods=["POST"])
    def bot_conv_create(bot_id):
        """LEGACY: create a session the old bot-lookup way (vault cwd, no
        allowed_tools field written — new entries read back through the
        read-only legacy fallback in _conv_config). Kept for cached PWA
        clients; new callers should use POST /api/observatory/conversations."""
        bot = _bot(bot_id)
        if not bot:
            return jsonify({"error": "unknown bot"}), 404
        data = request.json or {}
        title = (data.get("title") or "").strip()[:60]
        # Journal is OPT-IN and rare: the diary is the pinned Keeper session's
        # door; every other session is a workshop unless deliberately toggled.
        journal = data.get("journal") is True
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            conv_id = _new_conv_id(index)
            index[conv_id] = {"bot": bot_id, "started": _now(), "last_at": _now(),
                              "claude_session_id": None, "cost_usd": 0.0,
                              "title": title or "New session", "journal": journal,
                              "cwd": bot.get("cwd")}
        return jsonify({"ok": True, "id": conv_id})

    @app.route("/api/observatory/conversation/<conv_id>/settings", methods=["POST"])
    @app.route("/api/bots/conversation/<conv_id>/settings", methods=["POST"])
    def bot_conv_settings(conv_id):
        """Rename, flip a session's journal switch, and/or pin its model.
        Pinning (the sort kind) is data-only for now (set at import/migration)
        — the pinned Keeper session stays the one diary door.

        `model`: one of _MODEL_CHOICES, or "" / null to DROP the field and go
        back to inheriting the CLI default. An unknown value is rejected
        rather than silently ignored — a typo'd model would otherwise fail
        every turn from then on, far from here."""
        data = request.json or {}
        # Validate BEFORE opening the mutate block: an early `return` inside
        # `with store.mutate(...)` is not an exception, so the context manager
        # commits on the way out — a rejected field would otherwise persist
        # the fields validated before it.
        title = None
        if "title" in data:
            title = (data.get("title") or "").strip()[:60]
            if not title:
                return jsonify({"error": "empty title"}), 400
        model = None
        if "model" in data:
            model = (data.get("model") or "").strip()
            if model and model not in _MODEL_CHOICES:
                return jsonify({"error": f"unknown model {model!r}"}), 400
        lane = None
        if "lane" in data:
            lane = (data.get("lane") or "").strip()
            if lane not in _LANES:
                return jsonify({"error": f"unknown lane {lane!r}"}), 400
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if not isinstance(entry, dict):
                return jsonify({"error": "not found"}), 404
            if title:
                entry["title"] = title
            if "journal" in data:
                entry["journal"] = data.get("journal") is True
            if "model" in data:
                # "" / null drops the field — back to inheriting the default.
                if model:
                    entry["model"] = model
                else:
                    entry.pop("model", None)
            if lane:
                # Moving rooms re-scopes the safety nets on the NEXT turn (the
                # config is resolved per turn), with the history intact. It
                # deliberately does NOT move `cwd`: Claude Code stores
                # conversations per directory, so a session that changed ground
                # could never be --resume'd again. A card can change rooms; a
                # session cannot change where it stands.
                entry["lane"] = lane
            if "act_gate" in data:
                # The per-session override. null/absent hands it back to the
                # lane default rather than pinning it — that's the difference
                # between "she chose this" and "it inherited".
                if data.get("act_gate") is None:
                    entry.pop("act_gate", None)
                else:
                    entry["act_gate"] = data.get("act_gate") is True
            # Same resolved-plus-raw shape the roster returns: `act_gate` is
            # what the next turn will DO, `act_gate_set` is her pin (absent =
            # the room is driving it). See the roster for why both are needed.
            out = dict(entry, id=conv_id, lane=_conv_lane(entry),
                       act_gate=_conv_config(entry)["act_gate"])
            if entry.get("act_gate") is not None:
                out["act_gate_set"] = entry["act_gate"] is True
        return jsonify({"ok": True, "conversation": out})

    @app.route("/api/observatory/conversation/<conv_id>/journal-output", methods=["POST"])
    @app.route("/api/bots/conversation/<conv_id>/journal-output", methods=["POST"])
    def bot_journal_output(conv_id):
        """Put one keeper reply into the journal, on a tap — the fine-grained
        opposite of the pause button: works in any session regardless of its
        journal switch, and mints a K card (the keeper's voice, not hers).
        A journal-mark event is appended to the log so the ✦ survives reload
        (matched by text — the log is the same source both sides read)."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        data = request.json or {}
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "empty text"}), 400
        if not isinstance(store.read("bot_chats/index", {}).get(conv_id), dict):
            return jsonify({"error": "not found"}), 404
        if not terminal._capture_journal(text, text, who="K", session=conv_id):
            return jsonify({"error": "journal mint failed"}), 502
        with open(_chats_dir() / f"{conv_id}.jsonl", "a", encoding="utf-8") as log:
            log.write(json.dumps({"type": "journal-mark", "text": text,
                                  "ts": _now()}) + "\n")
        return jsonify({"ok": True})

    @app.route("/api/observatory/conversation/<conv_id>/journal-highlight", methods=["POST"])
    def bot_journal_highlight(conv_id):
        """Put a HIGHLIGHTED SPAN into the journal — the fine-grained sibling of
        journal-output above, which takes a whole reply. She selects text in the
        room (hers or the keeper's), a pill comes up, and the span lands in the
        journal with an optional note attached.

        TWO CARDS, not one. The quote mints in the voice that said it (`who`:
        K for a reply, B for her own message); her note, when she wrote one,
        mints as a B card REPLYING to the quote. One card holding both would
        have to pick a single `who`, and a K card carrying her words is a lie
        about who spoke — the card pool's one invariant. The journal already
        renders a reply with its parent's snippet in the margin
        (routes/cards.py `_reply_context`), so the pair reads as what it was.

        Both cards carry `session: <conv_id>` so the journal can offer a way
        back to the room the words were said in.

        A `journal-highlight` event goes into the session log so the mark comes
        back lit on reload — same durability trick as journal-mark, and the same
        reason: the log is the one source both sides read. `turn`/`start`/`end`
        are the client's anchor (turn index, then character offsets into that
        turn's rendered text); the server stores them verbatim without
        interpreting them, and `quote` is what makes a drifted anchor
        recoverable by eye.

        Prompt: "if I highlight something a little tap comes up for me to put
        that in my journal whether it be keeper output or my output, and I want
        to be able to annotate it and I want it to track which session it came
        from."
        """
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        data = request.json or {}
        quote = (data.get("quote") or "").strip()
        note = (data.get("note") or "").strip()
        who = data.get("who")
        if not quote:
            return jsonify({"error": "empty quote"}), 400
        if who not in ("B", "K"):
            return jsonify({"error": "who must be B or K"}), 400
        turn = data.get("turn")
        start = data.get("start")
        end = data.get("end")
        if not all(isinstance(v, int) for v in (turn, start, end)):
            return jsonify({"error": "turn, start and end must be integers"}), 400
        if not isinstance(store.read("bot_chats/index", {}).get(conv_id), dict):
            return jsonify({"error": "not found"}), 404

        quote_card = terminal._capture_journal(quote, quote, who=who, session=conv_id)
        if not quote_card:
            return jsonify({"error": "journal mint failed"}), 502
        # The note is a bonus, never a gate: if the annotation card fails to
        # mint, the quote is already safely in the journal and saying so beats
        # rolling back the thing that worked. `_CARD_ID_RE` guards the parent
        # link because _capture_journal falls back to a "?" sentinel when
        # stream.py mints but echoes nothing.
        note_card = None
        if note and _CARD_ID_RE.match(quote_card):
            note_card = terminal._capture_journal(
                note, note, who="B", session=conv_id, reply_to=quote_card)
        with open(_chats_dir() / f"{conv_id}.jsonl", "a", encoding="utf-8") as log:
            log.write(json.dumps({
                "type": "journal-highlight", "turn": turn, "start": start,
                "end": end, "quote": quote, "note": note,
                "card": quote_card, "ts": _now(),
            }) + "\n")
        return jsonify({"ok": True, "card": quote_card, "note_card": note_card})

    @app.route("/api/observatory/conversation/<conv_id>")
    @app.route("/api/bots/conversation/<conv_id>")
    def bot_conversation(conv_id):
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        index = store.read("bot_chats/index", {})
        meta = index.get(conv_id) if isinstance(index, dict) else None
        path = _chats_dir() / f"{conv_id}.jsonl"
        if not path.exists():
            # A freshly-minted session (a /spinoff staged draft, or "+ New
            # session") has an index entry but no jsonl until its first send —
            # that's a real, empty conversation, not a 404. Return it (draft and
            # all) so the client can load history and prefill the staged draft
            # instead of the whole open failing. Only a conv_id with no index
            # entry at all is genuinely not found.
            if isinstance(meta, dict):
                return jsonify({"id": conv_id, "meta": meta, "events": []})
            return jsonify({"error": "not found"}), 404
        # Slim view for the session page: leave out the tool results. `?lean=1`
        # drops every {type:'user'} event that isn't her own message — those
        # are claude echoing tool output back (file contents, command output,
        # screenshots), routinely 90%+ of a transcript's bytes, and the page's
        # reducer ignores them (events.ts, case 'user'). They never make a
        # turn, so turn indices — what journal highlights are addressed by —
        # come out identical. Opt-in: without the flag the full log is served,
        # and the file on disk is untouched (Terrain reads it directly).
        # Prompt: "only load the last some amount of messages ... maybe make it
        # load some amount that's easy to load."
        lean = request.args.get("lean") == "1"
        events = []
        for line in path.read_text().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue  # a torn line (crash mid-append) shouldn't hide the rest
            if (lean and isinstance(event, dict) and event.get("type") == "user"
                    and not isinstance(event.get("text"), str)):
                continue
            events.append(event)
        if not isinstance(meta, dict):
            meta = {}
        if isinstance(meta, dict) and meta.get("running"):
            # Report running-ness honestly: a re-attaching client polls this
            # to know whether to keep waiting, and a flag orphaned by a dead
            # worker must not keep it waiting forever.
            meta = dict(meta, running=_effective_running(conv_id, meta))
        # Same running total the roster card shows, so the open session can
        # print what it has spent without a second round trip.
        tokens = _session_tokens(conv_id)
        if tokens:
            meta = dict(meta, tokens=tokens)
        return jsonify({"id": conv_id, "meta": meta, "events": events})

    @app.route("/api/observatory/conversation/<conv_id>/follow")
    def bot_conv_follow(conv_id):
        """Stream a turn's events as they land, for a watcher that doesn't own it.

        `?from=<n>` is how many events the client already has — exactly the
        length of the `events` array the conversation route just gave it, so
        loading a session and then following it has no gap and no overlap.

        Ends when the turn is over, with a final `{"type": "follow_end"}` so
        the client can tell "the reply finished" from "my connection died" —
        the two look identical to an SSE reader otherwise. Also ends on a time
        limit; reconnect with the `from` this one reported.

        Deliberately knows nothing about who is running the turn. That is the
        whole point: the same endpoint serves the other gunicorn worker, a
        reconnecting phone, and a turn hosted in a different systemd service —
        which, since the turn moved out of the web worker, is now every turn.
        The reading itself lives in _stream_events, shared with the send route.
        """
        if not _CONV_ID_RE.match(conv_id or ""):
            return jsonify({"error": "bad conversation id"}), 400
        try:
            already = max(0, int(request.args.get("from", 0)))
        except (TypeError, ValueError):
            already = 0
        return Response(_stream_events(conv_id, skip_events=already)(),
                        mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache",
                                 "X-Accel-Buffering": "no"})

    @app.route("/api/observatory/conversation/<conv_id>/activity")
    def bot_conv_activity(conv_id):
        """What the agent has been doing: every step, outputs included.

        Serves the Activity pane (frontend/src/features/activity/). The
        parsing is in activityfeed.py; this route adds where to resume and
        whether the turn is still live.

        Resumes by byte offset, like the follow stream. `?from=<n>` is the
        `next` the last reply gave; each poll reads only what was appended
        since. A first read of a very long session starts near the end
        (`clipped`). `mtime` is when the transcript last grew, which is how
        the pane can say "quiet for 3 minutes" while a turn is supposedly
        running."""
        if not _CONV_ID_RE.match(conv_id or ""):
            return jsonify({"error": "invalid conversation id"}), 400
        meta = store.read("bot_chats/index", {}).get(conv_id)
        if not isinstance(meta, dict):
            return jsonify({"error": "not found"}), 404
        try:
            offset = max(0, int(request.args.get("from", 0)))
        except (TypeError, ValueError):
            offset = 0
        path = _chats_dir() / f"{conv_id}.jsonl"
        events, start, next_offset, clipped = activityfeed.read_since(
            path, offset, _ACTIVITY_WINDOW_BYTES)
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime).isoformat(
                timespec="seconds")
        except OSError:
            mtime = None
        return jsonify({
            "id": conv_id,
            "title": meta.get("title") or conv_id,
            "running": _effective_running(conv_id, meta),
            "mtime": mtime,
            # Where the read actually began. Different from the `from` the
            # client sent (a clip, or a rewritten file) means start the list
            # over rather than append.
            "start": start,
            "next": next_offset,
            "clipped": clipped,
            "events": events,
        })

    @app.route("/api/observatory/conversation/<conv_id>/activity/output")
    def bot_conv_activity_output(conv_id):
        """One tool call's output, uncut — the Activity pane's "show all"."""
        if not _CONV_ID_RE.match(conv_id or ""):
            return jsonify({"error": "invalid conversation id"}), 400
        tool_use_id = request.args.get("id", "")
        if not re.match(r"^[A-Za-z0-9_\-]{1,100}$", tool_use_id):
            return jsonify({"error": "invalid tool call id"}), 400
        text = activityfeed.full_output(_chats_dir() / f"{conv_id}.jsonl", tool_use_id)
        if text is None:
            return jsonify({"error": "not found"}), 404
        return jsonify({"id": tool_use_id, "output": text})

    @app.route("/api/observatory/conversation/<conv_id>/preview")
    def bot_conv_preview(conv_id):
        """The last thing said in a session, and nothing else — what /terrain's
        agent hovercard prints under the summary. Deliberately NOT the
        conversation route with a limit: this one never loads the whole log (see
        _conversation_last_said), because it fires on a mouse hover.

        A JOURNALING session returns empty. That's the same line the roster card
        already draws around `last_prompt`: her diary is not something the map
        should be able to quote at a passing cursor. The card still shows that
        session's title, status and summary — only the raw line is withheld."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        meta = store.read("bot_chats/index", {}).get(conv_id)
        if not isinstance(meta, dict):
            return jsonify({"error": "not found"}), 404
        empty = {"id": conv_id, "role": None, "text": "", "truncated": False}
        if meta.get("journal"):
            return jsonify(dict(empty, private=True))
        path = _chats_dir() / f"{conv_id}.jsonl"
        if not path.is_file():
            return jsonify(empty)   # minted, never sent into — a real empty
        role, text = _conversation_last_said(path)
        return jsonify({"id": conv_id, "role": role,
                        "text": text[:_PREVIEW_CHARS],
                        "truncated": len(text) > _PREVIEW_CHARS})

    @app.route("/api/observatory/conversation/<conv_id>/stop", methods=["POST"])
    @app.route("/api/bots/conversation/<conv_id>/stop", methods=["POST"])
    def bot_conv_stop(conv_id):
        """Stop a running turn ON PURPOSE — the stop button's door. This is
        the only path that kills a turn now; a vanished client never does.
        The kill lands directly when this worker owns the proc, and via the
        index's stop_requested flag when the other gunicorn worker does (its
        turn thread checks the flag per message-granular event)."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        if _kill_local_proc(conv_id):
            return jsonify({"ok": True})
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if not isinstance(entry, dict):
                return jsonify({"error": "not found"}), 404
            if entry.get("running"):
                entry["stop_requested"] = _now()
        return jsonify({"ok": True})

    # --- The mailbox, from her side (peermail.py) ---------------------------
    # What she types while a turn is running goes in the session's mailbox on
    # the server — not a queue in her browser — so it's handed to the agent
    # at its next step whether or not the page stays open, and it goes out
    # together with anything other agents sent. Prompt that produced it:
    # "change them to queue messages to the server so they can inject
    # whenever it's ready."

    @app.route("/api/observatory/conversation/<conv_id>/inbox", methods=["POST"])
    def observatory_inbox_add(conv_id):
        """Leave her a message in the mailbox. Starts a turn straight away if
        the session is idle (`started`), otherwise it waits to be handed in."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        data = request.json or {}
        try:
            row = peermail.send(conv_id, data.get("text"), kind="B",
                                record=data.get("record") is not False)
        except KeyError:
            return jsonify({"error": "not found"}), 404
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        started = drain_inbox(conv_id, fallback=True)
        return jsonify({"ok": True, "id": row["id"], "started": started})

    @app.route("/api/observatory/conversation/<conv_id>/inbox", methods=["GET"])
    def observatory_inbox_list(conv_id):
        """Her messages the agent hasn't read yet — the rows the chat shows
        above the composer. `handed` = already written into the running
        agent, which reads it when its current step ends; those can't be
        taken back, only sent now. `status` says why they're waiting
        (_inbox_status)."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        rows = sorted(peermail.waiting(conv_id, kind="B")
                      + peermail.handed(conv_id, kind="B"), key=lambda r: r["id"])
        entry = store.read("bot_chats/index", {}).get(conv_id)
        return jsonify({
            "waiting": [
                {"id": r["id"], "text": r["text"], "record": bool(r["record"]),
                 "handed": r["status"] == "delivered",
                 "rushed": r["mode"] == "interrupt"}
                for r in rows],
            "status": _inbox_status(conv_id, entry) if rows else None,
        })

    @app.route("/api/observatory/conversation/<conv_id>/inbox/<int:message_id>/now",
               methods=["POST"])
    def observatory_inbox_now(conv_id, message_id):
        """Her "send now": stop the step the agent is on and start a new turn
        with this message (and anything else waiting). The same interrupt a
        peer's `peers.py send --interrupt` uses — the running turn's companion
        sees it within a second (_deliver_midturn). 409 once the agent has
        already read it."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        if not peermail.send_now(message_id, conv_id):
            return jsonify({"error": "already delivered"}), 409
        # Idle after all (the turn ended a moment ago): nothing to interrupt,
        # so start its turn now.
        started = drain_inbox(conv_id, fallback=True)
        return jsonify({"ok": True, "started": started})

    @app.route("/api/observatory/conversation/<conv_id>/inbox/<int:message_id>",
               methods=["DELETE"])
    def observatory_inbox_cancel(conv_id, message_id):
        """Take back one of her waiting messages. 409 if it already went."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        if not peermail.cancel(message_id, conv_id):
            return jsonify({"error": "already delivered"}), 409
        return jsonify({"ok": True})

    @app.route("/api/observatory/peer/<int:message_id>/release", methods=["POST"])
    def observatory_peer_release(message_id):
        """Let a HELD agent message through. Nothing holds new messages any
        more; this is for the ones the old count brakes held."""
        row = release_peer_message(message_id)
        if row is None:
            return jsonify({"error": "not held"}), 409
        return jsonify({"ok": True, "status": "waiting"})

    @app.route("/api/observatory/conversation/<conv_id>/fork", methods=["POST"])
    def bot_conv_fork(conv_id):
        """Fork-the-work: stage a fresh take-over spinoff seeded with what this
        session is writing/creating right now. Reads the live footprint, writes
        a BRIEF, and mints a spinoff with start=False so it does NOT auto-run. A
        session with no write surface yet gets a 400 (nothing to fork). Import
        of open_spinoff is lazy: routes.spinoff imports THIS module, so a
        top-level import here would be circular."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        meta = store.read("bot_chats/index", {}).get(conv_id)
        if not isinstance(meta, dict):
            return jsonify({"error": "not found"}), 404
        surface = _fork_work_surface(conv_id, meta)
        if not surface:
            return jsonify({"error": "this session isn't writing any files yet — nothing to fork"}), 400
        slug = _fork_slug(meta.get("title") or conv_id)
        brief_path = store.SPINOFF_DIR / slug / "BRIEF.md"
        brief_path.parent.mkdir(parents=True, exist_ok=True)
        brief_path.write_text(_fork_brief_md(meta.get("title") or conv_id, surface),
                              encoding="utf-8")
        from routes.spinoff import open_spinoff
        # start=False: a fork is a TAKE-OVER, not a parallel run. Launching it
        # here would put two agents on the same session's files at once, which
        # is the exact thing forking exists to get her out of. She stops this
        # one, then opens the fork.
        #
        # The lane is passed explicitly rather than inherited: a fork is minted
        # inside a REQUEST, so the ambient sender open_spinoff would otherwise
        # read is the web worker (nobody), not the session being forked. A
        # take-over has to land in the same room as the work it takes over.
        payload, status = open_spinoff(slug, start=False, lane=_conv_lane(meta),
                                       parent=conv_id, via="fork")
        return jsonify(payload), status

    @app.route("/api/observatory/conversation/<conv_id>/approve", methods=["POST"])
    def observatory_conv_approve(conv_id):
        """Approve the command a gated session is blocked on. `sticky` (default
        false) = whitelist it for the whole session (`always`); false =
        one-shot (`once`, consumed on the retry). The server then queues the
        retry cue itself (see Follow-ups) — sent now if the session is idle,
        the moment its current turn ends if not. `resume` in the reply says
        which, and tells a current page not to send its own."""
        sticky = bool((request.json or {}).get("sticky"))
        payload, status = resolve_approval(conv_id, "approve", sticky)
        if status == 200:
            payload["resume"] = queue_followup(
                conv_id, APPROVE_CUE,
                decision={"kind": "approve", "command": payload["command"]})
        return jsonify(payload), status

    @app.route("/api/observatory/conversation/<conv_id>/deny", methods=["POST"])
    def observatory_conv_deny(conv_id):
        """Deny the pending command — clears it without whitelisting, then
        queues a 'denied' nudge the same way approve queues its retry, so the
        agent adjusts instead of dangling."""
        payload, status = resolve_approval(conv_id, "deny", False)
        if status == 200:
            payload["resume"] = queue_followup(
                conv_id, DENY_CUE,
                decision={"kind": "deny", "command": payload["command"]})
        return jsonify(payload), status

    @app.route("/api/observatory/conversation/<conv_id>/send", methods=["POST"])
    def observatory_conv_send(conv_id):
        """Session-first send: 404s if `conv_id` isn't already in the index
        (unlike the legacy per-bot route, this door never mints a fresh
        conversation — POST /api/observatory/conversations does that)."""
        data = request.json or {}
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "empty message"}), 400
        record = data.get("record") is not False   # on unless explicitly off
        # Present only on the resume send after she taps Approve/Deny on a gated
        # command — {kind, command}. Logged as a visible decision line so the
        # transcript names WHICH command she acted on (see the log-write below).
        decision = data.get("decision")
        # True only for text the UI fired on her behalf (the red card's resume
        # cue) — see _send_to_conversation.
        operator = data.get("operator") is True
        return _send_to_conversation(conv_id, text, record, decision=decision,
                                     operator=operator)

    @app.route("/api/observatory/<bot_id>/send", methods=["POST"])
    @app.route("/api/bots/<bot_id>/send", methods=["POST"])
    def bot_send(bot_id):
        """LEGACY per-bot send. With a conversation_id, this is now identical
        to observatory_conv_send (the entry's own config wins). Without
        one, it mints a fresh conversation the OLD way — the bot's cwd, no
        allowed_tools field (read-only legacy fallback) — for cached PWA
        clients that still call this door to start new sessions."""
        bot = _bot(bot_id)
        if not bot:
            return jsonify({"error": "unknown bot"}), 404
        data = request.json or {}
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "empty message"}), 400
        record = data.get("record") is not False   # on unless explicitly off
        conv_req = data.get("conversation_id")
        if conv_req is not None and not _CONV_ID_RE.match(str(conv_req)):
            return jsonify({"error": "invalid conversation id"}), 400
        decision = data.get("decision")
        operator = data.get("operator") is True
        return _send_to_conversation(conv_req, text, record, legacy_bot=bot,
                                     decision=decision, operator=operator)

    def _nightcrew_reply(conv_id, text):
        """Her reply to a finished night-crew session, routed to the one place
        it can still matter: the dev note the attempt was about.

        A night worker's Claude session is born inside a throwaway /tmp
        worktree that is removed when the attempt ends, so --resume has
        nothing to find — her first try at answering a worker's questions hit
        "No conversation found…". But answering by replying is the right
        instinct, so instead of a dead end the reply is APPENDED to the note.
        That clears the worker's night_questions and — via the crew's
        text-changed rule (scripts/nightcrew_run.already_pending) — re-queues
        the note for the next night. The chat answers with a receipt saying
        exactly what happened, streamed in the same SSE shape as a real turn
        so the composer treats it like any reply.

        Prompt that produced this: "when I went to go respond in the sessions
        open and labeled as night ... they said no conversation id found."
        """
        run = None
        for r in store.read("night_runs.json", {"runs": []}).get("runs", []):
            if isinstance(r, dict) and r.get("conv_id") == conv_id:
                run = r   # last match wins — it's the latest attempt
        if run is None or not run.get("note_id"):
            return jsonify({"error": "this night session isn't tied to a dev "
                                     "note, so a reply has nowhere to go"}), 409

        folded = False
        with store.mutate("dev_notes.json", {"tabs": {}}) as data:
            for notes in (data.get("tabs") or {}).values():
                for n in notes or []:
                    if isinstance(n, dict) and n.get("id") == run["note_id"]:
                        n["text"] = (n.get("text") or "").rstrip() + "\n\n" + text
                        n.pop("night_questions", None)
                        folded = True
                        break
                if folded:
                    break
        if not folded:
            return jsonify({"error": "the dev note this session worked on has "
                                     "been deleted, so a reply has nowhere "
                                     "to go"}), 409

        ack = (f"Folded into the dev note ({run.get('tab') or '?'} tab). "
               "That edit is the re-queue signal — the crew picks the note "
               "back up on its next run. (This worker's session ended with "
               "its worktree; replies here land on the note instead.)")
        now = _now()
        log_path = _chats_dir() / f"{conv_id}.jsonl"
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(json.dumps({"type": "user", "text": text, "ts": now,
                                  "journaled": False}) + "\n")
            # Nested stream-json shape, same as a real worker's words, so every
            # reader of this log (the chat view, the crew's own extractor)
            # parses it one way.
            log.write(json.dumps({"type": "assistant", "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": ack}]}, "ts": now}) + "\n")
        with store.mutate("bot_chats/index", {}) as index:
            e = index.get(conv_id)
            if isinstance(e, dict):
                e["last_at"] = now

        def generate():
            yield _sse({"type": "conv", "conversation_id": conv_id,
                        "bot": "keeper", "journaled": False})
            yield _sse({"type": "assistant", "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": ack}]}})
        return Response(generate(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache",
                                 "X-Accel-Buffering": "no"})

    def _send_to_conversation(conv_id_req, text, record, legacy_bot=None, decision=None,
                              operator=False):
        """Shared machinery behind both send routes above: one-turn-at-a-time
        gating, capture-first journaling, writing her line into the jsonl,
        handing the turn to its own process, and returning a watcher's stream.

        `legacy_bot` is set only by the legacy per-bot route: it supplies the
        bot id/cwd used ONLY when minting a brand-new entry the old way (no
        conv_id given, or a conv_id that doesn't exist yet). Once an entry
        exists, its own config always wins — legacy_bot never overrides it.

        `record` decides ONE thing: whether this turn goes in the journal.
        `operator` marks text she didn't type — a cue the UI fired for her —
        and is the only thing that keeps a turn out of her chat log."""
        if conv_id_req is not None and not _CONV_ID_RE.match(str(conv_id_req)):
            return jsonify({"error": "invalid conversation id"}), 400

        # Night-crew sessions never resume (their worktree ground is gone by
        # morning) — a reply to one folds into its dev note instead. Checked
        # here, before any index mutation, so both send doors get the behavior.
        if conv_id_req:
            pre = store.read("bot_chats/index", {}).get(str(conv_id_req))
            if isinstance(pre, dict) and pre.get("origin") == "nightcrew":
                return _nightcrew_reply(str(conv_id_req), text)

        # Create the conversation first if this send is what makes it (the
        # legacy per-bot door, or no id given). An existing entry's own config
        # always wins.
        _chats_dir()   # the index (and its .lock) lives inside it
        with store.mutate("bot_chats/index", {}) as index:
            if conv_id_req:
                conv_id = str(conv_id_req)
                if not isinstance(index.get(conv_id), dict):
                    if legacy_bot is None:
                        return jsonify({"error": "not found"}), 404
                    index[conv_id] = {
                        "bot": legacy_bot["id"], "started": _now(),
                        "claude_session_id": None, "title": text[:60],
                        "cost_usd": 0.0, "journal": False,
                        "cwd": legacy_bot.get("cwd")}
            else:
                conv_id = _new_conv_id(index)
                index[conv_id] = {
                    "bot": (legacy_bot or {}).get("id", "keeper"),
                    "started": _now(), "claude_session_id": None,
                    "title": text[:60], "cost_usd": 0.0, "journal": False,
                    "cwd": (legacy_bot or {}).get("cwd")}

        # Ignore a browser's resume for a decision the server already resumed.
        # Approve/Deny now queue the retry cue server-side (see the follow-ups
        # section); an older cached page still fires its own resume after the
        # tap, and letting both through would tell the agent twice. Answered
        # with an empty stream, which that page reads as success.
        if isinstance(decision, dict) and _already_resumed(conv_id, decision):
            def _noop():
                yield _sse({"type": "conv", "conversation_id": conv_id,
                            "journaled": False})
            return Response(_noop(), mimetype="text/event-stream",
                            headers={"Cache-Control": "no-cache",
                                     "X-Accel-Buffering": "no"})

        result = begin_turn(conv_id, text, record, decision=decision,
                            operator=operator)
        if not result["ok"]:
            return jsonify(result["body"]), result["status"]

        # Same view every other watcher gets — the transcript plus the delta
        # sidecar. Ending it (or dying on a client disconnect) leaves the turn
        # completely untouched; only /stop kills a turn.
        return Response(
            _stream_events(conv_id, start_offset=result["start_offset"],
                           live_from_start=True,
                           first_frame={"type": "conv",
                                        "conversation_id": conv_id,
                                        "bot": result["bot_id"],
                                        "journaled": result["journaled"]})(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache",
                     "X-Accel-Buffering": "no"})


def begin_turn(conv_id, text, record=True, decision=None, operator=False,
               system=None, fallback=True, batch=None):
    """Start one turn in an existing conversation. Callable with no web
    request, which is the point: the send route, the follow-up queue (an
    approval's retry cue, a timed reminder) and the turn process all start
    turns through here.

    Returns {"ok": True, "start_offset", "journaled", "bot_id"} once the turn
    is away, or {"ok": False, "status", "body"} with the same refusals the
    route has always given — 404 unknown, 409 busy or worktree gone, 503 low
    memory, 502 claude wouldn't start.

    `system` makes this a SYSTEM turn — text neither she nor the keeper wrote
    (a Coming up reminder). It's a dict {"display", "journal", "source",
    "item_id"}: `display` is what the chat shows, `journal` is the S card's
    body, `text` is what the model is told. A system turn never mints a B
    card, never clears her pending approval or open question, and never
    becomes the roster card's "last prompt".

    `batch` makes this a MAILBOX turn: a list of already-claimed peermail
    rows (her waiting messages and other agents'), delivered together.
    `text` is ignored — the agent gets them labelled (peermail.compose) — and
    each one is written to the transcript and journal by _deliver_lines.
    Only a batch that holds one of HER messages counts as her answering: an
    agent's message alone leaves her open question and pending approval up.

    `fallback` = if the turn process can't launch, run the turn in a thread
    here instead. Right for a web worker (it stays alive); wrong for a
    short-lived process like the turn host or a cron script, whose threads die
    with it — those pass False and leave the job queued for a retry."""
    def _refuse(status, body, last_error=None):
        """Undo running=True and say why. The error is also written onto the
        entry: a send nobody's watching (an autostarted spinoff, a queued
        follow-up, a reminder) has no HTTP response anyone reads, so without
        this the failure would be invisible on the roster."""
        with store.mutate("bot_chats/index", {}) as index:
            stale = index.get(conv_id)
            if isinstance(stale, dict):
                stale["running"] = False
                if last_error:
                    stale["last_error"] = last_error
        return {"ok": False, "status": status, "body": body}

    # A mailbox turn: what the agent reads is the labelled batch, and what
    # counts as "her ask" is her last on-the-record message in it, if any.
    hers = [r for r in (batch or []) if r["kind"] == "B"]
    if batch is not None:
        text = peermail.compose(batch)
        record = any(r["record"] for r in hers)
        ask = next((r["text"] for r in reversed(hers) if r["record"]), None)
    else:
        ask = text

    cleared_questions = []
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"ok": False, "status": 404, "body": {"error": "not found"}}

        # One turn at a time per conversation: turns now outlive their
        # HTTP connection, so a second send racing in (another device,
        # a retry) must be refused, not run concurrently against the
        # same resume id.
        if _effective_running(conv_id, entry):
            return {"ok": False, "status": 409,
                    "body": {"error": "a turn is already running in this conversation"}}
        entry["last_at"] = _now()
        entry["running"] = True
        entry.pop("stop_requested", None)
        # A new turn starts with no process record; its host writes its own.
        # One left behind by a turn that died must not be judged as this one's.
        entry.pop("turn_proc", None)
        # Talking to an archived session brings it back. The roster hides
        # archived entries, so without this a resurrected conversation
        # would run INVISIBLY — off the list while burning tokens. Sending
        # IS the un-archive; there's deliberately no separate restore
        # action to find. (Her ask: "I need a feature to open old chats" —
        # /atlas already shows archived sessions and navigates into them,
        # so the only missing half was making them live again on contact.)
        entry.pop("archived", None)
        # A staged kickoff (from /spinoff or a saved draft) is consumed
        # by the first send that fires it. `autostart` (set by /spinoff so
        # the Observatory auto-fires the kickoff on open) is cleared on the
        # same beat — once fired it must never re-fire, even if she reopens
        # the session mid-turn.
        entry.pop("draft", None)
        entry.pop("autostart", None)
        if system is None and (batch is None or hers):
            # Her words reached the session: take down what was waiting on
            # her (_her_message_arrived). A system reminder or another
            # agent's message alone isn't her answer, so it leaves them up.
            cleared_questions = _her_message_arrived(conv_id, entry)
        # A fresh attempt clears the red: whatever went wrong last time is
        # no longer the last thing this session did. If THIS turn fails too,
        # _run_turn writes the flag straight back.
        entry.pop("last_error", None)
        # Her ask, for the card to show. It stays up for the life of the
        # session now, not just while it works — so these gates are the
        # ONLY thing standing between a send and a line that sits on the
        # roster indefinitely. They were already load-bearing; they're more
        # so now.
        #
        # Three hard gates, all here rather than at the card, so there's one
        # place to get them right:
        #   - off the record never lands. It exists so a turn leaves no
        #     trace; painting it on the roster would walk straight around
        #     that.
        #   - a JOURNALING session never lands. Its prompts are the diary,
        #     and the pinned Keeper session sits at the top of the roster —
        #     "show the last prompt" would put her journal on the card.
        #   - a system reminder never lands: she didn't ask it.
        # A send that fails a gate leaves the previous value alone
        # rather than clearing it: the last real ask is still the truest
        # thing the card can say about what this session is doing.
        if record and system is None and ask and entry.get("journal") is not True:
            card_prompt = _card_prompt(ask)
            if card_prompt:
                entry["last_prompt"] = card_prompt
        resume_sid = entry.get("claude_session_id")
        # A helper's chat (a swarm's or the room's) never resumes: each turn
        # starts fresh from a rolling seed (helper_chat.py), written just
        # below, so its context can't outgrow the window however long it runs.
        helper_chat_entry = (dict(entry) if entry.get("role") in ("swarm_helper", "room_helper")
                             else None)
        if helper_chat_entry is not None:
            resume_sid = None
        # Attach the boot package when this send wakes a Keeper. Any chat
        # can be woken this way — the pinned one the 3 AM rollover makes
        # (which also attaches it, in scripts/keeper_rollover.py) or one
        # she opens and types /journalstart into — and from here on every
        # turn in it carries the package in its system prompt.
        if _is_journalstart(text):
            boot_path = attach_boot_package(conv_id)
            if boot_path:
                entry["system_prompt_file"] = boot_path
        # Journal is opt-in per session (the pinned Keeper session
        # carries journal:true) — everything else logs to its own jsonl
        # only. Conversation-only now: no bot-level factor.
        conv_journals = entry.get("journal") is True
        config = _conv_config(entry)
        config["conv_id"] = conv_id   # so the turn's env carries EXOCORTEX_CONV_ID (_spawn)
        # Keep the agent's input open for mid-turn messages (_TurnInput).
        config["stream_input"] = app_config.TURN_STREAM_INPUT
        bot_id = entry.get("bot")

    # Refuse to start another ~400MB claude process below the memory
    # floor — checked AFTER running=True is durable (so a racing second
    # send still gets the 409 above, not a duplicate spawn attempt) but
    # BEFORE the model actually runs.
    avail = _mem_available_mb()
    if avail is not None and avail < MIN_SPAWN_MB:
        msg = f"not enough memory to start claude ({avail}MB available)"
        # The refusal carries the numbers behind it, so the client can draw
        # the memory bar and offer to QUEUE this turn instead of just
        # showing a dead-end toast. Queueing goes through
        # /api/runqueue/enqueue (routes/run_queue.py); the run dispatcher
        # starts it when a slot opens. Import is local because run_queue
        # imports the dispatcher, and this module is imported by cron
        # scripts that shouldn't pull that chain in at module load.
        body = {"error": msg, "can_queue": True}
        try:
            from routes import run_queue
            body["headroom"] = run_queue.headroom()
        except Exception:
            pass   # the refusal still stands without its numbers
        return _refuse(503, body, last_error=msg)

    # A session whose GROUND has gone. Only a worktree session can hit this
    # (worktrees.py) — its cwd is a directory that can be removed, unlike
    # the two fixed checkouts. It matters because _spawn's fallback for a
    # missing cwd is to spawn with cwd=None, and `--resume` then looks for
    # the session under gunicorn's own directory, doesn't find it, and the
    # turn fails with something that reads like a model error. Said plainly
    # instead: the work isn't lost, it's on the branch.
    wt = entry.get("worktree") if isinstance(entry, dict) else None
    if wt and not os.path.isdir(wt):
        msg = ("this session's worktree is gone, so it can't be resumed — "
               f"its work is on branch {entry.get('branch') or 'agent/…'}")
        return _refuse(409, {"error": msg, "branch": entry.get("branch")},
                       last_error=msg)

    # Capture BEFORE the model runs (Slice-1 guarantee, same door the
    # terminal chat session uses). Slash commands are operator control,
    # not journal content — same rule as terminal_send().
    journaled = False
    if batch is not None:
        pass    # journaled per message, with the transcript lines below
    elif system is not None:
        # A system reminder is journaled as an S card — neither hers nor the
        # keeper's — carrying who set it. The text the model receives still
        # lands in Claude Code's transcript, so it gets the off-record
        # breadcrumb too, or the fallback capture doors would re-mint it a
        # minute later as if she'd typed it.
        if conv_journals:
            journaled = bool(terminal._capture_journal(
                system.get("journal") or text, text, who="S"))
            terminal._note_off_record(text)
    elif record and conv_journals and not text.lstrip().startswith("/"):
        # bool(), not the card id it returns: this goes into the session log
        # and the SSE conv event as a yes/no.
        journaled = bool(terminal._capture_journal(text, text))
    elif conv_journals and not text.lstrip().startswith("/"):
        # Off the record — and skipping the mint is not enough on its own.
        # The model still gets the text, so it lands in Claude Code's
        # transcript, and the two fallback capture doors (the vault's
        # UserPromptSubmit hook, the cron'd reconciler) read that transcript
        # in a journaling session and mint anything the pool is missing.
        # They can't tell "the server chose not to journal this" from "the
        # server tried and failed", so they were faithfully restoring every
        # off-the-record turn a minute later. This breadcrumb is what tells
        # them apart — see terminal._note_off_record.
        terminal._note_off_record(text)

    # The helper chat's seed: the swarm now, the chat summary and her last
    # messages. Written BEFORE this message goes in the log, so the seed's
    # messages end where this new one begins.
    if helper_chat_entry is not None:
        import helper_chat
        try:
            config["system_prompt_file"] = helper_chat.write_seed(conv_id, helper_chat_entry)
        except Exception as e:
            print(f"helper seed failed for {conv_id}: {e}", file=sys.stderr)

    log_path = _chats_dir() / f"{conv_id}.jsonl"
    if batch is not None:
        _deliver_lines(conv_id, log_path, batch, conv_journals)
        journaled = False
    with open(log_path, "a", encoding="utf-8") as log:
        if batch is not None:
            pass    # _deliver_lines wrote one line per message, just above
        elif system is not None:
            # A reminder the app sent: its own line type, so the chat can draw
            # it as a System bubble rather than as her words.
            log.write(json.dumps({"type": "reminder",
                                  "text": system.get("display") or text,
                                  "source": system.get("source"),
                                  "item_id": system.get("item_id"),
                                  "journaled": journaled,
                                  "ts": _now()}) + "\n")
        elif not record and isinstance(decision, dict) \
                and decision.get("kind") in ("approve", "deny"):
            # She tapped Approve/Deny on a gated command. The resume send
            # stays off the record (never journaled), but instead of a blank
            # "off the record" gap we log WHICH command she acted on, so the
            # transcript reads "✓ Approved: <cmd>" / "✕ Denied: <cmd>".
            # [prompt: "show the actual command ... apply to all terminals"]
            log.write(json.dumps({"type": "decision",
                                  "decision": decision["kind"],
                                  "command": str(decision.get("command") or ""),
                                  "ts": _now()}) + "\n")
        elif not record and operator:
            # Text the app said on her behalf — the red card's "Resume
            # session?" nudge. Showing it would put words in her mouth in
            # her own transcript, so this one still leaves a gap marker.
            log.write(json.dumps({"type": "off-record-gap", "ts": _now()}) + "\n")
        else:
            # Everything SHE typed lands here, on the record or off it.
            # Off the record keeps it out of the journal; it was also
            # dropping it from this log, so scrolling back through a
            # conversation showed "— off the record —" where her words had
            # been and she couldn't tell what she'd asked. `off_record`
            # rides along so the chat can dim it and so the summary
            # surfaces (roster card, gists) still skip it.
            # [prompt: "anything I say off the record shouldn't be hidden
            #  from the chat"]
            line = {"type": "user", "text": text, "ts": _now(),
                    "journaled": journaled}
            if not record:
                line["off_record"] = True
            log.write(json.dumps(line) + "\n")

    # Where her message ended. The stream starts here, so the client is
    # never handed back the line it just optimistically drew itself.
    try:
        start_offset = os.path.getsize(log_path)
    except OSError:
        start_offset = 0

    # The turn goes to its OWN PROCESS, which is what makes it survive this
    # worker (see the _spawn_host block up top for the measurements that
    # forced this). The caller's only remaining job is to watch it like
    # anybody else.
    # Tell the agent which open questions her message just cleared. What it
    # reads gets the note; the transcript and journal keep her words alone.
    agent_text = text + _reopen_note(cleared_questions)
    if not _spawn_host(config, agent_text, resume_sid, conv_id, log_path):
        if not fallback:
            return _refuse(502, {"error": "could not start the turn process"})
        # Belt-and-braces, same shape spinoff_runner.py uses: if the host
        # can't start, run the turn here rather than lose her reply. This
        # is the old behaviour exactly — including its exposure to a worker
        # exit — so a failure to launch degrades to what every turn used to
        # do, and never to nothing.
        try:
            proc, stderr_f = _spawn(config, agent_text, resume_sid,
                                    cwd_override=config.get("cwd"))
        except OSError as e:
            msg = f"could not start claude: {e}"
            return _refuse(502, {"error": msg}, last_error=msg)
        _running_procs[conv_id] = proc

        def _turn_then_follow_up():
            _run_turn(proc, stderr_f, conv_id, log_path, resume_sid,
                      live_path=_live_path(conv_id))
            after_turn(conv_id)
            drain_followups(conv_id)
            drain_inbox(conv_id)

        threading.Thread(target=_turn_then_follow_up, daemon=True).start()

    return {"ok": True, "start_offset": start_offset, "journaled": journaled,
            "bot_id": bot_id}
