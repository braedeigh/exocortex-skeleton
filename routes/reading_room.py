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
import fcntl
import json
import os
import queue
import re
import subprocess
import sys
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

# Per-session model choices. A conversation with NO `model` field (all of them,
# before this existed) passes no --model flag at all and so inherits the CLI's
# own default from ~/.claude/settings.json — that inherit-the-default case is
# the point, not an oversight: changing the default there keeps flowing through
# to every session she hasn't deliberately pinned. Aliases only (the CLI
# resolves them to the latest snapshot); '[1m]' asks for the 1M-context variant.
_MODEL_CHOICES = ["fable", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"]


# --- Doc-protection guard --------------------------------------------------
# Keep app-spawned builder/spinoff sessions from editing the hand-curated
# identity docs (the seed scaffold, the project CLAUDE.md, persona lore, vault
# doctrine). Terra's cut (07-26): bind the read-only to the SESSION TYPE, not to
# the files — a session spawned through the Reading Room or a /spinoff can't
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


def _protected_doc_globs():
    """Absolute path globs the guard denies writes to, resolved from store dirs
    (never hardcoded — the vault is instance-specific). Both the skeleton
    checkout (store.BUILD_DIR) and the vault root (store.CONTENT_DIR's parent —
    the same root _default_bots()/_terrain_repos() use) contribute."""
    roots = (Path(store.BUILD_DIR), Path(store.CONTENT_DIR).parent)
    globs = set()
    for root in roots:
        for d in _PROTECTED_DOC_DIRS:
            globs.add(f"{root / d}/**")
        for f in _PROTECTED_DOC_FILES:
            globs.add(str(root / f))
    return sorted(globs)


def _guard_settings_json():
    """The `--settings` payload: a `permissions.deny` rule for every
    (write-tool × protected-glob) pair. Absolute paths carry the leading `//`
    Claude Code uses for filesystem-absolute rules (matches the existing
    agents/mailclaude/clerk settings)."""
    deny = [f"{tool}(/{glob})" for glob in _protected_doc_globs()
            for tool in _GUARD_WRITE_TOOLS]
    return json.dumps({"permissions": {"deny": deny}})


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
    model = entry.get("model")
    return {
        "allowed_tools": list(tools),
        "cwd": entry.get("cwd") or str(store.CONTENT_DIR.parent),
        "system_prompt_file": entry.get("system_prompt_file"),
        # None = inherit the CLI default (see _MODEL_CHOICES).
        "model": model if model in _MODEL_CHOICES else None,
        # Doc-protection is on by default for every session; only an explicit
        # `guard_docs: false` turns it off (the deliberate "re-cut a persona
        # through the app" seam). See _guard_settings_json().
        "guard_docs": entry.get("guard_docs") is not False,
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
    if isinstance(tools, list) and tools:
        cmd += ["--allowedTools", ",".join(str(t) for t in tools)]
    # Doc-protection: a write-capable session gets the identity docs denied
    # unless it explicitly opted out (guard_docs: false). Deny wins over the
    # --allowedTools above. A read-only session carries no write tool, so it
    # gets no --settings at all. See the guard section up top.
    if config.get("guard_docs", True) and isinstance(tools, list) \
            and any(t in _GUARD_WRITE_TOOLS for t in tools):
        cmd += ["--settings", _guard_settings_json()]
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
_TERRAIN_TOUCH_CAP = 60           # newest git touches kept per file. Sized for
                                  # the client's date-range filter: it slices
                                  # these timestamps, so a file whose older
                                  # touches were trimmed would read as "not
                                  # touched" in an early window. At ~8 weeks of
                                  # history and hourly vault backups, 60 covers
                                  # the busiest files end to end.
_TERRAIN_FILE_CAP = 350           # DEFAULT hottest files kept per repo (a phone
                                  # canvas force-sim drowns past the low
                                  # hundreds). The client's Files slider
                                  # overrides it via ?limit=; session-attributed
                                  # files always survive the cap, and files_total
                                  # reports the uncapped count either way.
_TERRAIN_FILE_CAP_MAX = 5000      # ceiling on ?limit= — above the real corpus
                                  # (~3.3k files), so "All" is reachable, but
                                  # still a bound on what one request can build
_TERRAIN_CACHE_SLOTS = 6          # distinct ?limit= payloads kept warm at once
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

# One cache slot per distinct ?limit= the client asks for (the Files slider
# snaps to a handful of steps, so this stays small). Keyed by the resolved
# file cap; None means "no cap — every file". Evicts the oldest slot past
# _TERRAIN_CACHE_SLOTS so a hostile/looping caller can't grow it without bound.
_terrain_cache = {}


def _terrain_denylisted(relpath):
    return any(fnmatch(relpath, pat) for pat in _TERRAIN_DENYLIST)


def _terrain_file_cap_arg(raw):
    """Parse ?limit= into a file cap: None for "all", else a bounded int.
    Anything unparseable falls back to the default rather than erroring —
    a junk query string should still draw a map."""
    if raw is None:
        return _TERRAIN_FILE_CAP
    raw = raw.strip().lower()
    if raw in ("all", "0", "none", ""):
        return None
    try:
        value = int(raw)
    except ValueError:
        return _TERRAIN_FILE_CAP
    if value < 0:
        return _TERRAIN_FILE_CAP
    return min(value, _TERRAIN_FILE_CAP_MAX)


# Never handed out by /terrain/file, even though they live inside a repo root:
# the map may legitimately show that a credentials file changed, but "which
# file is hot" and "show me its contents" are different permissions.
_TERRAIN_READ_DENYLIST = (
    "*.env", ".env*", "*/.env*", "*.pem", "*.key", "*.p12", "*.pfx",
    "*id_rsa*", "*id_ed25519*", "*.git/*", ".git/*", "*credentials*",
    "*secret*", "*.sqlite", "*.db",
)

_TERRAIN_FILE_READ_MAX = 256 * 1024   # bytes returned to the code modal


def _terrain_safe_path(root, relpath):
    """Resolve `relpath` under `root`, or None if it escapes, doesn't exist,
    isn't a regular file, or is read-denylisted.

    Two checks, deliberately different:
      1. LEXICAL, against the requested root — '../' and friends are refused
         on spelling, before the filesystem is consulted at all.
      2. RESOLVED, against every Terrain root — symlinks are judged on where
         they LAND. This is what lets the skeleton's CLAUDE.local.md (a real
         symlink into the vault, and a file the map does show) open, while a
         symlink pointing at /etc/shadow still doesn't.
    Both repos are readable through this endpoint by design, so allowing a
    symlink to land in the sibling root grants nothing the caller couldn't
    already ask for directly — but a path that *escapes both* is refused."""
    if "\0" in relpath:
        return None
    rel = relpath.replace("\\", "/").lstrip("/")
    if any(fnmatch(rel, pat) for pat in _TERRAIN_READ_DENYLIST):
        return None
    try:
        root_resolved = Path(root).resolve()
        # (1) lexical: normalize without touching the disk, so '..' can't walk out
        lexical = os.path.normpath(os.path.join(str(root_resolved), rel))
        if lexical != str(root_resolved) and not lexical.startswith(str(root_resolved) + os.sep):
            return None
        # (2) resolved: follow symlinks, then require a landing inside a root
        candidate = Path(lexical).resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    for repo in _terrain_repos():
        try:
            allowed = Path(repo["root"]).resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        if candidate == allowed or allowed in candidate.parents:
            break
    else:
        return None
    if not candidate.is_file():
        return None
    return candidate


def _terrain_file_summary(relpath, text):
    """"What is this file" — pulled from the file's own leading docblock
    rather than generated. This codebase (and the vault's markdown) leads
    with an explanatory header almost everywhere, so the honest summary is
    already written; anything else would be a guess wearing a fact's clothes.
    Returns None when a file simply doesn't say."""
    suffix = Path(relpath).suffix.lower()
    stripped = text.lstrip()
    if suffix in (".py",):
        for quote in ('"""', "'''"):
            if stripped.startswith(quote):
                end = stripped.find(quote, len(quote))
                if end != -1:
                    return _terrain_clean_summary(stripped[len(quote):end])
        return None
    if suffix in (".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".rs", ".go", ".java", ".c", ".h"):
        if stripped.startswith("/*"):
            end = stripped.find("*/", 2)
            if end != -1:
                body = stripped[2:end]
                # Strip the leading '*' gutter JSDoc blocks are drawn with.
                lines = [re.sub(r"^\s*\* ?", "", ln) for ln in body.splitlines()]
                return _terrain_clean_summary("\n".join(lines))
        if stripped.startswith("//"):
            lines = []
            for ln in stripped.splitlines():
                if not ln.strip().startswith("//"):
                    break
                lines.append(ln.strip()[2:].strip())
            return _terrain_clean_summary("\n".join(lines))
        return None
    if suffix in (".md", ".markdown"):
        # First heading plus the prose under it, up to the next heading.
        lines = stripped.splitlines()
        out = []
        for ln in lines[:40]:
            if out and ln.startswith("#"):
                break
            out.append(ln)
        return _terrain_clean_summary("\n".join(out))
    if suffix in (".sh", ".bash", ".toml", ".ini", ".conf", ".yml", ".yaml"):
        lines = []
        for ln in stripped.splitlines():
            s = ln.strip()
            if s.startswith("#!"):
                continue
            if not s.startswith("#"):
                break
            lines.append(s.lstrip("#").strip())
        return _terrain_clean_summary("\n".join(lines))
    return None


def _terrain_clean_summary(raw, max_chars=600):
    """Collapse a docblock into flowing paragraphs, trimmed to a modal-sized
    bite (whole words, ellipsis when cut)."""
    paragraphs = []
    for block in re.split(r"\n\s*\n", raw.strip()):
        collapsed = " ".join(block.split())
        if collapsed:
            paragraphs.append(collapsed)
    summary = "\n\n".join(paragraphs).strip()
    if not summary:
        return None
    if len(summary) > max_chars:
        summary = summary[:max_chars].rsplit(" ", 1)[0].rstrip(",.;:") + "…"
    return summary


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


def _build_terrain(file_cap=_TERRAIN_FILE_CAP):
    """The terrain payload: per repo, per file, git touch history merged
    with which bot_chats sessions wrote/read it. Reads footprints.json (see
    scripts/extract_footprints.py) + gists.json/index.json defensively —
    missing sidecars degrade to empty attribution, never a 500.

    `file_cap` is the hottest-N-per-repo cut; None means no cut at all (the
    Files slider's "All"). Either way each repo reports `files_total`, the
    uncapped count, so the map can say how much it isn't showing."""
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
                              "writes": 0, "reads": 0, "creates": 0, "last": None})
                sess["writes"] += int(counts.get("writes") or 0)
                sess["reads"] += int(counts.get("reads") or 0)
                sess["creates"] += int(counts.get("creates") or 0)
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
        if file_cap is not None and files_total > file_cap:
            now_ts = time.time()

            def _cap_heat(f):
                return sum(2 ** (-(now_ts - ts) / _TERRAIN_CAP_HALF_LIFE_SEC)
                           for ts in f["touches"])

            attributed = [f for f in files_out if f["sessions"]]
            rest = sorted((f for f in files_out if not f["sessions"]),
                          key=_cap_heat, reverse=True)
            keep = attributed + rest[:max(0, file_cap - len(attributed))]
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
            "window_days": _TERRAIN_WINDOW_DAYS,
            # What this payload was cut to, so the client's Files slider knows
            # whether it already holds every file or must refetch to grow.
            "file_cap": file_cap,
            "repos": repos_out,
            "sessions": sessions_out}


def _sse(obj):
    return f"data: {json.dumps(obj)}\n\n"


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

_REQUEST_INPUT_MAX = 1000   # a question, not an essay


def request_input(conv_id, question):
    """Set `awaiting_input` (the question) on a conversation — the one validated
    entry point the agent CLI (and any future HTTP door) share, so agents never
    write session state directly. Returns (payload, status): 200 on success,
    400 on a bad id / empty question, 404 on an unknown conversation. Loud,
    precise failures — same narrow-door doctrine as open_spinoff()."""
    if not (conv_id and _CONV_ID_RE.match(str(conv_id))):
        return {"error": "invalid conversation id"}, 400
    question = (question or "").strip()[:_REQUEST_INPUT_MAX]
    if not question:
        return {"error": "empty question"}, 400
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        entry["awaiting_input"] = question
    return {"ok": True, "awaiting_input": question}, 200


# --- Fork-the-work: offload a bloated long-runner onto a fresh spinoff -------
# From a running session's Orchestra card, read what it is WRITING/creating
# right now (live, same harvest path _build_terrain's overlay uses) and stage a
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

_REQUEST_INPUT_MAX = 1000   # a question, not an essay


def request_input(conv_id, question):
    """Set `awaiting_input` (the question) on a conversation — the one validated
    entry point the agent CLI (and any future HTTP door) share, so agents never
    write session state directly. Returns (payload, status): 200 on success,
    400 on a bad id / empty question, 404 on an unknown conversation. Loud,
    precise failures — same narrow-door doctrine as open_spinoff()."""
    if not (conv_id and _CONV_ID_RE.match(str(conv_id))):
        return {"error": "invalid conversation id"}, 400
    question = (question or "").strip()[:_REQUEST_INPUT_MAX]
    if not question:
        return {"error": "empty question"}, 400
    with store.mutate("bot_chats/index", {}) as index:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            return {"error": "not found"}, 404
        entry["awaiting_input"] = question
    return {"ok": True, "awaiting_input": question}, 200


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
        # The model picker's options ride along with the roster so the server
        # stays the single authority on what the settings route will accept
        # (the client only supplies display labels).
        return jsonify({"sessions": sessions, "bots": bots,
                        "model_choices": list(_MODEL_CHOICES)})

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
        read), so a turn starting mid-TTL shortens the window immediately.

        `?limit=<n>` sets the hottest-files-per-repo cut (the client's Files
        slider); `?limit=0` or `?limit=all` means no cut. Each distinct limit
        gets its own cache slot, since they're genuinely different payloads.
        The date controls are NOT server-side: the client slices the touch
        timestamps it already has, so dragging them costs no request."""
        file_cap = _terrain_file_cap_arg(request.args.get("limit"))
        index = store.read("bot_chats/index", {})
        anything_running = isinstance(index, dict) and bool(_terrain_running_ids(index))
        ttl = _TERRAIN_LIVE_TTL_SEC if anything_running else _TERRAIN_CACHE_TTL_SEC
        now = time.monotonic()
        slot = _terrain_cache.get(file_cap)
        if slot is not None and now - slot["computed_at"] < ttl:
            return jsonify(slot["payload"])
        payload = _build_terrain(file_cap)
        # Evict oldest-computed slots first — bounded memory even if something
        # walks every possible ?limit= value.
        while len(_terrain_cache) >= _TERRAIN_CACHE_SLOTS:
            oldest = min(_terrain_cache, key=lambda k: _terrain_cache[k]["computed_at"])
            _terrain_cache.pop(oldest, None)
        _terrain_cache[file_cap] = {"payload": payload, "computed_at": now}
        return jsonify(payload)

    @app.route("/api/reading-room/terrain/file")
    def reading_room_terrain_file():
        """One file's own text, for the map's tap-a-node code modal.

        Scoped hard to the two Terrain repos: the path is resolved with
        symlinks followed (the vault keeps real ones) and must still land
        inside a repo root, so neither '../' nor a symlink pointing out of
        the tree can read anything else. Secrets are refused by name even
        inside those roots — this is an HTTP door onto the filesystem, and it
        should stay boring."""
        repo_id = (request.args.get("repo") or "").strip()
        relpath = (request.args.get("path") or "").strip()
        if not repo_id or not relpath:
            return jsonify({"error": "repo and path are required"}), 400
        repo = next((r for r in _terrain_repos() if r["id"] == repo_id), None)
        if repo is None:
            return jsonify({"error": "unknown repo"}), 404
        resolved = _terrain_safe_path(repo["root"], relpath)
        if resolved is None:
            return jsonify({"error": "not found"}), 404
        try:
            raw = resolved.read_bytes()
        except OSError:
            return jsonify({"error": "not found"}), 404
        size = len(raw)
        if b"\0" in raw[:8000]:
            return jsonify({"repo": repo_id, "path": relpath, "size": size,
                            "binary": True, "truncated": False,
                            "summary": None, "content": None, "lines": 0})
        truncated = size > _TERRAIN_FILE_READ_MAX
        try:
            text = raw[:_TERRAIN_FILE_READ_MAX].decode("utf-8", errors="replace")
        except Exception:
            return jsonify({"error": "not readable"}), 404
        if truncated:
            # Never hand back a half-line — cut at the last complete one.
            text = text[:text.rfind("\n") + 1] if "\n" in text else text
        return jsonify({"repo": repo_id, "path": relpath, "size": size,
                        "binary": False, "truncated": truncated,
                        "summary": _terrain_file_summary(relpath, text),
                        "content": text, "lines": text.count("\n") + 1})

    @app.route("/api/reading-room/keeper/rollover", methods=["POST"])
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

    @app.route("/api/reading-room/keeper/rollover/status")
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
        {title, journal, model}. `bot: "keeper"` is kept purely as a display
        field for old sidecars/terrain (`meta.get("bot")`) — it no longer
        drives cwd or tool scoping. An omitted/empty `model` writes no field
        at all, which is what makes the session follow the CLI default."""
        data = request.json or {}
        title = (data.get("title") or "").strip()[:60]
        # Journal is OPT-IN and rare: the diary is the pinned Keeper session's
        # door; every other session is a workshop unless deliberately toggled.
        journal = data.get("journal") is True
        model = (data.get("model") or "").strip()
        if model and model not in _MODEL_CHOICES:
            return jsonify({"error": f"unknown model {model!r}"}), 400
        _chats_dir()
        with store.mutate("bot_chats/index", {}) as index:
            conv_id = _new_conv_id(index)
            index[conv_id] = {"bot": "keeper", "started": _now(), "last_at": _now(),
                              "claude_session_id": None, "cost_usd": 0.0,
                              "title": title or "New session", "journal": journal,
                              "cwd": str(store.BUILD_DIR),
                              "allowed_tools": list(_BUILDER_TOOLS)}
            if model:
                index[conv_id]["model"] = model
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
        events = []
        for line in path.read_text().splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue  # a torn line (crash mid-append) shouldn't hide the rest
        if not isinstance(meta, dict):
            meta = {}
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

    @app.route("/api/reading-room/conversation/<conv_id>/fork", methods=["POST"])
    def bot_conv_fork(conv_id):
        """Fork-the-work: stage a fresh take-over spinoff seeded with what this
        session is writing/creating right now. Reads the live footprint, writes
        a BRIEF, and mints a staged spinoff (open_spinoff — never auto-run). A
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
        payload, status = open_spinoff(slug)
        return jsonify(payload), status

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
            # by the first send that fires it. `autostart` (set by /spinoff so
            # the Reading Room auto-fires the kickoff on open) is cleared on the
            # same beat — once fired it must never re-fire, even if she reopens
            # the session mid-turn.
            entry.pop("draft", None)
            entry.pop("autostart", None)
            # Her answer to a request-for-input IS this send: clear the orange
            # "awaiting_input" flag so the Orchestra card stops glowing the
            # moment she replies. (S2 request-for-input — see request_input().)
            entry.pop("awaiting_input", None)
            resume_sid = entry.get("claude_session_id")
            # Journal is opt-in per session (the pinned Keeper session
            # carries journal:true) — everything else logs to its own jsonl
            # only. Conversation-only now: no bot-level factor.
            conv_journals = entry.get("journal") is True
            config = _conv_config(entry)
            config["conv_id"] = conv_id   # so the turn's env carries EXOCORTEX_CONV_ID (_spawn)
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
            # Her answer to a request-for-input IS this send: clear the orange
            # "awaiting_input" flag so the Orchestra card stops glowing the
            # moment she replies. (S2 request-for-input — see request_input().)
            entry.pop("awaiting_input", None)
                                     f"({avail}MB available)"}), 503

        # Capture BEFORE the model runs (Slice-1 guarantee, same door the
        # terminal chat session uses). Slash commands are operator control,
        # not journal content — same rule as terminal_send().
        journaled = False
            config["conv_id"] = conv_id   # so the turn's env carries EXOCORTEX_CONV_ID (_spawn)
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
