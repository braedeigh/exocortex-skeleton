"""Tests for worktrees.py — the per-session copy of the repo.

Unlike the rest of the suite these need a REAL git repository, because every
behaviour worth protecting here is a fact about git rather than about our own
code: whether a branch already exists, whether a symlink shows up as untracked,
whether removing a worktree leaves the branch behind. So the fixture builds a
throwaway repo in tmp_path and re-points the module's two roots at it.

The two tests that matter most are the ones guarding a session's life:
mint() must REFUSE an existing path (forcing would delete a running agent's
working directory) and sweep() must only ever touch archived conversations
(a worktree is a live session's cwd — deleting it kills the session for good).
"""
import subprocess

import pytest

import worktrees


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A real git repo standing in for the skeleton checkout, with the same
    .gitignore trick the real one uses (`venv` spelled both ways)."""
    skeleton = tmp_path / "skeleton"
    skeleton.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(skeleton)], check=True)
    _git(skeleton, "config", "user.email", "t@example.com")
    _git(skeleton, "config", "user.name", "Test")
    (skeleton / "server.py").write_text("# app\n")
    (skeleton / ".gitignore").write_text("venv/\nvenv\n")
    _git(skeleton, "add", "-A")
    _git(skeleton, "commit", "-qm", "init")

    monkeypatch.setattr(worktrees, "SKELETON", skeleton)
    monkeypatch.setattr(worktrees, "WORKTREE_ROOT", tmp_path / "worktrees")
    return skeleton


def test_mint_creates_a_working_copy_on_its_own_branch(repo):
    path, branch = worktrees.mint("thing")

    assert path.is_dir()
    assert (path / "server.py").read_text() == "# app\n"
    assert branch.startswith("agent/thing-")
    heads = _git(repo, "branch", "--list", branch).stdout
    assert branch in heads


def test_mint_refuses_when_the_path_is_already_taken(repo):
    """The bug this exists to not import: nightcrew's equivalent opens by
    force-removing whatever is there, which for a re-opened spinoff would
    delete a LIVE agent's working directory mid-turn."""
    path, _ = worktrees.mint("thing")
    marker = path / "half-written.py"
    marker.write_text("work in progress\n")

    with pytest.raises(worktrees.WorktreeError):
        worktrees.mint("thing")

    assert marker.read_text() == "work in progress\n"


def test_mint_refuses_when_the_branch_is_already_taken(repo, monkeypatch):
    _, branch = worktrees.mint("thing")
    worktrees.remove(worktrees.worktree_path("thing"))
    # Same slug, same minute -> same branch name. The branch outlived the
    # working copy (it's the deliverable), so minting again must refuse.
    monkeypatch.setattr(worktrees, "branch_name", lambda slug: branch)

    with pytest.raises(worktrees.WorktreeError):
        worktrees.mint("thing")


def test_branch_name_carries_the_slug_and_a_timestamp(repo):
    """Slugs are chosen to be readable months later, so the same one comes
    round again; a bare agent/<slug> would collide with the old branch."""
    name = worktrees.branch_name("keeper-chat")
    assert name.startswith("agent/keeper-chat-")
    assert name != "agent/keeper-chat"


def test_shared_deps_are_linked_in_and_stay_out_of_git(repo):
    """The trap: .gitignore's `venv/` matches DIRECTORIES, and what we create
    is a symlink, which git counts as a file. Without the slash-less spelling
    the worktree opens dirty and one `git add -A` commits a symlink to this
    machine's venv."""
    (repo / "venv").mkdir()
    (repo / "venv" / "pyvenv.cfg").write_text("home = /usr\n")

    path, _ = worktrees.mint("thing")

    assert (path / "venv").is_symlink()
    assert (path / "venv" / "pyvenv.cfg").read_text() == "home = /usr\n"
    status = _git(path, "status", "--porcelain").stdout.strip()
    assert status == "", f"worktree opened dirty: {status!r}"


def test_missing_shared_deps_are_simply_skipped(repo):
    """A fresh install with no venv yet must still get a usable worktree."""
    path, _ = worktrees.mint("thing")
    assert path.is_dir()
    assert not (path / "venv").exists()


def test_remove_drops_the_copy_but_keeps_the_branch(repo):
    """The branch is where the session's work lives until it's merged."""
    path, branch = worktrees.mint("thing")

    worktrees.remove(path)

    assert not path.exists()
    assert branch in _git(repo, "branch", "--list", branch).stdout


def test_sweep_removes_archived_sessions_only(repo):
    live, _ = worktrees.mint("alive")
    dead, _ = worktrees.mint("archived")
    index = {
        "c1": {"worktree": str(live)},
        "c2": {"worktree": str(dead), "archived": "2026-08-04T10:00:00"},
    }

    removed = worktrees.sweep(index)

    assert removed == ["archived"]
    assert live.is_dir()
    assert not dead.exists()


def test_sweep_never_reaps_a_live_session_however_old(repo):
    """The bricking case. A worktree is a live conversation's cwd, and a
    conversation can only be resumed from the directory it was born in — so
    reaping one because it looks stale doesn't reclaim junk, it permanently
    kills a session that was merely idle."""
    path, _ = worktrees.mint("thinking")
    index = {"c1": {"worktree": str(path), "last_at": "2020-01-01T00:00:00"}}

    assert worktrees.sweep(index) == []
    assert path.is_dir()


def test_sweep_removes_a_worktree_no_session_claims(repo):
    """Left over from a crash — nothing in the index points at it."""
    path, _ = worktrees.mint("orphan")

    assert worktrees.sweep({}) == ["orphan"]
    assert not path.exists()


def test_a_worktree_file_reads_back_as_the_real_repo(repo):
    """Terrain, ▶ fork and the doc-guard all match files by comparing absolute
    paths to the repo roots; a worktree sits under neither, so without this a
    worktree session's writes belong to no repo and it vanishes off the map."""
    path, _ = worktrees.mint("thing")

    mapped = worktrees.as_skeleton_path(path / "routes" / "spinoff.py")

    assert mapped == str(repo / "routes" / "spinoff.py")


def test_paths_outside_a_worktree_pass_through_untouched(repo, tmp_path):
    """Callers pipe every path through this, so a non-worktree path must come
    back exactly as it went in."""
    for outside in (repo / "routes" / "spinoff.py", tmp_path / "vault" / "data" / "x.json"):
        assert worktrees.as_skeleton_path(outside) == str(outside)


def test_worktree_root_for_finds_the_copy_a_file_sits_in(repo):
    path, _ = worktrees.mint("thing")

    assert worktrees.worktree_root_for(path / "a" / "b.py") == path
    assert worktrees.worktree_root_for(repo / "server.py") is None


@pytest.mark.parametrize("slug,ok", [
    ("keeper-chat", True), ("a", True), ("9lives", True),
    ("", False), ("-leading", False), ("Caps", False),
    ("has space", False), ("../escape", False), ("x" * 40, False),
])
def test_slug_validation_matches_the_spinoff_door(slug, ok):
    """A slug becomes a directory name and a branch name, so this module
    re-checks it rather than trusting the caller to have done so."""
    assert worktrees.is_valid_slug(slug) is ok


# --- evidence: the half that isn't the agent's word for it -------------------

def test_evidence_reads_the_branch_from_git_not_from_the_agent(repo):
    path, branch = worktrees.mint("reporting")
    (path / "feature.py").write_text("x = 1\n")
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "add a feature")

    ev = worktrees.evidence(path, branch)

    assert ev["branch"] == branch
    assert len(ev["commits"]) == 1
    assert "add a feature" in ev["commits"][0]
    assert ev["files"] == ["feature.py"]
    assert "1 file changed" in ev["diff_stat"]
    assert ev["uncommitted"] == []


def test_evidence_surfaces_work_that_never_reached_the_branch(repo):
    """The gap between what the session did and what a merge would get."""
    path, branch = worktrees.mint("half-done")
    (path / "scratch.py").write_text("unfinished\n")

    ev = worktrees.evidence(path, branch)

    assert ev["commits"] == []
    assert any("scratch.py" in line for line in ev["uncommitted"])


def test_evidence_on_a_removed_worktree_says_so_rather_than_crashing(repo):
    path, branch = worktrees.mint("swept")
    worktrees.remove(path)

    assert worktrees.evidence(path, branch) == {"branch": branch, "gone": True}


# --- adopt(): a worktree standing on an EXISTING branch (the steward door) ---
# mint() is for new work; adopt() is for work some earlier session already
# left on a branch. The refusals are the contract: a live checkout of the
# branch means a live session is standing there, and adopt must never fork
# that ground out from under it.

def _leave_a_branch(repo, name="agent/left-behind"):
    """A branch with one commit and NO worktree — what a dead session leaves."""
    _git(repo, "branch", name)
    _git(repo, "checkout", "-q", name)
    (repo / "feature.py").write_text("x = 1\n")
    _git(repo, "add", "feature.py")
    _git(repo, "commit", "-qm", "left work here")
    _git(repo, "checkout", "-q", "main")
    return name


def test_adopt_stands_a_copy_on_the_existing_branch(repo):
    branch = _leave_a_branch(repo)

    path, got = worktrees.adopt("steward-left-behind", branch)

    assert got == branch
    assert (path / "feature.py").read_text() == "x = 1\n"
    # No new branch was minted — adoption reuses, never re-creates.
    heads = _git(repo, "branch", "--list", "agent/*").stdout
    assert heads.strip().split() in ([branch], ["+", branch])


def test_adopt_refuses_a_branch_that_does_not_exist(repo):
    with pytest.raises(worktrees.WorktreeError):
        worktrees.adopt("steward-ghost", "agent/never-was")
    assert not worktrees.worktree_path("steward-ghost").exists()


def test_adopt_refuses_a_branch_someone_is_standing_on(repo):
    """git allows one checkout per branch, and that refusal is load-bearing:
    a branch with a live worktree has a live session in it, and the answer is
    to talk to that session, not to fork its ground."""
    _, branch = worktrees.mint("builder")   # builder still standing there

    with pytest.raises(worktrees.WorktreeError):
        worktrees.adopt("steward-builder", branch)


def test_adopt_refuses_when_the_path_is_already_taken(repo):
    branch = _leave_a_branch(repo)
    path, _ = worktrees.adopt("steward-left-behind", branch)
    (path / "half-written.py").write_text("work in progress\n")

    with pytest.raises(worktrees.WorktreeError):
        worktrees.adopt("steward-left-behind", branch)

    assert (path / "half-written.py").read_text() == "work in progress\n"
