"""Reading room API — slice S1 of docs/bot-surface-design (the "pipe").

SESSION-FIRST MODEL: each conversation (an entry in bot_chats/index.json) is
its own self-contained unit of config — it carries its own `cwd`,
`allowed_tools`, and (optionally) `system_prompt_file` directly, resolved by
`_conv_config()`. The "bot" layer that used to own this config has been
dissolved; "bots" survive only as (a) the legacy `/api/reading-room/<bot_id>/
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
- off-the-record turns (record: false) skip BOTH the journal mint and the
  chat-log append — the log gets only an explicit gap marker. The surface
  must never promise more privacy than the machinery gives (Terra, 07-23).

Headless mode authenticates exactly like interactive Claude Code (the owner's
subscription login, or an API key on a fresh install) — no separate billing.
"""
from flask import request, jsonify, Response
from datetime import datetime
from fnmatch import fnmatch
from pathlib import Path
import json
import os
import queue
import re
import subprocess
import tempfile
import threading
import time

import recap_summary
import store
from routes import terminal
from routes.kitchen.shared import _mem_available_mb, MIN_SPAWN_MB
from scripts.extract_footprints import harvest_conversation

# Overridable for tests (a stub emitting canned NDJSON) and for installs where
# claude isn't on gunicorn's PATH.
CLAUDE_BIN = os.environ.get("EXOCORTEX_CLAUDE_BIN", "claude")

_BOT_ID_RE = re.compile(r"^[a-z0-9-]{1,30}$")
_CONV_ID_RE = re.compile(r"^[A-Za-z0-9.\-]{1,60}$")

# LEGACY fallback only: the ~20 existing keeper conversations predate
# per-conversation config and have no `allowed_tools` field of their own —
# _conv_config() falls back to this (read-only) trio for them rather than
# backfilling the index. New conversations always get an explicit list.
_DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"]

# What a builder session (the Reading Room's default for new sessions, and
# what spinoff conversations get) is allowed to touch — a full dev toolkit,
# unlike the read-only legacy default above.
_BUILDER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit",
                  "Bash", "WebFetch", "WebSearch", "Task"]


# --- LEGACY: bot lookups, kept only for the legacy per-bot alias routes ------
# (cached PWA clients still hitting /api/reading-room/<bot_id>/... and
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
    return {
        "allowed_tools": list(tools),
        "cwd": entry.get("cwd") or str(store.CONTENT_DIR.parent),
        "system_prompt_file": entry.get("system_prompt_file"),
    }


def _chats_dir():
    d = store.DATA_DIR / "bot_chats"
    d.mkdir(parents=True, exist_ok=True)
    return d


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
    config (see _conv_config) — allowed_tools/cwd/system_prompt_file. The
    prompt goes in via stdin (never argv — no length limit, nothing
    shell-visible). stream-json in -p mode requires --verbose;
    --include-partial-messages is what makes the stream token-granular
    rather than message-granular."""
    cmd = [CLAUDE_BIN, "-p",
           "--output-format", "stream-json",
           "--verbose",
           "--include-partial-messages"]
    if resume_sid:
        cmd += ["--resume", resume_sid]
    tools = config.get("allowed_tools")
    if isinstance(tools, list) and tools:
        cmd += ["--allowedTools", ",".join(str(t) for t in tools)]
    prompt_file = config.get("system_prompt_file")
    if prompt_file:
        try:
            cmd += ["--append-system-prompt", Path(prompt_file).read_text()]
        except OSError:
            pass  # a broken persona ref shouldn't kill the turn; the session just runs bare
    return cmd


def _spawn(config, text, resume_sid, cwd_override=None):
    # Claude Code stores conversations PER DIRECTORY — resuming a session id
    # from a different cwd fails with "No conversation found". Every
    # conversation therefore carries the cwd it was born in (imported
    # terminal sessions keep their original one) and is always resumed there.
    cwd = cwd_override or config.get("cwd")
    if not (cwd and os.path.isdir(cwd)):
        cwd = None
    # stderr goes to a spooled temp file, NOT a pipe: nobody reads stderr
    # until the process ends, and an unread pipe blocks claude cold once it
    # writes ~64KB of warnings (verbose mode makes that a real number).
    stderr_f = tempfile.TemporaryFile()
    proc = subprocess.Popen(
        _build_cmd(config, resume_sid),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr_f,
        cwd=cwd, text=True, bufsize=1,
    )
    proc.stdin.write(text)
    proc.stdin.close()
    return proc, stderr_f


# Live turns, per worker: conv_id -> Popen. Only the explicit stop endpoint
# ever kills a turn through this — a client disconnect never touches it (the
# whole point: closing the phone's PWA must not shoot the reply mid-write).
# Cross-worker stops go through the index's stop_requested flag instead.
_running_procs = {}
_stop_requested = set()

# How stale a `running` flag can be before it's presumed dead (a worker that
# crashed mid-turn never cleared it). Only consulted when the proc isn't in
# THIS worker's registry — cross-worker we can't see it, so time decides.
_RUNNING_STALE_SEC = 600


def _effective_running(conv_id, entry):
    if not entry.get("running"):
        return False
    proc = _running_procs.get(conv_id)
    if proc is not None:
        return proc.poll() is None
    try:
        last = datetime.fromisoformat(entry.get("last_at", ""))
    except (TypeError, ValueError):
        return True
    return (datetime.now() - last).total_seconds() < _RUNNING_STALE_SEC


def _stderr_tail(stderr_f):
    try:
        stderr_f.seek(0)
        return stderr_f.read().decode("utf-8", "replace").strip()[-500:]
    except (OSError, ValueError):
        return ""


def _run_turn(proc, stderr_f, conv_id, log_path, record, resume_sid, live_q):
    """Own one turn end-to-end, detached from any HTTP connection: relay
    events to the live viewer queue, keep the jsonl log, and persist the
    resume id the moment it exists — so a turn interrupted by anything
    (closed PWA, dropped proxy, worker recycle) is still resumable and its
    finished text is still in the record."""
    session_id = resume_sid
    sid_saved = False
    cost = None
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
                if record and event.get("type") != "stream_event":
                    log.write(json.dumps(event) + "\n")
                    log.flush()   # the log is what a re-attaching client reads
                live_q.put(event)
                # A stop from the OTHER gunicorn worker lands as an index
                # flag; check it per message-granular event, never per token
                # delta (that would re-read the index thousands of times).
                if event.get("type") != "stream_event" and conv_id not in _stop_requested:
                    idx_entry = store.read("bot_chats/index", {}).get(conv_id)
                    if isinstance(idx_entry, dict) and idx_entry.get("stop_requested"):
                        _stop_requested.add(conv_id)
                        proc.kill()
            proc.wait()
            stopped = conv_id in _stop_requested
            if proc.returncode != 0 and not stopped:
                err = _stderr_tail(stderr_f)
                ev = {"type": "error",
                      "error": err or f"claude exited {proc.returncode}"}
                if record:
                    log.write(json.dumps(ev) + "\n")
                live_q.put(ev)
    finally:
        _running_procs.pop(conv_id, None)
        _stop_requested.discard(conv_id)
        try:
            stderr_f.close()
        except OSError:
            pass
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if isinstance(entry, dict):
                entry["claude_session_id"] = session_id
                entry["last_at"] = _now()
                entry["running"] = False
                entry.pop("stop_requested", None)
                if cost is not None:
                    entry["cost_usd"] = round(
                        float(entry.get("cost_usd") or 0.0) + float(cost), 6)
        live_q.put({"type": "done", "conversation_id": conv_id})
        live_q.put(None)   # viewer sentinel — the stream is over


# --- Terrain: a force-directed file-tree heatmap of where work has happened,
# fed by git history (coverage of everything) and bot_chats footprints
# (attribution of which session touched which file). See
# scripts/extract_footprints.py for the footprints sidecar this reads. ------

_TERRAIN_WINDOW_DAYS = 90
_TERRAIN_TOUCH_CAP = 20           # newest git touches kept per file
_TERRAIN_FILE_CAP = 350           # hottest files kept per repo (a phone canvas
                                  # force-sim drowns past the low hundreds);
                                  # session-attributed files always survive the
                                  # cap, and files_total reports the uncapped count
_TERRAIN_CAP_HALF_LIFE_SEC = 7 * 86400   # week half-life for the cap ranking only
_TERRAIN_CACHE_TTL_SEC = 300      # git log over two repos isn't free
_TERRAIN_LIVE_TTL_SEC = 5         # ...but a mid-turn session must read fresh:
                                  # while anything is running, the cache ages
                                  # out fast enough for a polling client
_TERRAIN_LIVE_WINDOW_SEC = 15 * 60   # how recently-active a conversation must
                                     # be for a live jsonl re-parse (the batch
                                     # sidecar may lag it)
_TERRAIN_GIT_MARKER = "\x01commit\x01"   # unlikely to collide with a real filename

# Machine-churn denylist: the vault gets hourly auto-backup commits, so
# app-state files (databases, logs, session sidecars, build output) would
# read as permanently red-hot and drown the human-meaningful signal. One
# module-level tuple, fnmatch patterns (matched against the repo-relative
# path — '*' spans '/', so these catch nested occurrences too), so it's easy
# to edit as new machine-written files show up.
_TERRAIN_DENYLIST = (
    "*.db", "*.db-wal", "*.db-shm", "*.db-journal",
    "*.log",
    "*.lock",
    "*.bak",
    "*.gen.ts",
    "data/bot_chats/*",
    "data/feature_usage.json",
    "data/recap_summaries.json",
    "data/exo.db*",
    "data/sessions.json",
    "data/runs.json",
    # App-state JSON the owner mutates through UI taps all day: real life
    # activity, but on a "where is being worked on" map it reads as noise
    # (hourly backups keep it permanently warm).
    "data/habits_log.json",
    "data/streaks.json",
    "data/activity_log.json",
    "data/bots.json",
    "data/purchase_history.json",
    "data/decisions.jsonl",
    "*uploads/*",
    "*node_modules/*",
    "*dist/*",
    "*venv/*",
    "*__pycache__/*",
)

_terrain_cache = {"payload": None, "computed_at": 0.0}


def _terrain_denylisted(relpath):
    return any(fnmatch(relpath, pat) for pat in _TERRAIN_DENYLIST)


def _terrain_repos():
    """(id, name, root) for the two repos Terrain covers. Roots follow the
    same conventions as elsewhere in this module: the skeleton's own dir
    (store.BUILD_DIR — the app code) and the vault root (store.CONTENT_DIR's
    parent, same as _default_bots()'s keeper cwd)."""
    return (
        {"id": "skeleton", "name": "App code", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "name": "Personal vault", "root": Path(store.CONTENT_DIR).parent},
    )


def _terrain_git_touches(root, window_days):
    """{repo-relative path: [unix_ts, ...]} for every file `git log` says was
    touched in the window, newest-first-uncapped (caller caps). Defensive:
    a missing git binary, a root that isn't a repo, or any subprocess hiccup
    yields {} — git heat is a nice-to-have layer, never a 500."""
    try:
        proc = subprocess.run(
            ["git", "log", f"--since={window_days}.days",
             f"--pretty=format:{_TERRAIN_GIT_MARKER}%ct", "--name-only"],
            cwd=str(root), capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if proc.returncode != 0:
        return {}
    touches = {}
    current_ts = None
    for line in proc.stdout.splitlines():
        if line.startswith(_TERRAIN_GIT_MARKER):
            try:
                current_ts = int(line[len(_TERRAIN_GIT_MARKER):])
            except ValueError:
                current_ts = None
            continue
        line = line.strip()
        if not line or current_ts is None:
            continue
        touches.setdefault(line, []).append(current_ts)
    return touches


def _terrain_session_title(conv_id, gists, index):
    gist = gists.get(conv_id) if isinstance(gists, dict) else None
    if isinstance(gist, dict) and gist.get("title"):
        return gist["title"]
    meta = index.get(conv_id) if isinstance(index, dict) else None
    if isinstance(meta, dict) and meta.get("title"):
        return meta["title"]
    return "Untitled"


def _terrain_running_ids(index):
    """conv_ids whose turn is effectively running right now (same
    _effective_running staleness logic the roster applies)."""
    return {cid for cid, meta in index.items()
            if isinstance(meta, dict) and _effective_running(cid, meta)}


def _terrain_live_ids(index, running_ids):
    """conv_ids whose jsonl deserves a live re-parse: running now, or active
    within the last ~15 minutes — either way the batch footprints sidecar
    may be behind what the log already holds."""
    live = set(running_ids)
    for cid, meta in index.items():
        if cid in live or not isinstance(meta, dict):
            continue
        try:
            last = datetime.fromisoformat(meta.get("last_at", ""))
        except (TypeError, ValueError):
            continue
        if (datetime.now() - last).total_seconds() < _TERRAIN_LIVE_WINDOW_SEC:
            live.add(cid)
    return live


def _build_terrain():
    """The terrain payload: per repo, per file, git touch history merged
    with which bot_chats sessions wrote/read it. Reads footprints.json (see
    scripts/extract_footprints.py) + gists.json/index.json defensively —
    missing sidecars degrade to empty attribution, never a 500."""
    footprints = store.read("bot_chats/footprints", {})
    if not isinstance(footprints, dict):
        footprints = {}
    gists = store.read("bot_chats/gists", {})
    if not isinstance(gists, dict):
        gists = {}
    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        index = {}

    # Live overlay: the batch sidecar goes stale the moment a turn is
    # mid-flight, so any running/just-active conversation gets its jsonl
    # re-parsed on the fly (same harvest code path as the batch script) and
    # REPLACES its batch entry — a live parse of the same log is a strict
    # superset, so replacement can't double-count. At most a couple of
    # files, so this stays cheap.
    running_ids = _terrain_running_ids(index)
    footprints = dict(footprints)
    for cid in _terrain_live_ids(index, running_ids):
        path = store.DATA_DIR / "bot_chats" / f"{cid}.jsonl"
        if not path.is_file():
            continue
        meta = index.get(cid) if isinstance(index.get(cid), dict) else {}
        try:
            live_files = harvest_conversation(
                path, meta.get("cwd"), meta.get("last_at") or meta.get("started"))
        except OSError:
            continue   # a torn/vanished log mustn't 500 the map
        if live_files:
            footprints[cid] = {"files": live_files}

    repos_out = []
    for repo in _terrain_repos():
        root = repo["root"]
        files = {}   # repo-relative path -> {"touches": [...], "sessions": {conv_id: {...}}}

        for relpath, epochs in _terrain_git_touches(root, _TERRAIN_WINDOW_DAYS).items():
            if _terrain_denylisted(relpath):
                continue
            files[relpath] = {"touches": sorted(epochs, reverse=True)[:_TERRAIN_TOUCH_CAP],
                              "sessions": {}}

        # Session attribution: map each footprint's absolute path into this
        # repo (if it's under this root) and merge — a session's touch
        # surfaces even when git never saw it in the window (uncommitted
        # work, or an install whose vault backup lags the session).
        for conv_id, conv in footprints.items():
            if not isinstance(conv, dict):
                continue
            conv_files = conv.get("files")
            if not isinstance(conv_files, dict):
                continue
            for abspath, counts in conv_files.items():
                if not isinstance(counts, dict):
                    continue
                try:
                    rel = os.path.relpath(abspath, root)
                except ValueError:
                    continue   # never happens on one filesystem; defensive
                if rel == os.curdir or rel.startswith(os.pardir):
                    continue   # not under this repo's root
                rel = rel.replace(os.sep, "/")
                if _terrain_denylisted(rel):
                    continue
                entry = files.setdefault(rel, {"touches": [], "sessions": {}})
                sess = entry["sessions"].setdefault(
                    conv_id, {"id": conv_id, "title": _terrain_session_title(conv_id, gists, index),
                              "writes": 0, "reads": 0, "last": None})
                sess["writes"] += int(counts.get("writes") or 0)
                sess["reads"] += int(counts.get("reads") or 0)
                last = counts.get("last")
                if last and (sess["last"] is None or last > sess["last"]):
                    sess["last"] = last

        files_out = []
        for relpath, data in sorted(files.items()):
            sessions = sorted(data["sessions"].values(),
                              key=lambda s: s.get("last") or "", reverse=True)
            files_out.append({"path": relpath, "touches": data["touches"], "sessions": sessions})

        # Cap to the hottest files so the client's force-sim stays tractable.
        # Session-attributed files always survive; the rest are ranked by
        # week-half-life-decayed git heat. files_total keeps the cap honest.
        files_total = len(files_out)
        if files_total > _TERRAIN_FILE_CAP:
            now_ts = time.time()

            def _cap_heat(f):
                return sum(2 ** (-(now_ts - ts) / _TERRAIN_CAP_HALF_LIFE_SEC)
                           for ts in f["touches"])

            attributed = [f for f in files_out if f["sessions"]]
            rest = sorted((f for f in files_out if not f["sessions"]),
                          key=_cap_heat, reverse=True)
            keep = attributed + rest[:max(0, _TERRAIN_FILE_CAP - len(attributed))]
            files_out = sorted(keep, key=lambda f: f["path"])

        repos_out.append({"id": repo["id"], "name": repo["name"], "root": str(root),
                          "files": files_out, "files_total": files_total})

    # Sessions as first-class map entities: every conversation with footprint
    # attribution in the payload, plus anything running right now (even if it
    # hasn't touched a file yet). Identity/status only — the per-file
    # writes/reads live in files[].sessions; the frontend inverts those.
    session_ids = {cid for cid, conv in footprints.items()
                   if isinstance(conv, dict) and conv.get("files")} | running_ids
    sessions_out = []
    for cid in session_ids:
        meta = index.get(cid) if isinstance(index.get(cid), dict) else {}
        sessions_out.append({"id": cid,
                             "title": _terrain_session_title(cid, gists, index),
                             "bot": meta.get("bot"),
                             "running": cid in running_ids,
                             "last": meta.get("last_at")})
    sessions_out.sort(key=lambda s: s.get("last") or "", reverse=True)

    return {"generated_at": datetime.now().isoformat(timespec="seconds"),
            "window_days": _TERRAIN_WINDOW_DAYS, "repos": repos_out,
            "sessions": sessions_out}


def _sse(obj):
    return f"data: {json.dumps(obj)}\n\n"


def register(app):
    # The /api/bots/* rules below are kept as aliases of the canonical
    # /api/reading-room/* paths purely for cached PWA clients (old service-
    # worker installs, bookmarked API calls) — they can be dropped once those
    # have aged out.
    @app.route("/api/reading-room")
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
        sessions = sorted(
            (dict(meta, id=cid) for cid, meta in index.items()
             if isinstance(meta, dict) and not meta.get("archived")),
            key=lambda c: c.get("last_at", ""), reverse=True)
        # Pinned sessions surface first (the Keeper session lives at the
        # top); the sort above stays stable within each group.
        sessions.sort(key=lambda c: 0 if c.get("pinned") else 1)
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
        bots = [{"id": "keeper", "name": "Keeper", "journal": True,
                 "conversations": sessions}]
        return jsonify({"sessions": sessions, "bots": bots})

    @app.route("/api/reading-room/atlas")
    def reading_room_atlas():
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
                "started": meta.get("started"),
                "last_at": meta.get("last_at"),
                "archived": bool(meta.get("archived")),
                "pinned": bool(meta.get("pinned")),
            })
        sessions.sort(key=lambda s: s.get("last_at") or s.get("started") or "",
                      reverse=True)
        return jsonify({"fronts": fronts, "domains": domains, "sessions": sessions})

    @app.route("/api/reading-room/terrain")
    def reading_room_terrain():
        """The heatmap's data layer: git heat + session attribution, merged
        per repo/file. Cached in-process for _TERRAIN_CACHE_TTL_SEC — two
        repos' worth of `git log` isn't free, and this isn't a per-tap read —
        EXCEPT while a session is running: then the cache ages out at
        _TERRAIN_LIVE_TTL_SEC so a polling client sees live touches land.
        Running-ness is checked BEFORE consulting the cache (a cheap index
        read), so a turn starting mid-TTL shortens the window immediately."""
        index = store.read("bot_chats/index", {})
        anything_running = isinstance(index, dict) and bool(_terrain_running_ids(index))
        ttl = _TERRAIN_LIVE_TTL_SEC if anything_running else _TERRAIN_CACHE_TTL_SEC
        now = time.monotonic()
        cached = _terrain_cache["payload"]
        if cached is not None and now - _terrain_cache["computed_at"] < ttl:
            return jsonify(cached)
        payload = _build_terrain()
        _terrain_cache["payload"] = payload
        _terrain_cache["computed_at"] = now
        return jsonify(payload)

    @app.route("/api/reading-room/conversation/<conv_id>/close", methods=["POST"])
    @app.route("/api/bots/conversation/<conv_id>/close", methods=["POST"])
    def bot_conv_close(conv_id):
        """Close a session: it leaves the roster, but nothing is deleted —
        the jsonl log and index entry stay (her record is the record). The
        pinned Keeper session always stays open."""
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if not isinstance(entry, dict):
                return jsonify({"error": "not found"}), 404
            if entry.get("pinned"):
                return jsonify({"error": "the pinned Keeper session stays open"}), 400
            entry["archived"] = _now()
        return jsonify({"ok": True})

    @app.route("/api/reading-room/conversations", methods=["POST"])
    def reading_room_conv_create():
        """Create a session with the session-first default config: a builder
        session rooted in the skeleton checkout, full dev toolkit. Body:
        {title, journal}. `bot: "keeper"` is kept purely as a display field
        for old sidecars/terrain (`meta.get("bot")`) — it no longer drives
        cwd or tool scoping."""
        data = request.json or {}
        title = (data.get("title") or "").strip()[:60]
        # Journal is OPT-IN and rare: the diary is the pinned Keeper session's
        # door; every other session is a workshop unless deliberately toggled.
        journal = data.get("journal") is True
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            conv_id = _new_conv_id(index)
            index[conv_id] = {"bot": "keeper", "started": _now(), "last_at": _now(),
                              "claude_session_id": None, "cost_usd": 0.0,
                              "title": title or "New session", "journal": journal,
                              "cwd": str(store.BUILD_DIR),
                              "allowed_tools": list(_BUILDER_TOOLS)}
        return jsonify({"ok": True, "id": conv_id})

    @app.route("/api/reading-room/<bot_id>/conversations", methods=["POST"])
    @app.route("/api/bots/<bot_id>/conversations", methods=["POST"])
    def bot_conv_create(bot_id):
        """LEGACY: create a session the old bot-lookup way (vault cwd, no
        allowed_tools field written — new entries read back through the
        read-only legacy fallback in _conv_config). Kept for cached PWA
        clients; new callers should use POST /api/reading-room/conversations."""
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

    @app.route("/api/reading-room/conversation/<conv_id>/settings", methods=["POST"])
    @app.route("/api/bots/conversation/<conv_id>/settings", methods=["POST"])
    def bot_conv_settings(conv_id):
        """Rename and/or flip a session's journal switch. Pinning is data-only
        for now (set at import/migration) — the pinned Keeper session stays
        the one diary door."""
        data = request.json or {}
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if not isinstance(entry, dict):
                return jsonify({"error": "not found"}), 404
            if "title" in data:
                title = (data.get("title") or "").strip()[:60]
                if not title:
                    return jsonify({"error": "empty title"}), 400
                entry["title"] = title
            if "journal" in data:
                entry["journal"] = data.get("journal") is True
            out = dict(entry, id=conv_id)
        return jsonify({"ok": True, "conversation": out})

    @app.route("/api/reading-room/conversation/<conv_id>/journal-output", methods=["POST"])
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
        if not terminal._capture_journal(text, text, who="K"):
            return jsonify({"error": "journal mint failed"}), 502
        with open(_chats_dir() / f"{conv_id}.jsonl", "a", encoding="utf-8") as log:
            log.write(json.dumps({"type": "journal-mark", "text": text,
                                  "ts": _now()}) + "\n")
        return jsonify({"ok": True})

    @app.route("/api/reading-room/conversation/<conv_id>")
    @app.route("/api/bots/conversation/<conv_id>")
    def bot_conversation(conv_id):
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        path = _chats_dir() / f"{conv_id}.jsonl"
        if not path.exists():
            return jsonify({"error": "not found"}), 404
        events = []
        for line in path.read_text().splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue  # a torn line (crash mid-append) shouldn't hide the rest
        meta = store.read("bot_chats/index", {}).get(conv_id, {})
        if isinstance(meta, dict) and meta.get("running"):
            # Report running-ness honestly: a re-attaching client polls this
            # to know whether to keep waiting, and a flag orphaned by a dead
            # worker must not keep it waiting forever.
            meta = dict(meta, running=_effective_running(conv_id, meta))
        return jsonify({"id": conv_id, "meta": meta, "events": events})

    @app.route("/api/reading-room/conversation/<conv_id>/stop", methods=["POST"])
    @app.route("/api/bots/conversation/<conv_id>/stop", methods=["POST"])
    def bot_conv_stop(conv_id):
        """Stop a running turn ON PURPOSE — the stop button's door. This is
        the only path that kills a turn now; a vanished client never does.
        The kill lands directly when this worker owns the proc, and via the
        index's stop_requested flag when the other gunicorn worker does (its
        turn thread checks the flag per message-granular event)."""
        if not _CONV_ID_RE.match(conv_id):
            return jsonify({"error": "invalid conversation id"}), 400
        proc = _running_procs.get(conv_id)
        if proc is not None and proc.poll() is None:
            _stop_requested.add(conv_id)
            proc.kill()
            return jsonify({"ok": True})
        with store.mutate("bot_chats/index", {}) as index:
            entry = index.get(conv_id)
            if not isinstance(entry, dict):
                return jsonify({"error": "not found"}), 404
            if entry.get("running"):
                entry["stop_requested"] = _now()
        return jsonify({"ok": True})

    @app.route("/api/reading-room/conversation/<conv_id>/send", methods=["POST"])
    def reading_room_conv_send(conv_id):
        """Session-first send: 404s if `conv_id` isn't already in the index
        (unlike the legacy per-bot route, this door never mints a fresh
        conversation — POST /api/reading-room/conversations does that)."""
        data = request.json or {}
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "empty message"}), 400
        record = data.get("record") is not False   # on unless explicitly off
        return _send_to_conversation(conv_id, text, record)

    @app.route("/api/reading-room/<bot_id>/send", methods=["POST"])
    @app.route("/api/bots/<bot_id>/send", methods=["POST"])
    def bot_send(bot_id):
        """LEGACY per-bot send. With a conversation_id, this is now identical
        to reading_room_conv_send (the entry's own config wins). Without
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
        return _send_to_conversation(conv_req, text, record, legacy_bot=bot)

    def _send_to_conversation(conv_id_req, text, record, legacy_bot=None):
        """Shared machinery behind both send routes above: one-turn-at-a-time
        gating, capture-first journaling, jsonl logging, the detached
        _run_turn thread, and the SSE relay.

        `legacy_bot` is set only by the legacy per-bot route: it supplies the
        bot id/cwd used ONLY when minting a brand-new entry the old way (no
        conv_id given, or a conv_id that doesn't exist yet). Once an entry
        exists, its own config always wins — legacy_bot never overrides it."""
        if conv_id_req is not None and not _CONV_ID_RE.match(str(conv_id_req)):
            return jsonify({"error": "invalid conversation id"}), 400

        # Everything request-bound happens BEFORE the generator: conv/index
        # setup, the journal mint, and the spawn — the stream only relays.
        _chats_dir()   # the index (and its .lock) lives inside it
        with store.mutate("bot_chats/index", {}) as index:
            if conv_id_req:
                conv_id = str(conv_id_req)
                entry = index.get(conv_id)
                if not isinstance(entry, dict):
                    if legacy_bot is None:
                        return jsonify({"error": "not found"}), 404
                    entry = index.setdefault(conv_id, {
                        "bot": legacy_bot["id"], "started": _now(),
                        "claude_session_id": None, "title": text[:60],
                        "cost_usd": 0.0, "journal": False,
                        "cwd": legacy_bot.get("cwd")})
            else:
                conv_id = _new_conv_id(index)
                entry = index.setdefault(conv_id, {
                    "bot": (legacy_bot or {}).get("id", "keeper"),
                    "started": _now(), "claude_session_id": None,
                    "title": text[:60], "cost_usd": 0.0, "journal": False,
                    "cwd": (legacy_bot or {}).get("cwd")})

            # One turn at a time per conversation: turns now outlive their
            # HTTP connection, so a second send racing in (another device,
            # a retry) must be refused, not run concurrently against the
            # same resume id.
            if _effective_running(conv_id, entry):
                return jsonify({"error": "a turn is already running in this conversation"}), 409
            entry["last_at"] = _now()
            entry["running"] = True
            entry.pop("stop_requested", None)
            # A staged kickoff (from /spinoff or a saved draft) is consumed
            # by the first send that fires it.
            entry.pop("draft", None)
            resume_sid = entry.get("claude_session_id")
            # Journal is opt-in per session (the pinned Keeper session
            # carries journal:true) — everything else logs to its own jsonl
            # only. Conversation-only now: no bot-level factor.
            conv_journals = entry.get("journal") is True
            config = _conv_config(entry)
            bot_id = entry.get("bot")

        # Refuse to start another ~400MB claude process below the memory
        # floor — checked AFTER running=True is durable (so a racing second
        # send still gets the 409 above, not a duplicate spawn attempt) but
        # BEFORE the model actually runs.
        avail = _mem_available_mb()
        if avail is not None and avail < MIN_SPAWN_MB:
            with store.mutate("bot_chats/index", {}) as index:
                entry = index.get(conv_id)
                if isinstance(entry, dict):
                    entry["running"] = False
            return jsonify({"error": f"not enough memory to start claude "
                                     f"({avail}MB available)"}), 503

        # Capture BEFORE the model runs (Slice-1 guarantee, same door the
        # terminal chat session uses). Slash commands are operator control,
        # not journal content — same rule as terminal_send().
        journaled = False
        if record and conv_journals and not text.lstrip().startswith("/"):
            journaled = terminal._capture_journal(text, text)

        log_path = _chats_dir() / f"{conv_id}.jsonl"
        with open(log_path, "a", encoding="utf-8") as log:
            if record:
                log.write(json.dumps({"type": "user", "text": text, "ts": _now(),
                                      "journaled": journaled}) + "\n")
            else:
                log.write(json.dumps({"type": "off-record-gap", "ts": _now()}) + "\n")

        try:
            proc, stderr_f = _spawn(config, text, resume_sid, cwd_override=config.get("cwd"))
        except OSError as e:
            with store.mutate("bot_chats/index", {}) as index:
                entry = index.get(conv_id)
                if isinstance(entry, dict):
                    entry["running"] = False
            return jsonify({"error": f"could not start claude: {e}"}), 502

        # The turn now belongs to this thread, not this request: it logs,
        # relays, and finishes whether or not anyone is watching. Closing the
        # PWA mid-reply used to kill claude (the old generator's finally);
        # now it just closes the window onto a turn that keeps writing.
        live_q = queue.Queue()
        _running_procs[conv_id] = proc
        threading.Thread(
            target=_run_turn,
            args=(proc, stderr_f, conv_id, log_path, record, resume_sid, live_q),
            daemon=True,
        ).start()

        def generate():
            # A pure viewer over the turn thread's queue. Ending (or dying —
            # GeneratorExit on client disconnect) leaves the turn untouched;
            # only /stop kills a turn now.
            yield _sse({"type": "conv", "conversation_id": conv_id,
                        "bot": bot_id, "journaled": journaled})
            while True:
                try:
                    item = live_q.get(timeout=15)
                except queue.Empty:
                    # SSE comment keepalive: nginx's default proxy_read_timeout
                    # is 60s, and a long tool stretch can be silent longer than
                    # that — the comment keeps the pipe warm without touching
                    # the event vocabulary.
                    yield ": keepalive\n\n"
                    continue
                if item is None:
                    break
                yield _sse(item)

        return Response(generate(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache",
                                 "X-Accel-Buffering": "no"})
