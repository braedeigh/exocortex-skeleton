"""worktrees.py — a private copy of the app for every unattended session.

Plain English: when a session is spawned into the Orchestra room (the unwatched
one), it should not be editing the same folder the owner is editing. This module
mints it a `git worktree` — a second full checkout of this repo, on its own
`agent/<slug>` branch, sharing one history. The session lives there for its whole
life, commits there, and its branch is merged back by hand later. Two agents can
then work at once without touching each other's files. A second door, adopt(),
stands a NEW session on an EXISTING branch instead — how a steward session
(routes/branches.py) wakes onto work an earlier, now-dead session left behind.

WHY A COPY AND NOT A RULE. Twice now two sessions sharing this one checkout have
mixed their work: one ran a sweeping `git add -A` and committed another
session's half-written files under a message that mentioned neither. Nothing was
lost either time, by luck. Prose didn't prevent it and can't — the sweeping
session was following the commit rule as written. A session that physically does
not have your files cannot commit them.

WHO GETS ONE. Only Orchestra. The Coding and Personal rooms stay in the real
checkout, because gunicorn serves *that* folder and those sessions are the
owner's own hands — they need to edit, refresh, and look. An Orchestra session
gives that up: it cannot see its change in a browser, and its proof is a test
run, not eyeballs. See routes/spinoff.py, which is the only caller that mints.

THE TOPOLOGY IS A HUB, NOT A CHAIN. Every branch is cut from `main` and merged
back to `main`, and nothing is ever merged INTO a branch somebody is standing
in — that would just move the collision one level down. The owner is the only
one who merges. Written up in docs/worktrees.md.

THE ONE RULE THAT KEEPS A SESSION ALIVE. A conversation's cwd is fixed at birth
(Claude Code stores conversations per directory; `--resume` from anywhere else
fails), so for a worktree session the cwd IS this directory. Deleting it while
its conversation is still open does not free space — it silently kills the
session, permanently. That is why sweep() keys on the conversation being
archived and never on a clock.

Touches: routes/spinoff.py (mints at spawn), routes/observatory.py (archiving a
session reaps its worktree; the doc-guard and the fork/Terrain file mapping both
have to know a worktree path is really this repo), scripts/nightcrew_run.py (the
prototype this generalizes — its own throwaway worktrees predate this module).

Prompt that produced it: "when a session is spawned through the spinoff door,
mint a git worktree at session-create time and make it that session's home, on
its own agent/<slug> branch — so parallel builders stop editing the one shared
checkout."
"""
import os
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

import store

def _main_checkout():
    """The REAL checkout, even when this code is running from a copy of it.

    store.BUILD_DIR is "the directory this file is in", which inside a worktree
    is the worktree — so deriving from it would root a child worktree under its
    parent and nest copies inside copies (`worktrees/worktrees/...`), with the
    shared symlinks resolved from a copy rather than the original. Git already
    knows the answer: every worktree's COMMON git dir is the main checkout's
    .git, whichever copy you ask from. Falls back to BUILD_DIR when git can't
    answer (no git, not a repo) — a fresh install or a tarball deploy."""
    try:
        r = subprocess.run(
            ["git", "-C", str(store.BUILD_DIR), "rev-parse",
             "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return Path(r.stdout.strip()).parent
    except (OSError, subprocess.SubprocessError):
        pass
    return Path(store.BUILD_DIR)


SKELETON = _main_checkout()

# Worktrees live beside the two repos, not inside either — a checkout nested in
# the checkout it copies shows up as a giant untracked directory in the parent.
# Not /tmp (nightcrew's choice): a night run is over in minutes, but one of
# these can be days old, and systemd sweeps /tmp.
WORKTREE_ROOT = Path(os.environ.get(
    "EXOCORTEX_WORKTREE_DIR", SKELETON.parent / "worktrees"))

# Copied in as symlinks rather than checked out, because git doesn't track them
# and a worktree without them can't run anything: venv/ and node_modules/ are
# the two heavyweights (~600 MB together — sharing them is what keeps a worktree
# at tens of MB), and the other two are this install's private config, symlinked
# into the main checkout from the vault. A worktree missing CLAUDE.local.md is a
# session that doesn't know which machine it's on.
SHARED = ("venv", "frontend/node_modules", "CLAUDE.local.md", "frontend/.env.local")


class WorktreeError(RuntimeError):
    """Minting refused. Always means nothing was created."""


def _git(*args, cwd=None):
    return subprocess.run(["git", "-C", str(cwd or SKELETON), *args],
                          capture_output=True, text=True)


def branch_name(slug):
    """`agent/<slug>-<MMDD-HHMM>`. The timestamp is not decoration: slugs are
    chosen to be readable months later ("keeper-chat", not "item-3"), so the
    same one WILL come round again, and a bare `agent/<slug>` would collide
    with a branch from the last time."""
    return f"agent/{slug}-{datetime.now():%m%d-%H%M}"


def worktree_path(slug):
    return WORKTREE_ROOT / slug


def mint(slug, base="HEAD"):
    """Cut a worktree + branch for `slug`. Returns (path, branch).

    REFUSES rather than forces when the path or branch is already there.
    nightcrew's equivalent opens by force-removing both, which is right for a
    throwaway night run and catastrophic here: a spinoff slug can be re-opened
    while its session is still alive, and forcing would delete a running agent's
    working directory out from under it. routes/spinoff.py only calls this on
    the newly-spawned path — a rejoin never mints.

    `base` is what the branch is cut from, and it's a parameter rather than
    hardwired to HEAD so the room the branch answers to can change later
    without reopening this function.
    """
    path = worktree_path(slug)
    branch = branch_name(slug)
    if path.exists():
        raise WorktreeError(f"{path} already exists")
    if _git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0:
        raise WorktreeError(f"branch {branch} already exists")

    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)
    r = _git("worktree", "add", str(path), "-b", branch, base)
    if r.returncode != 0:
        raise WorktreeError(f"worktree add failed: {r.stderr.strip()}")
    link_shared(path)
    return path, branch


def adopt(slug, branch):
    """A worktree standing on an EXISTING agent/* branch — the steward door's
    ground, and the seam a future escalation spawner rides too. Where mint()
    cuts a NEW branch for new work, adopt() puts a fresh copy of the checkout
    on a branch some earlier session already built, so a new session can read,
    amend and re-test that work. Returns (path, branch).

    REFUSES rather than degrades, always with nothing created:
      - the path already exists (a live adoption — rejoin its session instead)
      - the branch doesn't exist (nothing to stand on)
      - git refuses the add — the important case being a branch already
        checked out in ANOTHER worktree: git allows one checkout per branch,
        and that refusal is correct here, because a branch with a live
        worktree has a live session standing in it, and the answer is to talk
        to THAT session, never to fork its ground out from under it.

    Prompt that produced it: "replying to a finished-work card wakes a steward
    session in a worktree on that existing branch — rejoin, never re-mint."
    """
    path = worktree_path(slug)
    if path.exists():
        raise WorktreeError(f"{path} already exists")
    if _git("rev-parse", "--verify", "--quiet",
            f"refs/heads/{branch}").returncode != 0:
        raise WorktreeError(f"branch {branch} does not exist")
    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)
    r = _git("worktree", "add", str(path), branch)
    if r.returncode != 0:
        raise WorktreeError(f"worktree add failed: {r.stderr.strip()}")
    link_shared(path)
    return path, branch


def link_shared(path):
    """Symlink the untracked heavyweights and this install's config in.

    Returns the names actually linked. Resolved through to the real target
    (`.resolve()`) rather than pointed at the main checkout's own symlinks, so
    the worktree keeps working if someone re-points those.

    No per-worktree ignore file is written, and that's deliberate: git reads
    `info/exclude` from the COMMON git dir, never the per-worktree one, so the
    file nightcrew writes there has never been read. What actually keeps these
    out of a commit is the repo's own .gitignore, which now spells `venv` both
    with and without the trailing slash (a slash matches directories only, and
    these are symlinks). Verified against git, not assumed.
    """
    linked = []
    for name in SHARED:
        src, dst = SKELETON / name, path / name
        if not src.exists() or dst.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.symlink_to(src.resolve())
        linked.append(name)
    return linked


def remove(path):
    """Drop the working copy. The BRANCH survives — it's the deliverable, and
    the only place the session's work exists until it's merged."""
    path = Path(path)
    _git("worktree", "remove", "--force", str(path))
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    _git("worktree", "prune")


def sweep(index):
    """Remove worktrees whose conversation is archived or gone. Returns the
    names removed.

    Keyed on the INDEX, never on age. A worktree is a live session's cwd, and a
    conversation can only ever be resumed from the directory it was born in —
    so deleting one because it looks old doesn't reclaim a stale copy, it
    permanently kills a session that was merely thinking. Archived is the only
    signal that means "nobody is standing here".
    """
    if not WORKTREE_ROOT.is_dir():
        return []
    live = {entry.get("worktree") for entry in index.values()
            if isinstance(entry, dict) and not entry.get("archived")}
    removed = []
    for child in sorted(WORKTREE_ROOT.iterdir()):
        if not child.is_dir() or str(child) in live:
            continue
        remove(child)
        removed.append(child.name)
    return removed


# --- reading a worktree path back as this repo -------------------------------
# Terrain, the fork-the-work parser and the doc-guard all reason about files by
# comparing absolute paths against the two repo roots. A worktree sits under
# neither, so without this a worktree session writes files that belong to no
# repo: it vanishes off the map and ▶ fork tells her it "isn't writing any
# files yet". These two turn a worktree path back into the thing it's a copy of.

def worktree_root_for(path):
    """The worktree directory `path` sits inside, or None. Purely by path
    shape — no git call, because this runs per-file in render paths."""
    try:
        candidate = Path(path).resolve()
        root = WORKTREE_ROOT.resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if root not in candidate.parents:
        return None
    # The worktree itself is the first component under the root; anything
    # deeper is a file inside it.
    rel = candidate.relative_to(root)
    return root / rel.parts[0] if rel.parts else None


def as_skeleton_path(path):
    """Rewrite a path inside a worktree to the same file in the real checkout.
    Anything else comes back unchanged, so callers can pipe every path through
    this without first asking whether it's a worktree."""
    root = worktree_root_for(path)
    if root is None:
        return str(path)
    try:
        return str(SKELETON / Path(path).resolve().relative_to(root))
    except (OSError, RuntimeError, ValueError):
        return str(path)


# --- evidence -----------------------------------------------------------
# The report a session writes about its own work is PROSE, and prose is the
# most persuasive thing an agent can produce about code the reader can't check.
# Everything safe in this system rests on the same rule — the night crew states
# it outright: "DO NOT claim your work passes. This script runs the tests, and
# its output is the only evidence that counts." So the numbers come from here,
# from git, and the surface keeps them visibly apart from the agent's telling.
#
# What this DOESN'T carry yet is a test result: running the gates belongs with
# the merge tap, which isn't built. So today this answers "what changed", not
# "does it work".

def branch_evidence(branch, base="main"):
    """What a branch carries, asked of the MAIN checkout — so it works for a
    branch whose worktree is long gone. That's the common case on the branches
    page: the copy is removed when its session closes, but the branch stays
    until it's merged, and it's the branch she has to decide about."""
    log = _git("log", "--oneline", f"{base}..{branch}").stdout.strip()
    stat = _git("diff", "--shortstat", f"{base}...{branch}").stdout.strip()
    names = _git("diff", "--name-only", f"{base}...{branch}").stdout.strip()
    return {
        "branch": branch,
        "commits": [ln for ln in log.splitlines() if ln],
        "diff_stat": stat,
        "files": [ln for ln in names.splitlines() if ln],
    }


def evidence(worktree, branch, base="main"):
    """Facts about a session's branch, read from git. Never from the agent."""
    wt = Path(worktree)
    if not wt.is_dir():
        return {"branch": branch, "gone": True}
    log = _git("log", "--oneline", f"{base}..{branch}", cwd=wt).stdout.strip()
    stat = _git("diff", "--shortstat", f"{base}...{branch}", cwd=wt).stdout.strip()
    names = _git("diff", "--name-only", f"{base}...{branch}", cwd=wt).stdout.strip()
    uncommitted = _git("status", "--porcelain", cwd=wt).stdout.strip()
    return {
        "branch": branch,
        "commits": [ln for ln in log.splitlines() if ln],
        "diff_stat": stat,
        "files": [ln for ln in names.splitlines() if ln],
        # Work sitting in the tree but not on the branch is the gap between
        # what the session did and what a merge would actually get.
        "uncommitted": [ln for ln in uncommitted.splitlines() if ln],
    }


_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")


def is_valid_slug(slug):
    """Same shape routes/spinoff.py's SLUG_RE enforces. Re-checked here because
    a slug becomes a DIRECTORY NAME and a branch name — this module must not
    depend on its caller having validated it."""
    return bool(_SLUG_RE.match(slug or ""))
