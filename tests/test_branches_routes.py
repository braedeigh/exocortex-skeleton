"""routes/branches.py — the pile of agent/* branches nobody has taken yet.

Needs a REAL git repo, same as tests/test_worktrees.py and for the same reason:
every fact this route reports is a fact about git (does the branch exist, is it
merged, what does it carry), so stubbing git would only test the stub.

The contract worth protecting is the SPLIT: numbers come from git, the report is
the agent's prose, and they never arrive as one blended blob. A page that merged
them would let a confident write-up read as a passing test.
"""
import subprocess

import pytest
from flask import Flask

import store
import worktrees
from routes import branches


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True)


@pytest.fixture
def repo(tmp_path, monkeypatch, data_dir):
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
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    return skeleton


@pytest.fixture
def client(repo):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    branches.register(app)
    return app.test_client()


def _index(data_dir, entries):
    """Write the conversation index. The directory has to exist first — the app
    makes it via observatory._chats_dir(); here it's one line."""
    (data_dir / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", entries)


def _build_a_branch(repo, slug="thing", text="x = 1\n"):
    """A worktree with one real commit on it — what a session leaves behind."""
    path, branch = worktrees.mint(slug)
    (path / "feature.py").write_text(text)
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", f"{slug}: did the thing")
    return path, branch


def test_an_empty_repo_lists_nothing(client):
    body = client.get("/api/branches").get_json()
    assert body["branches"] == []


def test_a_branch_reports_what_it_carries_from_git(client, repo):
    _, branch = _build_a_branch(repo)

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["commits"] == 1
    assert row["files"] == ["feature.py"]
    assert "1 file changed" in row["diff_stat"]
    assert row["merged"] is False
    assert row["subject"] == "thing: did the thing"


def test_a_merged_branch_is_marked_not_hidden(client, repo):
    """She should still see it — but a branch she's already taken must not
    read as something still owed."""
    _, branch = _build_a_branch(repo)
    _git(repo, "merge", "--no-ff", "-m", "take it", branch)

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["merged"] is True
    assert row["commits"] == 0


def test_a_live_worktree_shows_work_that_never_reached_the_branch(client, repo):
    """The gap between what the session did and what a merge would get."""
    path, branch = _build_a_branch(repo)
    (path / "scratch.py").write_text("unfinished\n")

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["worktree"] == str(path)
    assert any("scratch.py" in line for line in row["uncommitted"])


def test_a_branch_whose_worktree_is_gone_still_lists(client, repo):
    """The common case: the copy is removed when the session closes, but the
    branch is what she has to decide about."""
    path, branch = _build_a_branch(repo)
    worktrees.remove(path)

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["worktree"] is None
    assert row["commits"] == 1
    assert row["uncommitted"] == []


def test_the_session_behind_a_branch_is_named(client, repo, data_dir):
    _, branch = _build_a_branch(repo)
    _index(data_dir, {
        "2026-08-05.100000": {"branch": branch, "title": "spin: thing",
                              "spinoff_slug": "thing", "lane": "orchestra"}})

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["session"]["title"] == "spin: thing"
    assert row["session"]["conversation_id"] == "2026-08-05.100000"


def test_the_list_says_whether_a_report_exists_without_inlining_it(client, repo, data_dir):
    """Opening the page must not read a dozen files off disk — and the prose
    must not arrive blended into the numbers."""
    _, branch = _build_a_branch(repo)
    _index(data_dir, {"c1": {"branch": branch, "spinoff_slug": "thing"}})
    d = data_dir / "spinoffs" / "thing"
    d.mkdir(parents=True)
    (d / "REPORT.md").write_text("# What I built\n\nA thing.\n")

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["has_report"] is True
    assert "report" not in row


def test_the_report_is_fetched_separately(client, repo, data_dir):
    _, branch = _build_a_branch(repo)
    _index(data_dir, {"c1": {"branch": branch, "spinoff_slug": "thing"}})
    d = data_dir / "spinoffs" / "thing"
    d.mkdir(parents=True)
    (d / "REPORT.md").write_text("# What I built\n\nA thing.\n")

    body = client.get(f"/api/branches/report?branch={branch}").get_json()

    assert "A thing." in body["report"]


def test_a_branch_with_no_report_says_so_rather_than_erroring(client, repo):
    """A session that died before writing one still changed real files — the
    numbers stand on their own."""
    _, branch = _build_a_branch(repo)

    r = client.get(f"/api/branches/report?branch={branch}")

    assert r.status_code == 200
    assert r.get_json()["report"] is None


def test_the_report_door_refuses_anything_that_is_not_an_agent_branch(client, repo):
    """It reads a path built from a slug, so the branch name is not trusted."""
    assert client.get("/api/branches/report?branch=main").status_code == 400
    assert client.get("/api/branches/report?branch=").status_code == 400


def test_a_night_crew_branch_carries_its_verdict(client, repo, data_dir):
    """The overnight crew is the one place a real test result exists today,
    and it belongs on the card."""
    _, branch = _build_a_branch(repo, slug="nightly")
    store.write("night_runs.json", {"runs": [
        {"branch": branch, "status": "ready", "note_text": "fix the thing",
         "test_tail": "pytest: ok"}]})

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["night_run"]["status"] == "ready"
    assert row["night_run"]["tested"] is True


# --- state: what a branch IS to her, which git alone doesn't say -------------

def test_a_branch_with_work_she_has_not_taken_is_waiting(client, repo):
    _, branch = _build_a_branch(repo)

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["state"] == "waiting"


def test_a_merged_branch_stops_asking_for_anything(client, repo):
    """Once merged, the branch's commits ARE in main, so the count ahead drops
    to zero and it becomes indistinguishable from a branch that built nothing.
    Rather than guess, `done` claims only what's true: nothing here needs her."""
    _, branch = _build_a_branch(repo)
    _git(repo, "merge", "--no-ff", "-m", "take it", branch)

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["state"] == "done"


def test_a_night_run_that_built_nothing_is_named_empty(client, repo, data_dir):
    """The distinction that makes this page readable. An empty branch is
    trivially 'merged' to git — nothing in it is missing from main — but
    "you already took this" and "the agent tried and changed nothing" are
    opposite mornings. On the real repo the empty ones outnumbered the real
    ones 3 to 1."""
    _, branch = worktrees.mint("parked")   # a worktree, nothing ever committed
    store.write("night_runs.json", {"runs": [
        {"branch": branch, "status": "parked", "reason": "note was ambiguous"}]})

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["merged"] is True      # git's answer: nothing missing from main
    assert row["state"] == "empty"    # hers: the crew tried and built nothing


def test_a_copy_with_uncommitted_work_reads_as_still_building(client, repo):
    """Caught by looking at the page, not by a test. A card said "nothing to
    take" while warning in the next breath that 8 files would be missed by a
    merge. Both were true of git; together they were nonsense. Work in
    progress is neither owed to her nor finished."""
    path, branch = _build_a_branch(repo)
    _git(repo, "merge", "--no-ff", "-m", "take it", branch)   # would read `done`
    (path / "still-going.py").write_text("mid-edit\n")

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["state"] == "working"
