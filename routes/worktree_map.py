"""worktree_map.py — which agents are working in which copy of the code.

Plain English: this app has several checkouts at once — the main one gunicorn
serves, the private vault, and a `git worktree` per unattended session
(worktrees.py), plus whatever copies a session makes by hand. Sessions also
wander: one born in the main checkout can `cd` into another copy and do all its
work there. Nothing recorded "who is in which tree", so this page works it out
from what they actually DID — every tool call is already in the `tool_calls`
table — and matches the paths each call touched against `git worktree list`.

    GET /api/worktree-map?window=<seconds>

returns one entry per worktree (both repos), each with its git facts (branch,
how far ahead of/behind the main branch, how many uncommitted files) and the
sessions that touched it inside the window. A touch is one of three kinds,
the same three the Terrain map draws:

    edited — Edit / Write / MultiEdit / NotebookEdit on a file in the tree
             (Terrain's EMBER);
    ran    — a Bash command that names the tree, or runs from inside it
             (Terrain's GOLD);
    looked — Read / Grep / Glob (drawn faint; passing through isn't working).

It's evidence, not a claim: a session that `cd`s by a relative path from a
directory outside every tree (the Personal room starts one level above both
repos) isn't caught — only absolute paths and the session's own starting
folder are matched.

Touches: worktrees.py (the main checkout), sqlstore.py (tool_calls), the
bot_chats index (each session's title, room and starting folder),
frontend/src/features/observatory/WorktreeMapPage.tsx (the page) and
WorktreeMapDoor.tsx (the roster door), tests/test_worktree_map.py.

Prompt that produced it: "i want to be able to see which agents are working
in which tree in a visual UI" — "in the observatory … i'll want to click into
it and be able to identify agents and click into them to see how they're
working … reference the terrain UI for colors and signals and make it
analogous."
"""
import json
import re
import subprocess
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from flask import jsonify, request

import sqlstore
import store
import worktrees

# The window the page asks about, clamped: a minute to a week.
_DEFAULT_WINDOW = 3600
_MIN_WINDOW = 60
_MAX_WINDOW = 7 * 86400

# How much per-agent detail comes back: the most-edited files, and the latest
# calls in this tree (the "how is it working" feed on the page).
_FILES_SHOWN = 12
_RECENT_SHOWN = 12

# Tool name → kind of touch. Anything not listed (Agent, Skill, WebFetch,
# SendMessage…) says nothing about a tree and is skipped.
_KIND = {
    "Edit": "edited", "Write": "edited", "MultiEdit": "edited", "NotebookEdit": "edited",
    "Bash": "ran",
    "Read": "looked", "Grep": "looked", "Glob": "looked",
}
_PATH_KEYS = ("file_path", "notebook_path", "path", "pattern")


# --- the trees ------------------------------------------------------------

def _git(cwd, *args, timeout=20):
    try:
        r = subprocess.run(["git", "-C", str(cwd), *args],
                           capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def _repo_roots():
    """The main checkout of every repo this install runs from: the app code,
    and whatever repo holds the data and the content (the vault). Found by
    asking git, never by name, so a differently laid-out install still works."""
    roots = [Path(worktrees.SKELETON)]
    for folder in (store.DATA_DIR, store.CONTENT_DIR):
        common = _git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir")
        if common and common.strip():
            roots.append(Path(common.strip()).parent)
    seen, out = set(), []
    for root in roots:
        key = str(root.resolve()) if root.exists() else str(root)
        if key not in seen:
            seen.add(key)
            out.append(Path(key))
    return out


def list_trees():
    """Every worktree of every repo: path, branch, head, and whether it's the
    main checkout. Parsed from `git worktree list --porcelain`."""
    trees = []
    for root in _repo_roots():
        text = _git(root, "worktree", "list", "--porcelain") or ""
        main_branch = None
        # The first block is always the main checkout; the rest are its copies.
        for position, block in enumerate(text.strip().split("\n\n")):
            fields = {}
            for line in block.splitlines():
                key, _, value = line.partition(" ")
                fields[key] = value
            if "worktree" not in fields:
                continue
            branch = fields.get("branch", "").removeprefix("refs/heads/") or None
            is_main = position == 0
            if is_main:
                main_branch = branch
            trees.append({
                "path": fields["worktree"],
                "repo": root.name,
                "repo_path": str(root),
                "branch": branch,
                "head": (fields.get("HEAD") or "")[:7],
                "main": is_main,
                "main_branch": main_branch,
                "missing": "prunable" in fields or not Path(fields["worktree"]).is_dir(),
            })
    return trees


# Git facts that cost real time (a status on the vault takes seconds), so a
# cache that refreshes in the background: a request never waits on git after
# the first one; it gets the last answer while a fresh one is worked out.
_FACTS_TTL = 90
_facts = {"at": 0.0, "data": {}, "busy": False}
_facts_lock = threading.Lock()


def _tree_facts(tree):
    path, branch, base = tree["path"], tree["branch"], tree["main_branch"]
    facts = {"ahead": None, "behind": None, "dirty": None, "last_commit_at": None}
    if tree["missing"]:
        return facts
    if branch and base and branch != base:
        counts = _git(path, "rev-list", "--left-right", "--count", f"{base}...{branch}")
        if counts and len(counts.split()) == 2:
            behind, ahead = counts.split()
            facts["behind"], facts["ahead"] = int(behind), int(ahead)
    status = _git(path, "status", "--porcelain", timeout=30)
    if status is not None:
        facts["dirty"] = len([ln for ln in status.splitlines() if ln])
    stamp = _git(path, "log", "-1", "--format=%cI")
    if stamp and stamp.strip():
        facts["last_commit_at"] = stamp.strip()
    return facts


def _refresh_facts(trees):
    try:
        data = {t["path"]: _tree_facts(t) for t in trees}
        with _facts_lock:
            _facts.update(at=time.time(), data=data)
    finally:
        with _facts_lock:
            _facts["busy"] = False


def git_facts(trees, wait=False):
    """This is a stale-while-revalidate cache. `wait` computes inline when
    there's no answer at all yet (the very first load)."""
    with _facts_lock:
        stale = time.time() - _facts["at"] > _FACTS_TTL
        empty = not _facts["data"]
        start = stale and not _facts["busy"]
        if start:
            _facts["busy"] = True
    if start:
        if wait and empty:
            _refresh_facts(trees)
        else:
            threading.Thread(target=_refresh_facts, args=(trees,), daemon=True).start()
    with _facts_lock:
        return dict(_facts["data"])


# --- attributing tool calls to trees --------------------------------------

def _matchers(trees):
    """One regex per tree path, longest first, anchored so /x/skeleton never
    matches inside /x/skeleton-other: the path must end at a slash, a quote,
    whitespace or a shell separator."""
    paths = sorted({t["path"] for t in trees}, key=len, reverse=True)
    return [(p, re.compile(re.escape(p) + r"(?=[/\s'\"`;:|&)]|$)")) for p in paths]


def _tree_of_folder(folder, matchers):
    """The tree a folder sits in, or None."""
    if not folder:
        return None
    for path, _ in matchers:
        if folder == path or folder.startswith(path + "/"):
            return path
    return None


def _call_text(name, target, raw_input):
    """The text worth scanning for paths: the file for the file tools, the
    command for Bash. Falls back to `target` when the stored input was cut
    short and no longer parses."""
    try:
        inp = json.loads(raw_input) if raw_input else {}
    except ValueError:
        inp = {}
    if not isinstance(inp, dict):
        inp = {}
    if name == "Bash":
        return inp.get("command") or target or ""
    parts = [inp[k] for k in _PATH_KEYS if isinstance(inp.get(k), str)]
    return " ".join(parts) if parts else (target or "")


def trees_touched(name, text, cwd, matchers):
    """Which trees one call touched, and the file it touched in each (for the
    file tools). A call naming no tree at all counts against the tree its
    session is standing in — that's a relative path, or a bare command."""
    hits = {}
    rest = text
    for path, rx in matchers:
        found = rx.search(rest)
        if not found:
            continue
        file = None
        if name in ("Edit", "Write", "MultiEdit", "NotebookEdit", "Read"):
            tail = rest[found.end():].split()[0] if rest[found.end():].strip() else ""
            file = tail.lstrip("/") or None
        hits[path] = file
        # Blank it out so a shorter path can't re-match the same text.
        rest = rx.sub(" ", rest)
    if not hits:
        home = _tree_of_folder(cwd, matchers)
        if home:
            hits[home] = None
    return hits


def _short(name, text, tree_path):
    """One line saying what a call did, paths shown relative to the tree."""
    line = " ".join(str(text).split())
    line = line.replace(tree_path + "/", "").replace(tree_path, ".")
    return line[:160]


def build_map(trees, rows, conv_meta):
    """The whole page's data from its three inputs — pure, so it's tested
    without git or a database.

    trees: list_trees() shape. rows: tool calls (conv, at, name, target,
    input, cwd), oldest first. conv_meta: conv id -> index entry."""
    matchers = _matchers(trees)
    agents_by_tree = {t["path"]: {} for t in trees}
    for conv, at, name, target, raw_input, cwd in rows:
        kind = _KIND.get(name)
        if not conv or not kind:
            continue
        entry = conv_meta.get(conv) or {}
        text = _call_text(name, target, raw_input)
        home = cwd or entry.get("cwd")
        for tree_path, file in trees_touched(name, text, home, matchers).items():
            agents = agents_by_tree.setdefault(tree_path, {})
            agent = agents.get(conv)
            if agent is None:
                agent = agents[conv] = {
                    "conv": conv,
                    "title": entry.get("title") or conv,
                    "lane": entry.get("lane"),
                    "home": _tree_of_folder(entry.get("cwd"), matchers) == tree_path,
                    "edited": 0, "ran": 0, "looked": 0,
                    "first_at": at, "last_at": at, "last_write_at": None,
                    "_files": {}, "recent": [],
                }
            agent[kind] += 1
            agent["last_at"] = at
            if kind != "looked":
                agent["last_write_at"] = at
            if kind == "edited" and file:
                agent["_files"][file] = agent["_files"].get(file, 0) + 1
            agent["recent"].append({"at": at, "tool": name, "kind": kind,
                                    "what": _short(name, text, tree_path)})
            del agent["recent"][:-_RECENT_SHOWN]

    out = []
    for tree in trees:
        agents = list(agents_by_tree.get(tree["path"], {}).values())
        for agent in agents:
            files = sorted(agent.pop("_files").items(), key=lambda kv: -kv[1])
            agent["files"] = [{"path": p, "edits": n} for p, n in files[:_FILES_SHOWN]]
            agent["recent"].reverse()
        # Busiest first: writers before lookers, then most recent.
        agents.sort(key=lambda a: (a["last_write_at"] is None, -(a["edited"] + a["ran"]),
                                   _neg_time(a["last_at"])))
        out.append({**tree, "agents": agents})
    return out


def _neg_time(stamp):
    try:
        return -datetime.fromisoformat(stamp).timestamp()
    except (TypeError, ValueError):
        return 0


def _rows_since(since):
    conn = sqlstore.open_db()
    try:
        return conn.execute(
            "SELECT conv, at, name, target, input, cwd FROM tool_calls"
            " WHERE at >= ? AND conv IS NOT NULL ORDER BY at",
            (since,)).fetchall()
    finally:
        conn.close()


def collect(window):
    trees = list_trees()
    since = (datetime.now() - timedelta(seconds=window)).isoformat(timespec="milliseconds")
    index = store.read("bot_chats/index", {}) or {}
    conv_meta = {k: v for k, v in index.items() if isinstance(v, dict)}
    mapped = build_map(trees, _rows_since(since), conv_meta)
    facts = git_facts(trees)
    for tree in mapped:
        tree.update(facts.get(tree["path"]) or
                    {"ahead": None, "behind": None, "dirty": None, "last_commit_at": None})
    return mapped


def register(app):

    @app.route("/api/worktree-map", methods=["GET"])
    def worktree_map():
        try:
            window = int(request.args.get("window", _DEFAULT_WINDOW))
        except ValueError:
            window = _DEFAULT_WINDOW
        window = max(_MIN_WINDOW, min(_MAX_WINDOW, window))
        return jsonify({"window": window,
                        "now": datetime.now().isoformat(timespec="seconds"),
                        "trees": collect(window)})
