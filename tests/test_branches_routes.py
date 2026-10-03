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


def test_a_branch_card_is_only_ever_git(client, repo, data_dir):
    """Sessions used to write a REPORT.md of their own prose and the card said
    so. Removed 2026-08-22 — nobody read them. This pins that no narrated half
    creeps back into the row beside the measured one."""
    _, branch = _build_a_branch(repo)
    _index(data_dir, {"c1": {"branch": branch, "spinoff_slug": "thing"}})
    d = data_dir / "spinoffs" / "thing"
    d.mkdir(parents=True)
    (d / "REPORT.md").write_text("# What I built\n\nA thing.\n")

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    # Even with a stale report file sitting on disk, the card never mentions it.
    assert "report" not in row and "has_report" not in row
    assert client.get(f"/api/branches/report?branch={branch}").status_code == 404


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


# --- the steward door: replying to a branch card wakes a session on it -------
# The endpoint's own job is the refusal ladder and the brief; the actual spawn
# is routes/spinoff.py's adopt-mode (tested in test_spinoff_routes.py), so it
# is stubbed here and the calls are asserted instead.

import routes.spinoff as spinoff_mod
from routes.branches import steward_slug


@pytest.fixture
def spawn_spy(monkeypatch):
    calls = []
    def fake_open_spinoff(slug, lane=None, branch=None, **kw):
        calls.append({"slug": slug, "lane": lane, "branch": branch})
        return {"ok": True, "conversation_id": "2026-08-09.120000",
                "newly_spawned": True}, 200
    monkeypatch.setattr(spinoff_mod, "open_spinoff", fake_open_spinoff)
    return calls


def _wake(client, branch, message="make the button teal"):
    return client.post("/api/branches/steward",
                       json={"branch": branch, "message": message})


def test_steward_slug_is_deterministic_and_slug_shaped(repo):
    # Determinism IS the one-steward-per-branch rule: same branch, same slug,
    # and the spinoff door's rejoin does the rest.
    assert steward_slug("agent/E2E02") == "steward-e2e02"
    assert steward_slug("agent/nightcrew-room-0805-1727") == \
        "steward-nightcrew-room-0805-1727"
    import worktrees as wt
    assert wt.is_valid_slug(steward_slug("agent/" + "x" * 60))


def test_waking_needs_an_agent_branch_and_a_message(client, spawn_spy):
    assert _wake(client, "main").status_code == 400
    assert _wake(client, "agent/thing", message="  ").status_code == 400
    assert client.post("/api/branches/steward", json={}).status_code == 400
    assert spawn_spy == []


def test_waking_a_branch_that_does_not_exist_404s(client, repo, spawn_spy):
    assert _wake(client, "agent/never-was").status_code == 404
    assert spawn_spy == []


def test_a_merged_branch_refuses_the_wake(client, repo, spawn_spy):
    _, branch = _build_a_branch(repo)
    _git(repo, "merge", "-q", "--no-ff", "-m", "take it", branch)

    r = _wake(client, branch)

    assert r.status_code == 409
    assert "merged" in r.get_json()["error"]
    assert spawn_spy == []


def test_a_live_session_on_the_branch_is_rejoined_not_doubled(
        client, repo, data_dir, spawn_spy):
    """One branch, one voice. A live session standing on the branch (builder
    or steward) answers instead — no second spawn, no second worktree."""
    _, branch = _build_a_branch(repo)
    _index(data_dir, {"conv-1": {"branch": branch, "title": "the builder",
                                 "spinoff_slug": "builder-slug"}})

    r = _wake(client, branch)

    assert r.status_code == 200
    body = r.get_json()
    assert body["existing"] is True
    assert body["conversation_id"] == "conv-1"
    assert spawn_spy == []


def test_an_archived_session_does_not_block_the_wake(
        client, repo, data_dir, spawn_spy):
    _, branch = _build_a_branch(repo)
    _index(data_dir, {"conv-1": {"branch": branch, "archived": "2026-01-01",
                                 "spinoff_slug": "builder-slug"}})

    r = _wake(client, branch)

    assert r.status_code == 200
    assert r.get_json()["existing"] is False
    assert [c["branch"] for c in spawn_spy] == [branch]


def test_a_fresh_wake_briefs_from_evidence_and_spawns_through_the_door(
        client, repo, spawn_spy):
    _, branch = _build_a_branch(repo)

    r = _wake(client, branch, message="make the button teal")

    assert r.status_code == 200
    body = r.get_json()
    assert body["conversation_id"] == "2026-08-09.120000"
    assert spawn_spy == [{"slug": steward_slug(branch), "lane": "orchestra",
                          "branch": branch}]
    import briefstore
    brief = briefstore.latest(steward_slug(branch))["body"]
    # Her words verbatim, the branch by name, the evidence from git, and the
    # honesty rail — the four things the brief exists to carry.
    assert "make the button teal" in brief
    assert branch in brief
    assert "did the thing" in brief          # the commit subject, from git
    assert "1 file changed" in brief         # the diff stat, from git
    assert "NOT the session that built this" in brief
    assert "NOTHING MERGES WITHOUT HER TAP" in brief


def test_the_card_carries_commit_subjects_for_the_face(client, repo):
    _, branch = _build_a_branch(repo)

    row = next(b for b in client.get("/api/branches").get_json()["branches"]
               if b["branch"] == branch)

    assert row["commit_lines"] == ["thing: did the thing"]
