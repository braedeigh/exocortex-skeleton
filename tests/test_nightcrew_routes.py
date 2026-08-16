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

import devnote_judgments
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
def go_live_calls(monkeypatch):
    """Stub the go-live thread with a recorder — a unit test must never run a
    real npm build or signal a real gunicorn master."""
    calls = []
    monkeypatch.setattr(nightcrew, "_start_go_live", calls.append)
    return calls


@pytest.fixture
def repo(tmp_path, monkeypatch, go_live_calls):
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
    n = store.read("dev_notes.json", {})["tabs"]["today"][0]
    assert devnote_judgments.current(n) == "approved"
    assert devnote_judgments.is_green_lit(n) is True


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


def test_merge_records_the_commit_and_kicks_go_live(client, repo, go_live_calls):
    """The sha is what /revert undoes later, and go-live is what makes
    "approve" actually mean approve — losing either reopens the 6 AM
    merged-but-not-live gap."""
    _seed_run()
    body = client.post("/api/nightcrew/runs/r1/merge").get_json()
    assert body["ok"] is True
    run = store.read("night_runs.json", {})["runs"][0]
    head = _git(repo, "rev-parse", "HEAD").stdout.strip()
    assert run["merge_commit"] == head
    assert go_live_calls == ["r1"]


# --- the revert door --------------------------------------------------------

def _merged(client, repo):
    """Merge the seeded run for real and hand back its stored record."""
    _seed_run()
    assert client.post("/api/nightcrew/runs/r1/merge").get_json()["ok"] is True
    return store.read("night_runs.json", {})["runs"][0]


def test_revert_undoes_the_merge_and_goes_live(client, repo, go_live_calls):
    _merged(client, repo)
    body = client.post("/api/nightcrew/runs/r1/revert").get_json()
    assert body["ok"] is True
    assert not (repo / "b.txt").exists(), "the merge's file is gone from main"
    run = store.read("night_runs.json", {})["runs"][0]
    assert run["status"] == "reverted"
    assert go_live_calls == ["r1", "r1"], "both the merge and the revert go live"


def test_revert_keeps_the_branch_for_another_look(client, repo):
    _merged(client, repo)
    client.post("/api/nightcrew/runs/r1/revert")
    assert _git(repo, "rev-parse", "--verify", "agent/n1").returncode == 0


def test_revert_refuses_a_run_that_is_not_merged(client, repo):
    _seed_run()   # still ready
    assert client.post("/api/nightcrew/runs/r1/revert").status_code == 409


def test_revert_refuses_a_run_without_a_recorded_commit(client, repo):
    """Old merged records predate the sha — reverting them by guesswork is
    exactly the sure-footedness this door must not fake."""
    _seed_run(status="merged")
    res = client.post("/api/nightcrew/runs/r1/revert")
    assert res.status_code == 409
    assert "predates" in res.get_json()["error"]


def test_revert_refuses_a_dirty_tree(client, repo):
    _merged(client, repo)
    (repo / "a.txt").write_text("her uncommitted edit\n")
    res = client.post("/api/nightcrew/runs/r1/revert")
    assert res.status_code == 409
    assert "uncommitted" in res.get_json()["error"]
    assert (repo / "b.txt").exists(), "nothing was reverted"


def test_conflicting_revert_aborts_with_nothing_changed(client, repo):
    """Her own commit on top of the merged file makes the revert a
    conversation — the door must abort and leave the tree exactly as-is."""
    _merged(client, repo)
    (repo / "b.txt").write_text("her edit on top of the crew's fix\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "her follow-up")
    res = client.post("/api/nightcrew/runs/r1/revert")
    assert res.status_code == 409
    assert (repo / "b.txt").read_text() == "her edit on top of the crew's fix\n"
    assert not (repo / ".git" / "REVERT_HEAD").exists()
    assert store.read("night_runs.json", {})["runs"][0]["status"] == "merged"


# --- her feedback on a card --------------------------------------------------

def test_feedback_lands_on_the_run_record(client):
    _seed_run()
    res = client.post("/api/nightcrew/runs/r1/feedback",
                      json={"note": "wanted the button gone, not moved"})
    assert res.get_json()["ok"] is True
    assert store.read("night_runs.json", {})["runs"][0]["her_note"] \
        == "wanted the button gone, not moved"


def test_feedback_requires_a_note_and_a_real_run(client):
    _seed_run()
    assert client.post("/api/nightcrew/runs/r1/feedback", json={}).status_code == 400
    assert client.post("/api/nightcrew/runs/nope/feedback",
                       json={"note": "x"}).status_code == 404


# --- judging a picked card ---------------------------------------------------

def _seed_pick():
    store.write("dev_notes.json", {"tabs": {"today": [
        {"id": "n1", "text": "Add a search for to-dos", "created": "2026-05-01 09:00"},
    ]}})
    store.write("night_runs.json", {"runs": [
        {"id": "p1", "status": "picked", "note_id": "n1", "tab": "today",
         "note_text": "Add a search for to-dos"},
    ]})


def test_approving_a_pick_records_without_mooning(client):
    """Approval is judgment data, not a work order — the note stays unmooned
    until she turns making on, so the picking phase can't quietly spend
    tokens."""
    _seed_pick()
    body = client.post("/api/nightcrew/runs/p1/pick",
                       json={"verdict": "approve", "note": "yes, this kind"}).get_json()
    assert body["ok"] is True
    run = store.read("night_runs.json", {})["runs"][0]
    assert run["verdict"] == "approve"
    assert run["her_note"] == "yes, this kind"
    assert run["dismissed"] is True, "judged is answered — off the stack"
    n = store.read("dev_notes.json", {})["tabs"]["today"][0]
    assert devnote_judgments.current(n) == "approved"


def test_rejecting_a_pick_reaches_the_note_as_unsure(client):
    """"Not this" must reach the NOTE, not just the run record — the
    nominator's never-propose-an-answered-note rule is what makes it stick.

    It lands as `unsure`, not `denied`: this card has two buttons, so "not
    this" carries both "don't want it" and "can't tell what this is", and the
    recorded reasons say it's mostly the second. Still answered (so it isn't
    re-proposed), but she can bring it back by editing the note."""
    _seed_pick()
    body = client.post("/api/nightcrew/runs/p1/pick",
                       json={"verdict": "reject"}).get_json()
    assert body["ok"] is True
    n = store.read("dev_notes.json", {})["tabs"]["today"][0]
    assert devnote_judgments.current(n) == "unsure"
    assert devnote_judgments.is_answered(n) is True


def test_pick_verdict_refuses_non_picked_runs_and_junk(client):
    _seed_run()   # a ready run, not a pick
    assert client.post("/api/nightcrew/runs/r1/pick",
                       json={"verdict": "approve"}).status_code == 409
    _seed_pick()
    assert client.post("/api/nightcrew/runs/p1/pick",
                       json={"verdict": "shrug"}).status_code == 400
    assert client.post("/api/nightcrew/runs/nope/pick",
                       json={"verdict": "approve"}).status_code == 404


def test_picked_cards_sort_after_ready_before_failed(client):
    store.write("dev_notes.json", {"tabs": {}})
    store.write("night_runs.json", {"runs": [
        {"id": "r-f", "note_id": "a", "status": "failed", "finished": "2026-08-05T01:00:00"},
        {"id": "p-1", "note_id": "b", "status": "picked", "finished": "2026-08-05T02:00:00"},
        {"id": "r-r", "note_id": "c", "status": "ready", "finished": "2026-08-05T03:00:00"},
    ]})
    order = [r["id"] for r in client.get("/api/nightcrew").get_json()["runs"]]
    assert order == ["r-r", "p-1", "r-f"]


# --- go-live itself ----------------------------------------------------------

def test_go_live_build_failure_lands_on_the_card_as_stuck(data_dir, monkeypatch):
    store.write("night_runs.json", {"runs": [{"id": "r1", "status": "merged"}]})
    monkeypatch.setattr(nightcrew.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(
                            a, 1, stdout="", stderr="vite: boom"))
    nightcrew._go_live("r1")
    live = store.read("night_runs.json", {})["runs"][0]["live"]
    assert live.startswith("stuck")
    assert "boom" in live


def test_go_live_success_reloads_and_marks_live(data_dir, monkeypatch):
    store.write("night_runs.json", {"runs": [{"id": "r1", "status": "merged"}]})
    monkeypatch.setattr(nightcrew.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="ok", stderr=""))
    signals = []
    monkeypatch.setattr(nightcrew.os, "getppid", lambda: 4242)
    monkeypatch.setattr(nightcrew.os, "kill", lambda pid, sig: signals.append((pid, sig)))
    nightcrew._go_live("r1")
    assert signals == [(4242, nightcrew.signal.SIGHUP)]
    assert store.read("night_runs.json", {})["runs"][0]["live"] == "live"


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


# --- the reload waits for the room to go quiet -------------------------------
# Approve rebuilds and then SIGHUPs gunicorn, which replaces every worker. A
# live turn's relay thread lives INSIDE a worker, so reloading mid-turn cuts
# the reply off half-written and strands `running: true` forever. Tapping
# Approve is not a request to stop whatever else is talking.

def _running_conv(**extra):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    entry = {"running": True, "last_at": datetime.now().isoformat(timespec="seconds")}
    entry.update(extra)
    store.write("bot_chats/index", {"c1": entry})


def test_go_live_holds_the_reload_while_a_turn_is_running(data_dir, monkeypatch):
    store.write("night_runs.json", {"runs": [{"id": "r1", "status": "merged"}]})
    _running_conv()
    monkeypatch.setattr(nightcrew.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="ok", stderr=""))
    monkeypatch.setattr(nightcrew, "_QUIET_WAIT_SEC", 0)
    signals = []
    monkeypatch.setattr(nightcrew.os, "getppid", lambda: 4242)
    monkeypatch.setattr(nightcrew.os, "kill", lambda pid, sig: signals.append((pid, sig)))

    nightcrew._go_live("r1")

    assert signals == [], "a live turn must not be reloaded out from under"
    live = store.read("night_runs.json", {})["runs"][0]["live"]
    assert "held" in live
    assert live != "live", "the card must not claim live when it isn't"


def test_go_live_reloads_once_the_last_turn_finishes(data_dir, monkeypatch):
    """The wait is a wait, not a refusal: the reload lands as soon as the room
    empties."""
    store.write("night_runs.json", {"runs": [{"id": "r1", "status": "merged"}]})
    monkeypatch.setattr(nightcrew.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="ok", stderr=""))
    busy = iter([2, 1, 0])
    monkeypatch.setattr(nightcrew, "_live_turn_count", lambda: next(busy))
    monkeypatch.setattr(nightcrew.time, "sleep", lambda s: None)
    signals = []
    monkeypatch.setattr(nightcrew.os, "getppid", lambda: 4242)
    monkeypatch.setattr(nightcrew.os, "kill", lambda pid, sig: signals.append((pid, sig)))

    nightcrew._go_live("r1")

    assert signals == [(4242, nightcrew.signal.SIGHUP)]
    assert store.read("night_runs.json", {})["runs"][0]["live"] == "live"


def test_a_stale_running_flag_cannot_hold_the_reload_hostage(data_dir):
    """The count judges by _effective_running, not the bare flag — otherwise a
    session stranded by an earlier crash would block every future merge."""
    _running_conv(last_at=(datetime.now() - timedelta(hours=3)).isoformat(timespec="seconds"))
    assert nightcrew._live_turn_count() == 0


def test_a_live_turn_is_counted(data_dir):
    _running_conv()
    assert nightcrew._live_turn_count() == 1
