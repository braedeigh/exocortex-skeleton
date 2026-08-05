"""HTTP contract for the night crew's morning surface (routes/nightcrew.py).

Plain English: the merge endpoint is the single door through which an overnight
branch reaches the live checkout, so its refusals ARE the safety contract —
non-ready runs, missing branches, dirty working trees and conflicts must all
bounce with nothing changed, and a clean merge must both land and mark the run
merged. The greenlight endpoint is lock 1 (the tap has to actually persist),
and the state endpoint's "last night" spend has to mean last night, not
all-time.

Merge tests run against a REAL throwaway git repo (the module's SKELETON is
monkeypatched to it), because the refusals worth pinning are git's own
behaviors, not mocks of them.
"""
import subprocess
from datetime import datetime, timedelta

import pytest
from flask import Flask

import store
from routes import nightcrew


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    nightcrew.register(app)
    app.config["TESTING"] = True
    return app.test_client()


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A tiny real repo: main, plus an agent/n1 branch one commit ahead."""
    r = tmp_path / "repo"
    r.mkdir()
    _git(r, "init", "-b", "main")
    _git(r, "config", "user.email", "night@test")
    _git(r, "config", "user.name", "night")
    (r / "a.txt").write_text("one\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-m", "seed")
    _git(r, "checkout", "-b", "agent/n1")
    (r / "b.txt").write_text("fix\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-m", "nightcrew: fix")
    _git(r, "checkout", "main")
    monkeypatch.setattr(nightcrew, "SKELETON", r)
    return r


def _seed_run(**over):
    run = {"id": "r1", "note_id": "n1", "tab": "today",
           "note_text": "Add a search for to-dos", "status": "ready",
           "branch": "agent/n1",
           "finished": datetime.now().isoformat(timespec="seconds")}
    run.update(over)
    store.write("night_runs.json", {"runs": [run]})
    return run


# --- lock 1: the greenlight tap ---------------------------------------------

def test_greenlight_persists_the_flag(client):
    store.write("dev_notes.json", {"tabs": {"today": [
        {"id": "n1", "text": "Add a search for to-dos", "created": "2026-08-01 10:00"},
    ]}})
    body = client.post("/api/nightcrew/notes/n1/greenlight",
                       json={"night": True}).get_json()
    assert body["ok"] is True and body["eligible"] is True
    assert store.read("dev_notes.json", {})["tabs"]["today"][0]["night"] is True


def test_greenlight_reports_the_gates_refusal_on_the_spot(client):
    """She's allowed to tap wrong — but the response must say the net caught
    it, or she finds out by an empty morning."""
    store.write("dev_notes.json", {"tabs": {"today": [
        {"id": "n1", "text": "maybe center the modal in the page instead", "created": ""},
    ]}})
    body = client.post("/api/nightcrew/notes/n1/greenlight",
                       json={"night": True}).get_json()
    assert body["ok"] is True
    assert body["eligible"] is False
    assert "maybe" in body["reason"]


def test_greenlight_unknown_note_is_404(client):
    store.write("dev_notes.json", {"tabs": {}})
    assert client.post("/api/nightcrew/notes/nope/greenlight",
                       json={}).status_code == 404


# --- the morning payload ----------------------------------------------------

def test_last_night_spend_counts_only_the_last_24h(client):
    old = (datetime.now() - timedelta(days=3)).isoformat(timespec="seconds")
    fresh = datetime.now().isoformat(timespec="seconds")
    store.write("dev_notes.json", {"tabs": {}})
    store.write("night_runs.json", {"runs": [
        {"id": "r-old", "note_id": "a", "status": "parked", "cost_usd": 5.0, "finished": old},
        {"id": "r-new", "note_id": "b", "status": "parked", "cost_usd": 1.5, "finished": fresh},
    ]})
    spend = client.get("/api/nightcrew").get_json()["spend"]
    assert spend["night_usd"] == 1.5
    assert spend["total_usd"] == 6.5


def test_ready_runs_float_to_the_top(client):
    store.write("dev_notes.json", {"tabs": {}})
    store.write("night_runs.json", {"runs": [
        {"id": "r-p", "note_id": "a", "status": "parked", "finished": "2026-08-01T03:00:00"},
        {"id": "r-r", "note_id": "b", "status": "ready", "finished": "2026-08-01T02:00:00"},
        {"id": "r-f", "note_id": "c", "status": "failed", "finished": "2026-08-01T01:00:00"},
    ]})
    order = [r["id"] for r in client.get("/api/nightcrew").get_json()["runs"]]
    assert order == ["r-r", "r-f", "r-p"]


# --- dismiss ----------------------------------------------------------------

def test_dismiss_marks_the_record(client):
    _seed_run()
    assert client.post("/api/nightcrew/runs/r1/dismiss").get_json()["ok"] is True
    assert store.read("night_runs.json", {})["runs"][0]["dismissed"] is True


def test_dismiss_unknown_run_is_404(client):
    store.write("night_runs.json", {"runs": []})
    assert client.post("/api/nightcrew/runs/r1/dismiss").status_code == 404


# --- the merge door ---------------------------------------------------------

def test_merge_unknown_run_is_404(client):
    store.write("night_runs.json", {"runs": []})
    assert client.post("/api/nightcrew/runs/r1/merge").status_code == 404


def test_merge_refuses_a_non_ready_run(client, repo):
    """A failed branch is kept for reading, never for merging."""
    _seed_run(status="failed")
    assert client.post("/api/nightcrew/runs/r1/merge").status_code == 409
    assert not (repo / "b.txt").exists()


def test_merge_refuses_a_run_without_an_agent_branch(client, repo):
    """Only agent/* branches go through this door — a record naming main (or
    nothing) must bounce before git is even asked."""
    _seed_run(branch="main")
    assert client.post("/api/nightcrew/runs/r1/merge").status_code == 409


def test_merge_refuses_a_dirty_tree(client, repo):
    """Uncommitted changes to TRACKED files block the door — merging under
    them would tangle her work with the crew's."""
    (repo / "a.txt").write_text("her uncommitted edit\n")
    _seed_run()
    res = client.post("/api/nightcrew/runs/r1/merge")
    assert res.status_code == 409
    assert "uncommitted" in res.get_json()["error"]
    assert not (repo / "b.txt").exists()


def test_untracked_scratch_files_do_not_block_a_merge(client, repo):
    """An untracked draft can't corrupt a merge (git refuses by itself if one
    would be overwritten) — letting it block would freeze the lane behind any
    stray file in the checkout."""
    (repo / "draft.md").write_text("not committed, not in the way\n")
    _seed_run()
    assert client.post("/api/nightcrew/runs/r1/merge").get_json()["ok"] is True
    assert (repo / "b.txt").exists()


def test_clean_merge_lands_and_marks_the_run(client, repo):
    _seed_run()
    body = client.post("/api/nightcrew/runs/r1/merge").get_json()
    assert body["ok"] is True
    assert (repo / "b.txt").read_text() == "fix\n"
    assert store.read("night_runs.json", {})["runs"][0]["status"] == "merged"


def test_conflicting_merge_aborts_with_nothing_changed(client, repo):
    """A conflict is a conversation, not a tap — the endpoint must abort and
    leave her tree exactly as it was."""
    (repo / "b.txt").write_text("hers\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "her conflicting change")
    _seed_run()
    res = client.post("/api/nightcrew/runs/r1/merge")
    assert res.status_code == 409
    assert (repo / "b.txt").read_text() == "hers\n"
    assert not (repo / ".git" / "MERGE_HEAD").exists()


# --- the shot route's whitelist ---------------------------------------------

def test_shot_route_rejects_names_outside_the_whitelist(client):
    assert client.get("/api/nightcrew/shot/r1/evil.png").status_code == 404


def test_shot_route_rejects_a_traversal_shaped_run_id(client):
    """`..` passes the charset but resolves outside nightcrew_shots/ — the
    parent check has to catch it."""
    assert client.get("/api/nightcrew/shot/../before.png").status_code == 404


# --- one room, one question -------------------------------------------------
# The room was never about a crew — its own header says it's the
# finished-and-waiting room, defined by STATE. A daytime session's branch is in
# exactly that state, so it belongs here rather than on a second page answering
# the same question in different words.

@pytest.fixture
def agent_repo(tmp_path, monkeypatch, data_dir):
    """A real repo the WORKTREE layer points at, so branches can be cut for
    real. conftest quarantines these away from the live checkout by default;
    this opts one test file back in, against a throwaway."""
    import worktrees
    r = tmp_path / "agentrepo"
    r.mkdir()
    _git(r, "init", "-b", "main")
    _git(r, "config", "user.email", "t@test")
    _git(r, "config", "user.name", "t")
    (r / "a.txt").write_text("one\n")
    (r / ".gitignore").write_text("venv/\nvenv\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-m", "seed")
    monkeypatch.setattr(worktrees, "SKELETON", r)
    monkeypatch.setattr(worktrees, "WORKTREE_ROOT", tmp_path / "wt")
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    return r


def _branch_with_work(slug="spun"):
    import worktrees
    path, branch = worktrees.mint(slug)
    (path / "feature.py").write_text("x = 1\n")
    _git(path, "add", "-A")
    _git(path, "commit", "-m", f"{slug}: built a thing")
    return path, branch


def test_a_spinoff_branch_appears_in_the_room(client, agent_repo):
    _, branch = _branch_with_work()

    card = next(r for r in client.get("/api/nightcrew").get_json()["runs"]
                if r.get("branch") == branch)

    assert card["source"] == "branch"
    assert card["status"] == "ready"          # built, not taken — it asks her
    assert "1 file changed" in card["diff_stat"]


def test_a_night_run_is_not_drawn_twice(client, agent_repo):
    """Both sources know about a night branch. The night run wins the tie — it
    carries screenshots, a test result and a merge path a bare branch hasn't."""
    _, branch = _branch_with_work("nightly")
    store.write("night_runs.json", {"runs": [
        {"id": "r-1", "branch": branch, "status": "ready", "note_text": "fix it",
         "shot_after": "/api/nightcrew/shot/r-1/after.png"}]})

    runs = client.get("/api/nightcrew").get_json()["runs"]

    matching = [r for r in runs if r.get("branch") == branch]
    assert len(matching) == 1
    assert matching[0]["source"] == "night"
    assert matching[0]["id"] == "r-1"


def test_night_runs_with_no_branch_all_survive_the_join(client, agent_repo):
    """They broke before a worktree existed. Joining on branch must not let a
    null key collapse them together or drop them."""
    store.write("night_runs.json", {"runs": [
        {"id": "r-a", "status": "failed", "note_text": "one"},
        {"id": "r-b", "status": "failed", "note_text": "two"}]})

    runs = client.get("/api/nightcrew").get_json()["runs"]

    assert {r["id"] for r in runs if r.get("source") == "night"} == {"r-a", "r-b"}


def test_the_card_that_asks_her_for_something_floats_to_the_top(client, agent_repo):
    _, ready = _branch_with_work("ready-one")
    store.write("night_runs.json", {"runs": [
        {"id": "r-parked", "status": "parked", "note_text": "nope"}]})

    runs = client.get("/api/nightcrew").get_json()["runs"]

    assert runs[0]["branch"] == ready
    assert runs[-1]["id"] == "r-parked"


def test_a_live_copy_mid_edit_reads_as_still_building(client, agent_repo):
    """A night run is never in progress — she's asleep and it's over by
    morning. A daytime session's copy can be mid-edit right now, which is the
    one genuinely new state the join brought in."""
    path, branch = _branch_with_work("in-flight")
    (path / "half-done.py").write_text("mid-edit\n")

    card = next(r for r in client.get("/api/nightcrew").get_json()["runs"]
                if r.get("branch") == branch)

    assert card["status"] == "working"
    assert any("half-done.py" in line for line in card["uncommitted"])


def test_a_branch_card_carries_no_merge_handle(client, agent_repo):
    """The merge button posts a night-RUN id, and a night run earned it by
    being verified in its worktree first. A spinoff branch has had no gate run
    against it, so a one-tap merge here would ship unverified work."""
    _, branch = _branch_with_work()

    card = next(r for r in client.get("/api/nightcrew").get_json()["runs"]
                if r.get("branch") == branch)

    assert card["id"].startswith("branch:")
    assert "test_tail" not in card
