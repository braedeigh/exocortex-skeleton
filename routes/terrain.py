"""Terrain API — a force-directed file-tree heatmap of where work has
happened, fed by git history (coverage of everything) and bot_chats
footprints (attribution of which session touched which file). Serves the two
endpoints the map reads: GET /api/observatory/terrain (the payload) and GET
/api/observatory/terrain/file (one file's text for the tap-a-node code
modal). See scripts/extract_footprints.py for the footprints sidecar.

Split out of routes/observatory.py on 08-03 — the heatmap had grown its own
caching, ranking and path-security model (~450 lines) inside the session
engine's module. The endpoints keep their /api/observatory/... paths: the
map lives inside the Observatory surface, and moving a URL breaks cached
clients for nothing.

Deliberately imports the observatory MODULE (not names from it) for the two
pieces the session engine still owns — _terrain_repos (the repo roots, which
fork-the-work also uses) and _effective_running (the roster's staleness
logic). Attribute access stays dynamic, so tests that monkeypatch those on
routes.observatory reach this module too. One-directional: observatory never
imports terrain.
"""
from flask import request, jsonify
from datetime import datetime
from fnmatch import fnmatch
from pathlib import Path
import os
import re
import subprocess
import time

import store
from routes import observatory
from scripts.extract_footprints import harvest_conversation

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
    for repo in observatory._terrain_repos():
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
            if isinstance(meta, dict) and observatory._effective_running(cid, meta)}


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
    for repo in observatory._terrain_repos():
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
    # Open sessions join the roster even with no footprint and nothing running:
    # the map's "Open" pool is defined by this list, so a session missing from
    # it would be silently under-reported rather than merely undrawn.
    open_ids = {cid for cid, meta in index.items()
                if isinstance(meta, dict) and not meta.get("archived")}
    session_ids = {cid for cid, conv in footprints.items()
                   if isinstance(conv, dict) and conv.get("files")} | running_ids | open_ids
    sessions_out = []
    for cid in session_ids:
        meta = index.get(cid) if isinstance(index.get(cid), dict) else {}
        sessions_out.append({"id": cid,
                             "title": _terrain_session_title(cid, gists, index),
                             "bot": meta.get("bot"),
                             "running": cid in running_ids,
                             # Open = not archived. A real, server-side state
                             # she controls, unlike the browser-local heartbeat
                             # the map used to call "active".
                             "open": cid in open_ids,
                             # Which room it lives in. Derived for entries that
                             # predate the field, so nothing needs migrating.
                             "lane": observatory._conv_lane(meta),
                             "last": meta.get("last_at")})
    sessions_out.sort(key=lambda s: s.get("last") or "", reverse=True)

    return {"generated_at": datetime.now().isoformat(timespec="seconds"),
            "window_days": _TERRAIN_WINDOW_DAYS,
            # What this payload was cut to, so the client's Files slider knows
            # whether it already holds every file or must refetch to grow.
            "file_cap": file_cap,
            "repos": repos_out,
            "sessions": sessions_out}


def register(app):
    @app.route("/api/observatory/terrain")
    def observatory_terrain():
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

    @app.route("/api/observatory/terrain/file")
    def observatory_terrain_file():
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
        repo = next((r for r in observatory._terrain_repos() if r["id"] == repo_id), None)
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
