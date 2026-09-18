"""Terrain API — a force-directed file-tree heatmap of where work has
happened, fed by code history (coverage of everything) and bot_chats
footprints (attribution of which session touched which file). Serves the
endpoints the map and its rooms read: GET /api/observatory/terrain (the
payload), GET /api/observatory/terrain/file (one file's text for the
tap-a-node code modal), GET /api/observatory/terrain/file/edits (when each
of its lines was last edited, from git blame, for the pane's red-edits
toggle), GET /api/observatory/terrain/file/runs (when each of its functions
last ran, from runtime_sensor.py, for the pane's gold "ran" toggle), and
GET /api/observatory/flow (the live stream of
code being written, for the Flow lane at /terrain/flow). See
scripts/extract_footprints.py for the footprints sidecar and the flow
harvest.

Also the trace doors (runtime_trace.py): arm one request or a whole journey
(POST .../trace/arm), list and read captures (GET .../trace[/<id>]), and take
in the browser's half of a journey (POST .../trace/<id>/browser — taps and
fetches with the React component chain, resolved to files through the code
graph). A turn part of a trace is joined to the agent's own tool calls from
the transcript (`_agent_calls_for`), so one capture reaches from the tap to
what the agent read and edited.

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
from datetime import date, datetime, timedelta
from fnmatch import fnmatch
from pathlib import Path
import ast
import contextlib
import math
import os
import re
import sqlite3
import subprocess
import time

import codegraph
import codestore
import config
import runtime_sensor
import runtime_trace
import store
from routes import observatory
from routes.tags import _SLUG_RE as _GROWTH_TAG_SLUG_RE
from scripts.extract_footprints import (_load_events, _parse_ts, _tool_path,
                                        harvest_conversation, harvest_flow_events)

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
_TERRAIN_GRAPH_TTL_SEC = 300      # how long a parsed code graph stays warm.
                                  # The parse is ~1.5s over ~1300 files, so
                                  # this is a miss-cost, not a tap-cost.

# When the code graph was last parsed. A dict rather than a module global so a
# test can reset it the way the payload caches above are reset.
_graph_cache = {"built_at": 0.0}


def _graph_relpath(abspath, roots):
    """An absolute path from the runtime sensor to the (repo, repo-relative)
    pair the code graph is keyed by, or None if it belongs to neither repo.
    The one place the two stores' path vocabularies are reconciled."""
    for repo_id, root in roots:
        try:
            rel = os.path.relpath(abspath, root)
        except ValueError:
            continue
        if rel != os.curdir and not rel.startswith(os.pardir):
            return (repo_id, rel.replace(os.sep, "/"))
    return None

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

# --- what a VISITOR may read ---------------------------------------------------
#
# The map is public (public_config.PUBLIC_PATHS): a logged-out visitor — on the
# private site's public view or on the public-only mirror — sees every dot from
# both repos, the session orbs and their titles. The owner's call (2026-09-17):
# "i am ok with personal stuff showing on the map, just make all personal
# files unreadable to visitors, but the code can be interactive for visitors."
#
# So the lock is on file TEXT, and it lives here on the server, not in the
# page: a visitor may open a file only when it is (a) in the app-code repo,
# (b) tracked by git there — the working tree also holds logs, a local
# CLAUDE.local.md and other untracked things that are nobody's business —
# and (c) resolves inside that repo, so a symlink into the vault (which the
# owner's own read deliberately follows) stays shut for strangers. Anything
# else answers 403 with `private: true`, which the code window renders as a
# plain "private" state rather than an error.
_VISITOR_REPO = "skeleton"
_TRACKED_TTL_SEC = 60
_tracked_cache = {"at": 0.0, "root": None, "paths": frozenset()}


def _visitor():
    """True when this request is a stranger's (server.gate sets view_mode)."""
    return getattr(request, "view_mode", "authed") == "public"


def _tracked_paths(root):
    """The repo's git-tracked paths, refreshed at most once a minute. A git
    failure yields the empty set — a visitor then reads nothing, which is the
    safe way to fail."""
    now = time.monotonic()
    if (_tracked_cache["root"] == str(root)
            and now - _tracked_cache["at"] < _TRACKED_TTL_SEC):
        return _tracked_cache["paths"]
    try:
        out = subprocess.run(["git", "-C", str(root), "ls-files", "-z"],
                             capture_output=True, timeout=10, check=True).stdout
        paths = frozenset(p.decode("utf-8", "replace") for p in out.split(b"\0") if p)
    except (OSError, subprocess.SubprocessError, ValueError):
        paths = frozenset()
    _tracked_cache.update(at=now, root=str(root), paths=paths)
    return paths


def _visitor_may_read(repo, relpath, resolved):
    """Rules (a)–(c) above, for an already-resolved candidate file."""
    if repo["id"] != _VISITOR_REPO:
        return False
    try:
        root = Path(repo["root"]).resolve()
    except (OSError, RuntimeError, ValueError):
        return False
    if root not in resolved.parents:
        return False
    rel = relpath.replace("\\", "/").lstrip("/")
    return os.path.normpath(rel) in _tracked_paths(root)


def _private_file(repo_id, relpath):
    return jsonify({"error": "private", "private": True,
                    "repo": repo_id, "path": relpath}), 403


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


def _terrain_file_target(repo_id, relpath):
    """Shared front door: resolve `repo` + `path` to a readable file, or refuse.

    Both file endpoints (/terrain/file and /terrain/file/edits) come through
    here, so the traversal check and the visitor lock can never drift apart
    between the file's text and the file's edit history. Returns
    (resolved_path, None) on success, or (None, response) carrying the
    400/404/403 the caller should return as-is."""
    if not repo_id or not relpath:
        return None, (jsonify({"error": "repo and path are required"}), 400)
    repo = next((r for r in observatory._terrain_repos() if r["id"] == repo_id), None)
    if repo is None:
        return None, (jsonify({"error": "unknown repo"}), 404)
    resolved = _terrain_safe_path(repo["root"], relpath)
    if resolved is None:
        return None, (jsonify({"error": "not found"}), 404)
    # Visitor lock: a visitor gets a 403 "private" unless _visitor_may_read
    # allows the file. It runs after the path resolves, because the rule
    # judges where the file really lands; a path that doesn't resolve is
    # already a 404 above, for owner and visitor alike.
    if _visitor() and not _visitor_may_read(repo, relpath, resolved):
        return None, _private_file(repo_id, relpath)
    return resolved, None


# The longest one `git blame` may run, in seconds. Past it,
# _terrain_line_edits gives up and answers None.
_BLAME_TIMEOUT_SEC = 15


def _terrain_line_edits(resolved):
    """When each line of a file was last edited, read from `git blame`.

    Returns a list of unix seconds, one per line in file order, from
    whichever Terrain repo the file actually lives in (a symlink is judged on
    where it lands, same as the read). None when git can't say — an untracked
    file, a file outside every repo, a missing binary, a timeout — so the
    client shows nothing rather than guessing.

    A line changed on disk but not yet committed comes back from blame as
    "Not Committed Yet" stamped with the time of the call, which is honest:
    it IS the most recent edit. The pane paints it hottest.

    Prompt that produced it: "can those displays show when the most recent
    code was edited by a toggleable red color like on the terrain map"."""
    # Find the repo this file really lives in; skip any root it isn't under.
    for repo in observatory._terrain_repos():
        try:
            root = Path(repo["root"]).resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        if root == resolved or root not in resolved.parents:
            continue
        rel = resolved.relative_to(root).as_posix()
        # Ask git. Any failure — no git, a timeout, a file git doesn't
        # track — means "no answer", never a guess.
        try:
            proc = subprocess.run(
                ["git", "-C", str(root), "blame", "--line-porcelain", "--", rel],
                capture_output=True, text=True, timeout=_BLAME_TIMEOUT_SEC,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if proc.returncode != 0:
            return None
        # Pick out one timestamp per line. --line-porcelain repeats the full
        # header for every line, so there is one author-time per line, in
        # file order — no need to track the sha. A stamp that isn't a number
        # becomes 0.
        edits = []
        for line in proc.stdout.splitlines():
            if line.startswith("author-time "):
                try:
                    edits.append(int(line[12:]))
                except ValueError:
                    edits.append(0)
        return edits
    return None


def _terrain_line_runs(resolved):
    """When each line of a Python file last RAN, one function at a time.

    Returns a list of unix seconds, one per line in file order — 0 for a line
    that is in no function, or in one the sensor hasn't seen run — or None
    when there is nothing to say: not a Python file, a file that won't parse,
    or one the sensor has never seen anything in.

    The sensor (runtime_sensor.py) records function NAMES, not line numbers,
    so this reads the file as it is on disk now, finds where each `def` starts
    and ends (Python's own parser, `ast`), and gives every line inside a
    function that function's last-ran time. A line belongs to the INNERMOST
    function around it: a route handler nested inside `register(app)` is lit
    by its own runs, not by `register` having run once at startup.

    What it can't say, and the pane repeats it: it is per function, never per
    line. A function that was entered lights whole, including a branch it
    didn't take. And the stamp is the sensor's five-minute bucket, not the
    second.

    Prompt that produced it: "see which function in a file ran, not just that
    the file ran"."""
    if resolved.suffix.lower() != ".py":
        return None
    ran = runtime_sensor.functions_ran(resolved)
    if not ran:
        return None
    try:
        text = resolved.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(text)
    except (OSError, SyntaxError, ValueError, RecursionError):
        return None
    runs = [0] * (text.count("\n") + 1)

    # Walk the file outermost-first, building each function's dotted name the
    # way Python builds `co_qualname`: a class adds its name, a function adds
    # its name and then "<locals>" for anything defined inside it. Painting
    # outer before inner is what lets the inner function overwrite its own
    # lines.
    def walk(node, prefix):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = prefix + child.name
                last = ran.get(name)
                stamp = int(last) if isinstance(last, (int, float)) else 0
                end = getattr(child, "end_lineno", None) or child.lineno
                for line_number in range(child.lineno, min(end, len(runs)) + 1):
                    runs[line_number - 1] = stamp
                walk(child, name + ".<locals>.")
            elif isinstance(child, ast.ClassDef):
                walk(child, prefix + child.name + ".")
            else:
                walk(child, prefix)

    walk(tree, "")
    return runs


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


# --- the pond tile's month, read from the journal itself ---------------------
#
# The map draws the card pool as ONE body: a little square of water holding the
# last month, a bar per day (frontend: pondNodes.ts, terrainCanvas.drawPondTile).
# Those bars used to be counted from the card FILES in this payload — which is
# wrong, and visibly so, because `files` is cut to the hottest N per repo. On
# this vault that cut left 265 of 2,240 cards standing: every day drew short,
# the day-to-day ranking scrambled (the heaviest day in the month drew as a
# stub), and three days she had written on drew as bare water. A picture of the
# journal that loses two thirds of it isn't a thumbnail, it's a different shape.
#
# So the counts come from the journal instead. `cards` in exo.db is cardstore's
# one-way mirror of the pool — the same table routes/pond.py draws the real
# pond from — and one GROUP-BY-shaped read over a month is cheap enough to ride
# along with a payload that's already cached for five minutes. Sending one
# timestamp per card (rather than a count) is what keeps the tile BREATHING:
# terrainGraph runs those through the live heat lens, so each day's colour is
# its own heat on the map's clock, exactly as a real file's is.
#
# Prompt that produced it: "look at the bars on my pond UI that's a collapse of
# my journal. it's buggy. it doesn't show the full month on the small view and
# the bars aren't spaced properly."

# Keep in step with POND_TILE_DAYS in frontend/src/features/terrain/pondNodes.ts
# — the client draws whatever window this sends, so the two only have to agree
# on the story ("a month"), not on the number.
_POND_TILE_DAYS = 31


def _card_epoch(day, ts):
    """A card's "2026-08-21" + "22:32" as unix seconds, on the LOCAL clock.

    The pool stamps a card with the wall time she wrote it, and the rest of
    this payload is git's unix seconds, so the two have to be put on one clock
    before the heat lens can compare them. A card with no usable time lands at
    midday rather than at midnight — the day is what's being drawn, and
    midnight would hand it to the wrong day the moment anything rounds."""
    for clock, fmt in ((ts or "", "%Y-%m-%d %H:%M:%S"),
                       ((ts or "")[:5], "%Y-%m-%d %H:%M")):
        try:
            return int(datetime.strptime(f"{day} {clock}", fmt).timestamp())
        except ValueError:
            continue
    try:
        return int(datetime.strptime(f"{day} 12:00", "%Y-%m-%d %H:%M").timestamp())
    except ValueError:
        return 0


def _pond_days(days=_POND_TILE_DAYS, today=None):
    """The journal's last month: one DENSE row per day, oldest first, each
    carrying the times of the cards written that day.

    Dense on purpose — a day she wrote nothing comes back as an empty list
    rather than being missing, so the client can't confuse "quiet" with "not
    in the payload" and draw the month with a hole in it.

    Deleted cards are excluded, matching routes/pond.py: the pool keeps its
    tombstones so a card can never be silently lost, but a drawing of where her
    writing SITS shouldn't be drawing what she removed.

    Every failure path returns [] rather than raising. The journal mirror is an
    optional thing for this map (an install may have no vault, no exo.db, or a
    schema that predates the `cards` table), and the client falls back to
    counting card files when this is empty — worse, but never a 500."""
    end = today or date.today()
    window = [(end - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    buckets = {day: [] for day in window}

    path = store.DATA_DIR / "exo.db"
    if not path.is_file():
        return []
    conn = None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        conn.execute("PRAGMA query_only = ON")
        rows = conn.execute(
            """SELECT day, ts FROM cards
                WHERE deleted_at IS NULL AND day >= ? AND day <= ?""",
            (window[0], window[-1]),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        if conn is not None:
            with contextlib.suppress(sqlite3.Error):
                conn.close()

    for day, ts in rows:
        bucket = buckets.get(day)
        if bucket is not None:
            bucket.append(_card_epoch(day, ts))
    # Newest first inside a day, matching what the payload guarantees for a
    # real file's touches.
    return [{"day": day, "touches": sorted(buckets[day], reverse=True)} for day in window]


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

        # Run attribution — the GOLD channel. runtime_sensor.py's sidecar says
        # which Python files actually executed, as 5-minute buckets (unix
        # seconds, oldest first, at most the last 50). Mapped into this repo
        # the same way the footprints are. A file that ran surfaces even if
        # git never touched it in the window and no agent opened it. The map
        # decides the window (24h, terrainGraph.ts RUN_WINDOW_SECONDS); this
        # just carries the buckets. Python only — the sensor can't see the
        # browser, so no .tsx ever gets a `ran`.
        for abspath, entry in (runtime_sensor.snapshot().get("files") or {}).items():
            if not isinstance(entry, dict):
                continue
            try:
                rel = os.path.relpath(abspath, root)
            except ValueError:
                continue
            if rel == os.curdir or rel.startswith(os.pardir):
                continue
            rel = rel.replace(os.sep, "/")
            if _terrain_denylisted(rel):
                continue
            ran = [int(ts) for ts in (entry.get("touches") or [])
                   if isinstance(ts, (int, float))]
            if not ran:
                continue
            files.setdefault(rel, {"touches": [], "sessions": {}})["ran"] = ran

        files_out = []
        for relpath, data in sorted(files.items()):
            sessions = sorted(data["sessions"].values(),
                              key=lambda s: s.get("last") or "", reverse=True)
            files_out.append({"path": relpath, "touches": data["touches"],
                              "sessions": sessions, "ran": data.get("ran", [])})

        # Cap to the hottest files so the client's force-sim stays tractable.
        # Session-attributed files and anything that RAN in the last day always
        # survive; the rest are ranked by week-half-life-decayed git heat.
        # files_total keeps the cap honest.
        files_total = len(files_out)
        if file_cap is not None and files_total > file_cap:
            now_ts = time.time()

            def _cap_heat(f):
                return sum(2 ** (-(now_ts - ts) / _TERRAIN_CAP_HALF_LIFE_SEC)
                           for ts in f["touches"])

            def _ran_today(f):
                return any(now_ts - ts <= 86400 for ts in f["ran"])

            attributed = [f for f in files_out if f["sessions"] or _ran_today(f)]
            rest = sorted((f for f in files_out if not (f["sessions"] or _ran_today(f))),
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
            # The pond tile's month, counted in the journal rather than in
            # this payload's (capped) card files. See _pond_days.
            "pond_days": _pond_days(),
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
# Each event also carries "place" (which broad kind of file this is — journal,
# threads, research, data, docs, code — from a pure prefix map, _flow_place)
# and "fronts" (the life-domain tags for the file, unioned from the tags table
# and a live read of tag_rules.json) so the lane's chip row can filter by
# either without a second round trip.
#
# Prompt that produced it: "another additional visual where I see what code is
# being written in real time … the vertical screen will be the terrain UI and
# code and information flows as it's happening"; and later, "in flow, filter
# by what kind of file is being written — journal, threads, research, data,
# docs, code — and by front".

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

# Place: which broad kind of file a write landed in, for the lane's place
# filter. One ordered table of (repo, path-prefix, place) — FIRST MATCH WINS,
# top to bottom, so more specific vault prefixes (tulku/Threads/) are listed
# before the broader ones (tulku/research/, data/) they'd otherwise be caught
# by. A (repo, path) that matches nothing here falls to that repo's own
# default in _FLOW_PLACE_DEFAULT; a repo id this table has never heard of
# (shouldn't happen — _terrain_repos() only ever returns skeleton/vault)
# falls to "other" too.
_FLOW_PLACE_RULES = (
    ("vault", "tulku/Journal/", "journal"),
    ("vault", "tulku/tulku-diary/", "journal"),
    ("vault", "tulku/_system/data/cards/", "journal"),
    ("vault", "tulku/people/", "journal"),
    ("vault", "tulku/Health/", "journal"),
    ("vault", "tulku/Threads/", "threads"),
    ("vault", "tulku/research/", "research"),
    ("vault", "research/", "research"),
    ("vault", "data/", "data"),
    ("vault", "docs/", "docs"),
    ("skeleton", "docs/", "docs"),
)
_FLOW_PLACE_DEFAULT = {"vault": "other", "skeleton": "code"}


def _flow_place(repo, path):
    """Which broad "place" a (repo, path) write belongs to — pure and
    table-driven (_FLOW_PLACE_RULES) so it's testable without a request.
    First matching rule wins; no match falls to the repo's own default,
    an unrecognized repo to "other"."""
    for rule_repo, prefix, place in _FLOW_PLACE_RULES:
        if rule_repo == repo and path.startswith(prefix):
            return place
    return _FLOW_PLACE_DEFAULT.get(repo, "other")


# Fronts: the same life-domain vocabulary as the rest of the app
# (fronts.json / docs/tags-architecture.md), unioned from two sources per
# file so a file written since the last scripts/backfill_tags.py run still
# gets one:
#   1. the tags table — ns='front' rows the backfill (or a manual tag) wrote,
#      read in ONE batched query for every event in the payload;
#   2. tag_rules.json's prefix rules, applied live (same union-not-longest-
#      match semantics as backfill_tags.py's gather_files) — this is what
#      keeps a brand-new file's fronts correct before the next backfill runs.
# The rules file is optional and install-specific (EXOCORTEX_DATA_DIR); a
# missing or unreadable one just leaves source 2 empty, never a 500.

def _flow_read_only_conn():
    """A connection SQLite itself won't let anything write through — same
    belt-and-braces as routes/pond.py's _read_only_conn (mode=ro +
    query_only). Always used via contextlib.closing, never a bare `with
    conn:` (a transaction scope that would leak the connection/fd)."""
    conn = sqlite3.connect(
        f"file:{store.DATA_DIR / 'exo.db'}?mode=ro", uri=True, timeout=5)
    conn.execute("PRAGMA query_only = ON")
    conn.row_factory = sqlite3.Row
    return conn


def _flow_fronts_from_tags(subjects):
    """{subject: {front tag, ...}} for every subject in `subjects`, in one
    batched query (WHERE subject IN (...)) rather than one per event. Any
    database trouble — no exo.db yet, a torn file — degrades to {}: fronts
    from the tags table are a nice-to-have layer, never a 500."""
    if not subjects:
        return {}
    out = {}
    try:
        with contextlib.closing(_flow_read_only_conn()) as conn:
            subjects = list(subjects)
            placeholders = ",".join("?" for _ in subjects)
            rows = conn.execute(
                f"SELECT subject, tag FROM tags WHERE ns = 'front' "
                f"AND subject IN ({placeholders})",
                subjects,
            ).fetchall()
    except sqlite3.Error:
        return {}
    for row in rows:
        out.setdefault(row["subject"], set()).add(row["tag"])
    return out


def _flow_rule_fronts_by_repo():
    """tag_rules.json's rules grouped by repo — read fresh on every call, no
    module-level cache, so an edited rules file takes effect on the very next
    request; scoped to one _build_flow() call, which is what "per-request"
    means here since the cache above already gates how often that runs.
    Missing or malformed file -> {}, same defensive shape as
    scripts/backfill_tags.py's own read of it."""
    try:
        rules = store.read("tag_rules.json", {"rules": []}).get("rules") or []
    except Exception:
        return {}
    by_repo = {}
    for rule in rules:
        if isinstance(rule, dict):
            by_repo.setdefault(rule.get("repo"), []).append(rule)
    return by_repo


def _flow_rule_fronts(repo, path, rules_by_repo):
    """front-ns tags tag_rules.json's prefix rules produce for one file —
    union of every matching rule (not longest-match), mirroring
    scripts/backfill_tags.py's gather_files."""
    fronts = set()
    for rule in rules_by_repo.get(repo, []):
        if not path.startswith(rule.get("prefix", "")):
            continue
        for tag_obj in rule.get("tags") or []:
            if isinstance(tag_obj, dict) and tag_obj.get("ns") == "front" and tag_obj.get("tag"):
                fronts.add(tag_obj["tag"])
    return fronts


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
                # Pure prefix lookup — cheap enough to do for every candidate
                # event, unlike fronts below which need a query.
                "place": _flow_place(repo_id, relpath),
            })
    events_out.sort(key=lambda e: e["epoch"], reverse=True)
    del events_out[_FLOW_MAX_EVENTS:]

    # Fronts, batched: one tags-table query covering every event actually
    # being returned (post-trim, so a burst of history beyond the cap never
    # grows the query), unioned per-event with tag_rules.json applied live.
    subjects = {f"file:{e['repo']}/{e['path']}" for e in events_out}
    tags_by_subject = _flow_fronts_from_tags(subjects)
    rules_by_repo = _flow_rule_fronts_by_repo()
    for e in events_out:
        subject = f"file:{e['repo']}/{e['path']}"
        fronts = set(tags_by_subject.get(subject, ()))
        fronts |= _flow_rule_fronts(e["repo"], e["path"], rules_by_repo)
        e["fronts"] = sorted(fronts)

    return {"generated_at": datetime.now().isoformat(timespec="seconds"),
            "lookback_sec": _FLOW_LOOKBACK_SEC,
            "events": events_out}


# --- growth facets: highlighting a place or front in the growth curves ------
#
# The Growth room's curves are two totals (skeleton, vault); this gives her a
# way to see ONE slice of that total on its own — "how much of this is my
# journal" or "how much of this is the health front" — without losing the
# whole picture (emphasis, not a filter, same rule as the wiki-pond). Reuses
# the Flow lane's own vocabulary and machinery rather than inventing a
# parallel one: _flow_place for the seven broad places, the tags table +
# tag_rules.json union for fronts, _flow_read_only_conn for the read door.
#
# Two endpoints: /growth/facets lists the available chips with live file
# counts (what's lightable right now); /growth/facet?ns=&tag= answers one
# chip's own born/died series, across both repos combined — a lit subject
# (a front, a place) is one entity, not two per-repo halves.
#
# Prompt: "some way to highlight subjects or like places in the growth
# curves".

_GROWTH_PLACE_LABEL = {
    "journal": "Journal", "threads": "Threads", "research": "Research",
    "data": "Data", "docs": "Docs", "code": "Code", "other": "Other",
}


def _growth_front_tags_by_subject(conn):
    """{subject: {front tag, ...}} for every file:-family subject carrying an
    ns='front' row — ONE full-table query (no subject IN (...) list), because
    the growth facets need every file's fronts at once, unlike the Flow
    lane's small per-poll batch (_flow_fronts_from_tags), which parameterizes
    by subject and would blow past SQLite's bound-variable limit against the
    whole files table."""
    out = {}
    for subject, tag in conn.execute(
        "SELECT subject, tag FROM tags WHERE ns = 'front' AND subject LIKE 'file:%'"
    ):
        out.setdefault(subject, set()).add(tag)
    return out


def _trace_tree(spans):
    """The flat span list rebuilt into the call tree it came from.

    `depth` is the shadow-stack depth at the moment the hop was recorded, so
    the tree is reconstructible without storing parent ids: walk in order,
    keeping the last span seen at each depth, and a span's parent is the last
    one strictly shallower than it. Anything at depth 0 — or orphaned because
    its parent fell off a truncated trace — becomes a root rather than being
    dropped."""
    roots, by_depth = [], {}
    for span in spans:
        node = {**span, "children": []}
        parent = None
        for d in range(node["depth"] - 1, -1, -1):
            if d in by_depth:
                parent = by_depth[d]
                break
        (parent["children"] if parent else roots).append(node)
        by_depth[node["depth"]] = node
        # Nothing deeper than this span can be its sibling's child, so the
        # deeper entries are stale the moment we descend past them.
        for d in [d for d in by_depth if d > node["depth"]]:
            del by_depth[d]
    return roots


def _graph_refresh():
    """Keep the code-graph tables warm, on the same lazy-TTL shape the map's
    own payload uses: parse on a cache miss, serve from the tables otherwise.

    The whole parse is ~1300 files in about 1.5s, which is too slow for a tap
    and fine for a five-minute miss — the same trade `_terrain_refresh_history`
    already makes for git. A failure here degrades to whatever the tables
    already hold (an empty graph on a cold install), never to a 500."""
    now_ts = time.time()
    if now_ts - _graph_cache["built_at"] < _TERRAIN_GRAPH_TTL_SEC:
        return
    try:
        # The repos come from observatory._terrain_repos(), NOT from
        # codegraph's own default. Every other endpoint in this module resolves
        # its roots that way, and a graph built over a different pair of roots
        # than the map beside it would disagree with that map about which files
        # exist — the two are meant to be read together.
        codegraph.rebuild(observatory._terrain_repos())
        _graph_cache["built_at"] = now_ts
    except Exception:
        _graph_cache["built_at"] = now_ts - _TERRAIN_GRAPH_TTL_SEC / 2   # retry sooner


_JOURNEY_GRACE_SEC = 30


def _valid_int(raw, default, upper):
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(n, upper))


def _component_resolver():
    """name -> (repo, path) for a React component, via the code graph: the
    file some other file imports that name FROM, restricted to ts/tsx so a
    Python symbol of the same name can't win. Built once per request and
    memoised inside. A name found in two different files is ambiguous and
    resolves to None — the browser part then says `browser` rather than
    picking one."""
    by_name = {}
    try:
        edges = codegraph.graph(internal_only=True)["edges"]
    except Exception:
        return lambda name: None
    for e in edges:
        if not e["dst"].endswith((".tsx", ".ts", ".jsx", ".js")):
            continue
        for sym in e.get("symbols") or ():
            hit = (e["dst_repo"], e["dst"])
            prev = by_name.get(sym)
            if prev is None:
                by_name[sym] = hit
            elif prev != hit:
                by_name[sym] = False        # ambiguous
    # A route component is imported by nobody (the router plugin wires it), so
    # fall back to a file whose basename IS the component name, if unique.
    try:
        files = codegraph.graph(internal_only=True)["files"]
    except Exception:
        files = []
    by_base = {}
    for f in files:
        base = f["path"].rsplit("/", 1)[-1].rsplit(".", 1)[0]
        if f["path"].endswith((".tsx", ".ts")):
            by_base[base] = False if base in by_base else (f["repo"], f["path"])

    def resolve(name):
        hit = by_name.get(name)
        if hit is None:
            hit = by_base.get(name)
        return hit or None
    return resolve


def _agent_calls_for(part):
    """The agent's tool calls inside one turn part, from the conversation's
    transcript: [{seq, name, path, ts, t0_us}]. `entry` is "turn <conv_id>",
    and the window is the part's start plus its duration.

    Read-only, and honest about its edges: a transcript line carries the
    agent's own clock, which is not the part's perf_counter, so `t0_us` here
    is the wall-clock offset from the part's `started_at` — close enough to
    place a beat on a timeline, and labelled as an estimate by being the only
    field named that way."""
    entry = str(part.get("entry") or "")
    if not entry.startswith("turn "):
        return []
    conv_id = entry[5:].strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", conv_id):
        return []
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    try:
        t_start = datetime.fromisoformat(part["started_at"]).timestamp()
    except (ValueError, TypeError, KeyError):
        return []
    t_end = t_start + (part.get("duration_us") or 0) / 1e6 + 1.0
    try:
        events = _load_events(path)
    except OSError:
        return []
    roots = [(r["id"], str(Path(r["root"]).resolve())) for r in observatory._terrain_repos()]

    def _where(p):
        for rid, root in roots:
            if p.startswith(root + "/"):
                return rid, p[len(root) + 1:]
        return None, None

    out = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        ts = _parse_ts(ev.get("ts") or ev.get("timestamp"))
        if ts is None or ts < t_start - 1.0 or ts > t_end:
            continue
        msg = ev.get("message")
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "tool_use":
                continue
            name = str(item.get("name") or "")
            inp = item.get("input") if isinstance(item.get("input"), dict) else {}
            tpath = _tool_path(name, inp)
            if not tpath and name == "Bash":
                tpath = str(inp.get("command") or "")[:120]
            repo, rel = _where(str(tpath or ""))
            out.append({"seq": len(out), "name": name,
                        "path": str(tpath or "")[:300], "repo": repo, "rel": rel,
                        "ts": ts, "t0_us": int(max(0.0, ts - t_start) * 1e6)})
    return out


def _trace_window(trace):
    """(t_start, t_end) epoch seconds covering the root and every part —
    a journey root's duration is its window, but a one-shot trace's turn
    part can run long past the request that spawned it."""
    try:
        t0 = datetime.fromisoformat(trace["started_at"]).timestamp()
    except (ValueError, TypeError, KeyError):
        return None
    t1 = t0 + (trace.get("duration_us") or 0) / 1e6
    for part in trace.get("parts", ()):
        try:
            p0 = datetime.fromisoformat(part["started_at"]).timestamp()
        except (ValueError, TypeError, KeyError):
            continue
        t1 = max(t1, p0 + (part.get("duration_us") or 0) / 1e6)
    return t0, t1


def _writes_in_window(trace, limit=500):
    """Write-journal events (writelog.py) whose timestamp falls inside the
    trace's window, oldest first, without their patches (the creek's own
    Writes section shows those per collection). Imported lazily and
    fail-open, same as routes/creek.py — no writelog, no events."""
    window = _trace_window(trace)
    if window is None:
        return []
    t0, t1 = window
    try:
        import writelog
        events = writelog.recent(limit=limit)
    except Exception:
        return []
    out = []
    for ev in events:
        ts = _parse_ts(ev.get("ts"))
        # Same host clock on both sides, but the journal stamps to the
        # SECOND while the trace starts on the millisecond — so the window
        # opens at the start of the trace's second, and closes a little
        # after its end for a write that lands as the request tears down.
        if ts is None or ts < math.floor(t0) or ts > t1 + 0.25:
            continue
        out.append({"ts": ev["ts"], "caller": ev.get("caller"),
                    "collection": ev.get("collection"), "verb": ev.get("verb"),
                    "t0_us": int(max(0.0, ts - t0) * 1e6)})
    out.reverse()
    return out


def register(app):
    @app.route("/api/observatory/terrain/trace/arm", methods=["POST"])
    def observatory_trace_arm():
        """Arm the tracer: the NEXT request through the app is followed all the
        way, in order, and saved. Returns the id it will carry so the caller can
        go looking for it without polling a list.

        One at a time, deliberately. Tracing is the expensive mode (no
        de-instrumentation, every function in the process), so this is a
        deliberate act with a deliberate scope, not a setting to leave on."""
        body = request.get_json(silent=True) or {}
        label = str(body.get("label") or "")
        # `journey: true` opens a WINDOW rather than taking one shot: the
        # browser carries the returned id on every request until `until`, and
        # posts its own clicks and fetches to .../trace/<id>/browser. See the
        # journey section of runtime_trace.py.
        if body.get("journey"):
            rec = runtime_trace.arm_journey(label=label, seconds=body.get("seconds"))
            return jsonify({"armed": True, "journey": rec, "id": rec["id"]})
        trace_id = runtime_trace.arm(label=label)
        return jsonify({"armed": True, "id": trace_id})

    @app.route("/api/observatory/terrain/trace/arm", methods=["DELETE"])
    def observatory_trace_disarm():
        """Clear the one-shot arm, and close a journey — the one named in the
        body's `id`, or the newest when there's none."""
        body = request.get_json(silent=True) or {}
        ended = runtime_trace.end_journey(body.get("id") or None)
        return jsonify({"armed": False, "cleared": runtime_trace.disarm() or ended})

    @app.route("/api/observatory/terrain/trace/<trace_id>/close", methods=["POST"])
    def observatory_trace_close(trace_id):
        """Close one journey. A POST rather than the DELETE above because the
        browser closes its journey from `pagehide`/hidden with sendBeacon,
        which can only POST."""
        return jsonify({"closed": runtime_trace.end_journey(trace_id)})

    @app.route("/api/observatory/terrain/trace")
    def observatory_trace_list():
        """The captured traces, newest first (`?limit=`, up to 1000), plus
        whether anything is live — a one-shot arm in `armed`, the newest open
        journey in `journey`, and every open one in `journeys`."""
        limit = _valid_int(request.args.get("limit"), 200, 1000)
        runtime_trace.prune_empty()
        opened = runtime_trace.open_journeys()
        return jsonify({"traces": runtime_trace.recent(limit=limit),
                        "armed": runtime_trace.armed(),
                        "journey": opened[0] if opened else None,
                        "journeys": opened,
                        "keep": runtime_trace.KEEP_TRACES,
                        "keep_days": runtime_trace.KEEP_DAYS})

    @app.route("/api/observatory/terrain/trace/<trace_id>/browser", methods=["POST"])
    def observatory_trace_browser(trace_id):
        """The browser's half of a journey: {events: [{kind, components,
        path, label, t0_ms, t1_ms}]}. Accepted only for the OPEN journey (or
        within a grace period after it closed, so the last flush lands) — a
        stale id is refused rather than grafted onto an old record.

        Component names are resolved to files through the code graph: a
        `.tsx`/`.ts` file that some sibling imports under that exact name.
        Ambiguous or unknown names stay unresolved, labelled `browser`, rather
        than being guessed at."""
        body = request.get_json(silent=True) or {}
        events = body.get("events")
        if not isinstance(events, list):
            return jsonify({"error": "events must be a list"}), 400
        rec = runtime_trace.open_journey(trace_id)
        head = runtime_trace.read_trace(trace_id)
        if head is None or head.get("kind") != "journey":
            return jsonify({"error": "no such journey"}), 404
        if rec is None:
            # Closed. Allow the trailing flush for a short while after.
            try:
                closed_at = datetime.fromisoformat(head["started_at"]).timestamp() \
                    + head["duration_us"] / 1e6
            except (ValueError, TypeError, KeyError):
                closed_at = 0
            if time.time() - closed_at > _JOURNEY_GRACE_SEC:
                return jsonify({"error": "journey is closed"}), 409
        _graph_refresh()
        resolver = _component_resolver()
        n = runtime_trace.save_browser_part(
            trace_id, events, started_at=head["started_at"], resolve=resolver)
        return jsonify({"ok": True, "span_count": n})

    @app.route("/api/observatory/terrain/trace/<trace_id>")
    def observatory_trace_get(trace_id):
        """One trace: the ordered hops, as a flat list AND as a tree.

        Both shapes ship because they answer different questions and building
        the tree twice on two clients is how they drift. Flat is the waterfall
        ("what happened, in what order, for how long"); nested is the call tree
        ("what did this hop turn into").

        Each span also carries `static`: whether codegraph.py knows about this
        edge. A hop with `static: false` is a real call the import graph cannot
        explain — dynamic dispatch, or a gap in the parser — and those are worth
        seeing rather than smoothing over."""
        trace = runtime_trace.read_trace(trace_id)
        if trace is None:
            return jsonify({"error": "no such trace"}), 404
        _graph_refresh()
        known = {((e["repo"], e["src"]), (e["dst_repo"], e["dst"]))
                 for e in codegraph.graph(internal_only=False)["edges"]}
        # The parent and each continuation are annotated and shaped the same
        # way — a caller shouldn't need to know which process a part came from
        # to render it.
        for part in (trace, *trace.get("parts", [])):
            for span in part["spans"]:
                span["static"] = span["src"] is not None and (
                    ((span["src_repo"], span["src"]),
                     (span["dst_repo"], span["dst"])) in known)
            part["tree"] = _trace_tree(part["spans"])
            # A turn part is the agent's process, and the tracer only sees the
            # Python around it. What the agent itself did — every Read, Edit,
            # Bash — is in the conversation transcript, so it's joined here by
            # time: tool calls stamped inside this part's window.
            if part.get("kind") == "turn":
                part["agent_calls"] = _agent_calls_for(part)
        # What the journey did to the DATA: every store write the journal saw
        # inside this trace's window, whoever made it. This is the creek's
        # half of a journey — the hops say which code ran, this says which
        # collections actually changed while it ran.
        trace["writes"] = _writes_in_window(trace)
        return jsonify(trace)

    @app.route("/api/observatory/terrain/graph")
    def observatory_terrain_graph():
        """THE WIRING: every code file in both repos, and every dependency
        between them — with the runtime sensor's observed calls laid over the
        top.

        Two layers, deliberately distinguishable in the payload rather than
        merged into one number, because they mean different things and one of
        them is complete while the other is not:

          - `edges[].symbols` — the static import graph (codegraph.py). Complete
            for both languages. Says A CAN reach B, and which names it pulled
            across.
          - `edges[].observed` — the runtime sensor saw this exact call happen,
            with `windows` for how many five-minute buckets it happened in.
            Evidence, not coverage: no `observed` flag does NOT mean the call
            never happens (see runtime_sensor's own note on framework-mediated
            calls, which leave no edge at all).

        `?external=1` includes edges to third-party packages, which are most of
        the edge count and none of the app's own flow, so they are off by
        default. `?repo=` narrows to one repo's files."""
        _graph_refresh()
        data = codegraph.graph(internal_only=request.args.get("external") != "1")
        repo_filter = request.args.get("repo")
        files = data["files"]
        edges = data["edges"]
        if repo_filter:
            files = [f for f in files if f["repo"] == repo_filter]
            edges = [e for e in edges if e["repo"] == repo_filter]

        # The overlay. The sensor keys by ABSOLUTE path (footprints' convention)
        # and the graph by repo-relative, so this is where the two vocabularies
        # are reconciled — once, here, rather than in every consumer.
        roots = [(r["id"], str(r["root"])) for r in observatory._terrain_repos()]
        observed = {}
        for src, dst, entry in runtime_sensor.observed_edges():
            src_rel, dst_rel = _graph_relpath(src, roots), _graph_relpath(dst, roots)
            if src_rel and dst_rel:
                observed[(src_rel, dst_rel)] = entry
        for edge in edges:
            hit = observed.get(((edge["repo"], edge["src"]),
                                (edge["dst_repo"], edge["dst"])))
            if hit:
                edge["observed"] = {"last": hit.get("last"),
                                    "windows": hit.get("windows") or 0}

        # Calls the sensor saw that the static graph does NOT explain. These are
        # worth surfacing rather than dropping: each one is either a dynamic
        # reach the parser can't see, or a gap in the parser — and both are
        # things she should be able to find.
        static_keys = {((e["repo"], e["src"]), (e["dst_repo"], e["dst"]))
                       for e in data["edges"]}
        unexplained = [
            {"src_repo": s[0], "src": s[1], "dst_repo": d[0], "dst": d[1],
             "windows": entry.get("windows") or 0, "last": entry.get("last")}
            for (s, d), entry in observed.items() if (s, d) not in static_keys]

        return jsonify({
            "files": files,
            "edges": edges,
            "observed_only": sorted(unexplained,
                                    key=lambda e: (e["src_repo"], e["src"], e["dst"])),
            "counts": {"files": len(files), "edges": len(edges),
                       "observed": sum(1 for e in edges if e.get("observed")),
                       "observed_only": len(unexplained)},
            "watching": runtime_sensor.running(),
        })

    @app.route("/api/observatory/terrain/graph/file")
    def observatory_terrain_graph_file():
        """One file's immediate flow, both directions — "show me everything
        that touches this". `?repo=&path=`."""
        repo = request.args.get("repo") or ""
        path = (request.args.get("path") or "").strip().lstrip("/")
        if not repo or not path:
            return jsonify({"error": "repo and path are required"}), 400
        _graph_refresh()
        return jsonify({"repo": repo, "path": path, **codegraph.neighbors(repo, path)})

    @app.route("/api/observatory/terrain/runtime")
    def observatory_terrain_runtime():
        """What the app has actually RUN — runtime_sensor.py's sidecar, mapped
        out of absolute paths into the same per-repo, repo-relative shape every
        other terrain endpoint speaks.

        A THIRD channel, beside git history and agent footprints, and it is the
        only one of the three that answers "was this code used". Files are
        sorted most-recently-run first; `age` is seconds since, so a reader
        doesn't have to know what clock the timestamps are on. `sampled` is the
        sensor's window length — the honest resolution of every timestamp here,
        and the reason two files can share one.

        Python only, and the payload says so rather than leaving a caller to
        infer it from the absence of .tsx files: the browser half of any click
        runs where this sensor cannot see."""
        snap = runtime_sensor.snapshot()
        files = snap.get("files")
        if not isinstance(files, dict):
            files = {}
        now_ts = time.time()
        repos_out = []
        for repo in observatory._terrain_repos():
            root = str(repo["root"])
            out = []
            for abspath, entry in files.items():
                if not isinstance(entry, dict):
                    continue
                try:
                    rel = os.path.relpath(abspath, root)
                except ValueError:
                    continue
                if rel == os.curdir or rel.startswith(os.pardir):
                    continue        # not under this repo — same test the payload uses
                rel = rel.replace(os.sep, "/")
                if _terrain_denylisted(rel):
                    continue
                last = entry.get("last")
                if not isinstance(last, (int, float)):
                    continue
                touches = entry.get("touches")
                out.append({"path": rel, "last": last,
                            "age": max(0, int(now_ts - last)),
                            "windows": int(entry.get("windows") or 0),
                            "touches": touches if isinstance(touches, list) else []})
            out.sort(key=lambda f: (-f["last"], f["path"]))
            repos_out.append({"id": repo["id"], "name": repo["name"],
                              "files": out, "files_total": len(out)})
        return jsonify({"repos": repos_out,
                        "sampled": runtime_sensor.CYCLE_SEC,
                        "watching": runtime_sensor.running(),
                        "language": "python",
                        "updated": snap.get("updated")})

    @app.route("/api/observatory/terrain/growth/facets")
    def observatory_terrain_growth_facets():
        """The chip row's contents: every place and front with at least one
        LIVING file (deleted_at IS NULL) right now, sorted hottest-first.
        Places come from _flow_place applied to every living (repo, path);
        fronts from one tags-table query (_growth_front_tags_by_subject)
        unioned with tag_rules.json's live prefix rules
        (_flow_rule_fronts_by_repo/_flow_rule_fronts) — the same union the
        Flow lane applies per-event, just batched over the whole table
        instead of one poll's events. Any database trouble degrades to an
        empty chip row, never a 500 — the room still draws without it."""
        _terrain_refresh_history()
        place_counts = {}
        front_counts = {}
        try:
            with contextlib.closing(_flow_read_only_conn()) as conn:
                tags_by_subject = _growth_front_tags_by_subject(conn)
                rules_by_repo = _flow_rule_fronts_by_repo()
                for repo, path in conn.execute(
                    "SELECT repo, path FROM files WHERE deleted_at IS NULL"
                ):
                    place = _flow_place(repo, path)
                    place_counts[place] = place_counts.get(place, 0) + 1
                    subject = f"file:{repo}/{path}"
                    fronts = set(tags_by_subject.get(subject, ()))
                    fronts |= _flow_rule_fronts(repo, path, rules_by_repo)
                    for front in fronts:
                        front_counts[front] = front_counts.get(front, 0) + 1
        except sqlite3.Error:
            place_counts, front_counts = {}, {}

        places_out = sorted(
            ({"id": p, "label": _GROWTH_PLACE_LABEL.get(p, p), "files": c}
             for p, c in place_counts.items() if c > 0),
            key=lambda x: (-x["files"], x["id"]),
        )
        fronts_out = sorted(
            ({"tag": t, "files": c} for t, c in front_counts.items() if c > 0),
            key=lambda x: (-x["files"], x["tag"]),
        )
        return jsonify({"places": places_out, "fronts": fronts_out})

    @app.route("/api/observatory/terrain/growth/facet")
    def observatory_terrain_growth_facet():
        """One lit chip's own born/died series, date-ascending, across BOTH
        repos combined (a lit front or place is one entity, not a skeleton
        half and a vault half). `ns` must be 'place' or 'front'; `tag` must
        survive the same slug rule routes/tags.py enforces on a real tag —
        either failure is a 400, not a guess. Matching membership mirrors
        facets above: _flow_place for a place, the tags-table union
        tag_rules.json fallback for a front — but over EVERY file (living or
        dead), since a died file's death still belongs in the curve. One
        query for the file rows plus (for ns='front') one for the tags table
        — two passes at most, Python does the classification."""
        ns = (request.args.get("ns") or "").strip().lower()
        tag = (request.args.get("tag") or "").strip().lower()
        if ns not in ("place", "front"):
            return jsonify({"error": "unknown ns"}), 400
        if not _GROWTH_TAG_SLUG_RE.match(tag):
            return jsonify({"error": "bad tag"}), 400

        _terrain_refresh_history()
        days = {}

        def _day(d):
            return days.setdefault(d, {"date": d, "born": 0, "died": 0})

        try:
            with contextlib.closing(_flow_read_only_conn()) as conn:
                tags_by_subject = (
                    _growth_front_tags_by_subject(conn) if ns == "front" else {})
                rules_by_repo = _flow_rule_fronts_by_repo() if ns == "front" else {}
                for repo, path, born, died in conn.execute(
                    "SELECT repo, path, date(first_seen), date(deleted_at) FROM files"
                ):
                    if ns == "place":
                        match = _flow_place(repo, path) == tag
                    else:
                        subject = f"file:{repo}/{path}"
                        fronts = set(tags_by_subject.get(subject, ()))
                        fronts |= _flow_rule_fronts(repo, path, rules_by_repo)
                        match = tag in fronts
                    if not match:
                        continue
                    if born:
                        _day(born)["born"] += 1
                    if died:
                        _day(died)["died"] += 1
        except sqlite3.Error:
            days = {}

        return jsonify({"ns": ns, "tag": tag, "days": [days[d] for d in sorted(days)]})

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
        wrote, newest first (see _build_flow), each carrying "place" and
        "fronts" so the lane's chip row can filter client-side — no
        server-side filter params, since the whole small window is already
        being sent. Cached a few seconds — one build serves however many
        windows are watching.

        Prompt: "in flow, filter by what kind of file is being written —
        journal, threads, research, data, docs, code — and by front"."""
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
        as the map's own payload, so the curve ends at HEAD.

        Beside this: /growth/facets and /growth/facet, the chip row's data —
        highlight subjects or places in the growth curves — light a chip and
        see that subset's own curve and its share of the velocity bars."""
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

        Comes in through the shared front door (`_terrain_file_target`), so
        reads are scoped hard to the two Terrain repos: neither '../' nor a
        symlink pointing out of the tree can read anything else. Secrets are
        refused by name even inside those roots, and the visitor lock
        applies. This is an HTTP door onto the filesystem, and it should stay
        boring."""
        repo_id = (request.args.get("repo") or "").strip()
        relpath = (request.args.get("path") or "").strip()
        # Shared front door: a readable file, or the refusal to send back as-is.
        resolved, refusal = _terrain_file_target(repo_id, relpath)
        if refusal is not None:
            return refusal
        try:
            raw = resolved.read_bytes()
        except OSError:
            return jsonify({"error": "not found"}), 404
        size = len(raw)
        # Binary check: a zero byte in the first 8000 bytes means this isn't
        # text. Answer its size and `binary: true`, with no content.
        if b"\0" in raw[:8000]:
            return jsonify({"repo": repo_id, "path": relpath, "size": size,
                            "binary": True, "truncated": False,
                            "summary": None, "content": None, "lines": 0})
        # Size cap: send at most _TERRAIN_FILE_READ_MAX bytes and mark the
        # answer `truncated`. The cut text ends at its last complete line, so
        # no half-line goes out — unless it has no line break at all.
        truncated = size > _TERRAIN_FILE_READ_MAX
        try:
            text = raw[:_TERRAIN_FILE_READ_MAX].decode("utf-8", errors="replace")
        except Exception:
            return jsonify({"error": "not readable"}), 404
        if truncated:
            text = text[:text.rfind("\n") + 1] if "\n" in text else text
        return jsonify({"repo": repo_id, "path": relpath, "size": size,
                        "binary": False, "truncated": truncated,
                        "summary": _terrain_file_summary(relpath, text),
                        "content": text, "lines": text.count("\n") + 1})

    @app.route("/api/observatory/terrain/file/edits")
    def observatory_terrain_file_edits():
        """Per-line last-edit times of one file, for the pane's "edits" toggle.

        Comes in through the shared front door (`_terrain_file_target`), so
        it has the same resolution, same traversal refusal and same visitor
        lock as /terrain/file. This is the red channel of the map, brought
        down to the line, fetched only when that toggle is on. `edits` is one
        unix-second stamp per line in file order, or null when git can't say
        (an untracked file, for one — see `_terrain_line_edits`)."""
        repo_id = (request.args.get("repo") or "").strip()
        relpath = (request.args.get("path") or "").strip()
        # Shared front door: a readable file, or the refusal to send back as-is.
        resolved, refusal = _terrain_file_target(repo_id, relpath)
        if refusal is not None:
            return refusal
        return jsonify({"repo": repo_id, "path": relpath,
                        "edits": _terrain_line_edits(resolved)})

    @app.route("/api/observatory/terrain/file/runs")
    def observatory_terrain_file_runs():
        """Per-line last-ran times of one file, for the pane's "ran" toggle.

        Comes in through the shared front door (`_terrain_file_target`), so
        it has the same resolution, same traversal refusal and same visitor
        lock as /terrain/file. This is the gold channel of the map, brought
        down to the function, fetched only when that toggle is on. `runs` is
        one unix-second stamp per line in file order (0 = not seen running),
        or null when the sensor can't say (anything that isn't Python, for
        one — see `_terrain_line_runs`). `sampled` is the sensor's bucket:
        the honest resolution of every stamp here."""
        repo_id = (request.args.get("repo") or "").strip()
        relpath = (request.args.get("path") or "").strip()
        # Shared front door: a readable file, or the refusal to send back as-is.
        resolved, refusal = _terrain_file_target(repo_id, relpath)
        if refusal is not None:
            return refusal
        return jsonify({"repo": repo_id, "path": relpath,
                        "runs": _terrain_line_runs(resolved),
                        "sampled": runtime_sensor.BUCKET_SEC})
