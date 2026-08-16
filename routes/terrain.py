"""Terrain API — a force-directed file-tree heatmap of where work has
happened, fed by code history (coverage of everything) and bot_chats
footprints (attribution of which session touched which file). Serves the
endpoints the map and its rooms read: GET /api/observatory/terrain (the
payload), GET /api/observatory/terrain/file (one file's text for the
tap-a-node code modal), and GET /api/observatory/flow (the live stream of
code being written, for the Flow lane at /terrain/flow). See
scripts/extract_footprints.py for the footprints sidecar and the flow
harvest.

Git heat comes from the code-history tables in exo.db (codestore.py), not
from running `git log` per request. On every cache miss this module first
asks codestore.update() to catch the tables up to both repos' HEADs — cheap
when nothing is new — then reads the WHOLE history: the old 90-day window
and 60-touch-per-file cap existed to keep a per-request subprocess bearable,
and they went with it. The heat bar can now scrub all the way back.

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
import time

import codestore
import store
from routes import observatory
from scripts.extract_footprints import harvest_conversation, harvest_flow_events

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
_TERRAIN_CACHE_TTL_SEC = 300      # building the payload still reads the whole
                                  # history + sidecars; not per-tap work
_TERRAIN_LIVE_TTL_SEC = 5         # ...but a mid-turn session must read fresh:
                                  # while anything is running, the cache ages
                                  # out fast enough for a polling client
_TERRAIN_LIVE_WINDOW_SEC = 15 * 60   # how recently-active a conversation must
                                     # be for a live jsonl re-parse (the batch
                                     # sidecar may lag it)

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


def _terrain_git_touches(repo_id):
    """{repo-relative path: [unix_ts, ...]} for every living file, newest
    first, the whole history — read from the code-history tables rather than
    a `git log` subprocess. Defensive: any database hiccup yields {} — git
    heat is a nice-to-have layer, never a 500."""
    try:
        return codestore.touches(repo_id)
    except Exception:
        return {}


def _terrain_refresh_history():
    """Catch the code-history tables up to both repos before building a
    payload. codestore.update() costs one `git rev-list` per repo when
    nothing is new, so eager-on-cache-miss keeps the map at most one cache
    TTL stale without any cron in the loop. Failure is swallowed for the
    same reason as above: yesterday's heat beats a 500."""
    try:
        codestore.update(observatory._terrain_repos())
    except Exception:
        pass


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

        # The machine-churn denylist applies HERE, at serve time — the tables
        # underneath index everything, and what the map declines to draw is a
        # display decision, not a storage one.
        for relpath, epochs in _terrain_git_touches(repo["id"]).items():
            if _terrain_denylisted(relpath):
                continue
            files[relpath] = {"touches": sorted(epochs, reverse=True),
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
            # No window anymore — the payload carries the whole history. null
            # tells the client "don't assume a horizon"; terrainGraph's
            # earliest-touch scan finds the real one.
            "window_days": None,
            # What this payload was cut to, so the client's Files slider knows
            # whether it already holds every file or must refetch to grow.
            "file_cap": file_cap,
            "repos": repos_out,
            "sessions": sessions_out}


# --- the flow: code being written, as a stream of events ---------------------
#
# The map answers "where has work happened"; the flow answers "what is being
# written RIGHT NOW" — every Edit/Write an agent makes, newest first, each
# carrying the text it wrote, for the lane that sits under the map on a
# watching monitor. Same raw material as the live-touch overlay above (the
# bot_chats jsonls), but kept as EVENTS rather than tallied into files.
#
# Prompt that produced it: "another additional visual where I see what code is
# being written in real time … the vertical screen will be the terrain UI and
# code and information flows as it's happening".

_FLOW_LOOKBACK_SEC = 12 * 3600    # events (and conversations) older than this
                                  # don't feed the lane — it's a live surface,
                                  # not an archive; the map owns history
_FLOW_MAX_EVENTS = 60             # newest events kept in one payload
_FLOW_SNIPPET_LINES = 24          # written text shown per card, whole lines...
_FLOW_SNIPPET_CHARS = 2000        # ...and a byte-ish cap under that
_FLOW_CACHE_TTL_SEC = 3           # one build serves a burst of polling clients

# Per-conversation parse cache, keyed by (mtime_ns, size) of the jsonl — a
# quiet conversation costs a stat per poll, not a re-parse. Pruned to the
# recently-active set every build, so it can't grow with conversation count.
_flow_conv_cache = {}
_flow_cache = {"payload": None, "computed_at": 0.0}


def _flow_recent_ids(index, running_ids):
    """conv_ids that feed the lane: running now, or active within the
    lookback window (same shape as _terrain_live_ids, wider horizon)."""
    recent = set(running_ids)
    for cid, meta in index.items():
        if cid in recent or not isinstance(meta, dict):
            continue
        try:
            last = datetime.fromisoformat(meta.get("last_at", ""))
        except (TypeError, ValueError):
            continue
        if (datetime.now() - last).total_seconds() < _FLOW_LOOKBACK_SEC:
            recent.add(cid)
    return recent


def _flow_repo_rel(abspath):
    """(repo_id, repo-relative path) for an absolute path, or None when it
    lives outside both Terrain repos — the same mapping _build_terrain does
    for footprints, per event here."""
    for repo in observatory._terrain_repos():
        try:
            rel = os.path.relpath(abspath, repo["root"])
        except ValueError:
            continue
        if rel == os.curdir or rel.startswith(os.pardir):
            continue
        return repo["id"], rel.replace(os.sep, "/")
    return None


def _flow_trim_snippet(text):
    """(snippet, total_lines) — the head of what was written, cut on whole
    lines to lane-card size; total_lines keeps the cut honest so the card can
    say "of 118 lines"."""
    if not isinstance(text, str):
        return None, 0
    text = text.strip("\n")
    if not text.strip():
        return None, 0
    lines = text.splitlines()
    total = len(lines)
    snippet = "\n".join(lines[:_FLOW_SNIPPET_LINES])
    if len(snippet) > _FLOW_SNIPPET_CHARS:
        snippet = snippet[:_FLOW_SNIPPET_CHARS].rsplit("\n", 1)[0] or snippet[:_FLOW_SNIPPET_CHARS]
    return snippet, total


def _build_flow():
    """The flow payload: the newest write events across every recently-active
    conversation, mapped into the Terrain repos. Events on secret-named paths
    keep their place in the stream but lose their text (the same "hot is
    public, contents are not" split the map makes); machine-churn paths are
    dropped entirely, same denylist as the map."""
    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        index = {}
    gists = store.read("bot_chats/gists", {})
    if not isinstance(gists, dict):
        gists = {}
    running_ids = _terrain_running_ids(index)
    recent = _flow_recent_ids(index, running_ids)
    for stale in set(_flow_conv_cache) - recent:
        _flow_conv_cache.pop(stale, None)

    now_epoch = time.time()
    events_out = []
    for cid in recent:
        path = store.DATA_DIR / "bot_chats" / f"{cid}.jsonl"
        try:
            st = path.stat()
        except OSError:
            continue
        sig = (st.st_mtime_ns, st.st_size)
        meta = index.get(cid) if isinstance(index.get(cid), dict) else {}
        slot = _flow_conv_cache.get(cid)
        if slot is None or slot["sig"] != sig:
            try:
                slot = {"sig": sig, "events": harvest_flow_events(path, meta.get("cwd"))}
            except OSError:
                continue   # a torn/vanished log mustn't 500 the lane
            _flow_conv_cache[cid] = slot
        title = _terrain_session_title(cid, gists, index)
        for idx, ev in enumerate(slot["events"]):
            epoch = ev.get("epoch")
            # An event this parser can't place in time can't claim to be
            # recent — omitted rather than guessed.
            if epoch is None or now_epoch - epoch > _FLOW_LOOKBACK_SEC:
                continue
            mapped = _flow_repo_rel(ev["path"])
            if mapped is None:
                continue
            repo_id, relpath = mapped
            if _terrain_denylisted(relpath):
                continue
            secret = any(fnmatch(relpath, pat) for pat in _TERRAIN_READ_DENYLIST)
            snippet, total = (None, 0) if secret else _flow_trim_snippet(ev.get("snippet"))
            events_out.append({
                # Stable across polls: the log is append-only, so a parsed
                # event keeps its position — the client dedups on this.
                "id": f"{cid}:{idx}",
                "conv": cid,
                "title": title,
                "bot": meta.get("bot"),
                "running": cid in running_ids,
                "repo": repo_id,
                "path": relpath,
                "kind": "create" if ev["created"] else ("write" if ev["tool"] == "Write" else "edit"),
                "ts": ev.get("ts"),
                "epoch": epoch,
                "snippet": snippet,
                "snippet_total_lines": total,
            })
    events_out.sort(key=lambda e: e["epoch"], reverse=True)
    del events_out[_FLOW_MAX_EVENTS:]
    return {"generated_at": datetime.now().isoformat(timespec="seconds"),
            "lookback_sec": _FLOW_LOOKBACK_SEC,
            "events": events_out}


def register(app):
    @app.route("/api/observatory/terrain")
    def observatory_terrain():
        """The heatmap's data layer: git heat + session attribution, merged
        per repo/file. On a cache miss the code-history tables are first
        caught up to HEAD (codestore.update — cheap when nothing is new), so
        freshness rides the cache: _TERRAIN_CACHE_TTL_SEC normally, EXCEPT
        while a session is running: then the cache ages out at
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
        _terrain_refresh_history()
        payload = _build_terrain(file_cap)
        # Evict oldest-computed slots first — bounded memory even if something
        # walks every possible ?limit= value.
        while len(_terrain_cache) >= _TERRAIN_CACHE_SLOTS:
            oldest = min(_terrain_cache, key=lambda k: _terrain_cache[k]["computed_at"])
            _terrain_cache.pop(oldest, None)
        _terrain_cache[file_cap] = {"payload": payload, "computed_at": now}
        return jsonify(payload)

    @app.route("/api/observatory/flow")
    def observatory_flow():
        """The Flow lane's data: recent write events with the text they
        wrote, newest first (see _build_flow). Cached a few seconds — one
        build serves however many windows are watching."""
        now = time.monotonic()
        if _flow_cache["payload"] is not None and now - _flow_cache["computed_at"] < _FLOW_CACHE_TTL_SEC:
            return jsonify(_flow_cache["payload"])
        payload = _build_flow()
        _flow_cache["payload"] = payload
        _flow_cache["computed_at"] = now
        return jsonify(payload)

    @app.route("/api/observatory/terrain/growth")
    def observatory_terrain_growth():
        """The Growth room's data: per repo, per day, what happened — commits,
        lines added/removed, files born/died (codestore.growth_series). Raw
        daily deltas; the client integrates them into curves, because the date
        window decides what "so far" means. Tables are topped up first, same
        as the map's own payload, so the curve ends at HEAD."""
        _terrain_refresh_history()
        repos_out = []
        for repo in observatory._terrain_repos():
            try:
                series = codestore.growth_series(repo["id"])
            except Exception:
                series = []   # derived data — an empty curve, never a 500
            repos_out.append({"id": repo["id"], "name": repo["name"],
                              "days": series})
        return jsonify({"generated_at": datetime.now().isoformat(timespec="seconds"),
                        "repos": repos_out})

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
