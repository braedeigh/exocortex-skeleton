"""Tests for the overnight worker's decision logic (scripts/nightcrew_run.py).

Plain English: the worker itself spawns Claude and runs the full test suite, so
it can't be exercised end-to-end here. What IS tested is everything that
decides WHETHER and HOW — the memory guard, the skip-what's-already-waiting
rule, how an agent turn is scored into ready/failed/parked, and the branch
sweep's age cutoff, and telling a throttled turn from a declined one. Those
are the parts that can silently drift and cost her
either a wrong diagnosis on a card or a broken morning.

The safety guarantees are asserted as facts about the code (the brief forbids
git-write and systemctl; the worktree lives under /tmp) so that loosening one
has to be a deliberate edit to a test, not an accident.
"""
import os
import subprocess
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts import nightcrew_run as nc  # noqa: E402


# --- the memory guard -------------------------------------------------------

def test_memory_headroom_math_leaves_the_floor_intact():
    """One worker needs its own peak PLUS the floor gunicorn lives in — the
    check is `avail < FLOOR + NEED`, so a box with exactly the floor free must
    not admit anything."""
    assert nc.FLOOR_MB + nc.NEED_MB > nc.FLOOR_MB
    assert nc.NEED_MB >= 900, "an agent plus its verify step peaks near 900MB"


def test_mem_available_reads_a_real_number():
    assert nc.mem_available_mb() > 0


# --- skip what's already waiting -------------------------------------------

def test_note_with_undismissed_run_is_skipped(data_dir):
    import store
    store.write("night_runs.json", {"runs": [
        {"id": "r1", "note_id": "abc", "status": "ready"},
    ]})
    assert nc.already_pending("abc") is True


def test_note_with_dismissed_run_is_attempted_again(data_dir):
    """Once she's cleared the card, the note is fair game — otherwise a single
    failed attempt would retire a note forever."""
    import store
    store.write("night_runs.json", {"runs": [
        {"id": "r1", "note_id": "abc", "status": "failed", "dismissed": True},
    ]})
    assert nc.already_pending("abc") is False


def test_unknown_note_is_not_pending(data_dir):
    import store
    store.write("night_runs.json", {"runs": []})
    assert nc.already_pending("nope") is False


# --- scoring one attempt ----------------------------------------------------

def _stub(monkeypatch, *, touched, green=True, last="", tail="ok", error=None):
    """Drive do_note without git, Claude, or a test run. Each collaborator is
    replaced at the module boundary the real one uses."""
    monkeypatch.setattr(nc, "make_worktree", lambda nid: (nc.Path("/tmp/x"), f"agent/{nid}"))
    monkeypatch.setattr(nc, "drop_worktree", lambda p: None)
    monkeypatch.setattr(nc, "run_agent", lambda *a: ("conv1", 1.25, last, error))
    monkeypatch.setattr(nc, "changed_files", lambda w: touched)
    monkeypatch.setattr(nc, "diff_stat", lambda w: "1 file changed, 2 insertions(+)")
    monkeypatch.setattr(nc, "verify", lambda w: (green, tail))
    monkeypatch.setattr(nc, "commit", lambda w, n: True)


NOTE = {"id": "n1", "tab": "today", "text": "Add a search for to-dos"}


def test_green_run_with_changes_is_ready(monkeypatch):
    _stub(monkeypatch, touched=["frontend/src/x.tsx"], green=True)
    run = nc.do_note(NOTE)
    assert run["status"] == "ready"
    assert run["branch"] == "agent/n1"
    assert run["cost_usd"] == 1.25


def test_red_tests_are_failed_not_ready(monkeypatch):
    """The whole point of this script running the suite: a change that breaks
    tests must never reach her as a mergeable card."""
    _stub(monkeypatch, touched=["routes/todos.py"], green=False, tail="1 failed")
    run = nc.do_note(NOTE)
    assert run["status"] == "failed"
    assert run["test_tail"] == "1 failed"


def test_no_changes_is_parked(monkeypatch):
    _stub(monkeypatch, touched=[], last="I looked but the element already exists.")
    run = nc.do_note(NOTE)
    assert run["status"] == "parked"


def test_parked_line_becomes_the_reason(monkeypatch):
    """The agent's own PARKED sentence is the most useful explanation available,
    so it's lifted onto the card verbatim rather than replaced by boilerplate."""
    _stub(monkeypatch, touched=[],
          last="Looked at it.\nPARKED: the note names a tab that doesn't exist.")
    run = nc.do_note(NOTE)
    assert run["reason"] == "the note names a tab that doesn't exist."


def test_empty_diff_is_parked_even_without_a_parked_line(monkeypatch):
    _stub(monkeypatch, touched=[], last="all done!")
    run = nc.do_note(NOTE)
    assert run["status"] == "parked"
    assert run["reason"] == "made no changes"


def test_a_crash_still_produces_a_card(monkeypatch):
    """A night that attempts a note and produces no record is a night she can't
    audit — every path through do_note returns something."""
    def boom(nid):
        raise RuntimeError("worktree add failed")
    monkeypatch.setattr(nc, "make_worktree", boom)
    run = nc.do_note(NOTE)
    assert run["status"] == "failed"
    assert "worktree add failed" in run["reason"]


def test_worktree_is_always_dropped_even_on_failure(monkeypatch):
    dropped = []
    _stub(monkeypatch, touched=["a.py"], green=False)
    monkeypatch.setattr(nc, "drop_worktree", lambda p: dropped.append(p))
    nc.do_note(NOTE)
    assert dropped, "a failed run must not leave a worktree behind"


# --- the safety guarantees, pinned -----------------------------------------

def test_worktrees_live_under_tmp():
    assert str(nc.WORKTREE_ROOT) == "/tmp"


def test_brief_forbids_git_writes_and_services():
    """These sentences are the worker's whole safety contract. Deleting one
    should require deleting a test, not slip through a reword."""
    for forbidden in ("git commit", "git push", "git merge", "systemctl", "sudo"):
        assert forbidden in nc.BRIEF, f"brief no longer forbids {forbidden!r}"


def test_brief_tells_the_worker_not_to_claim_success():
    assert "DO NOT claim your work passes" in nc.BRIEF


def test_brief_gives_a_parked_escape_hatch():
    assert "PARKED:" in nc.BRIEF


def test_brief_names_the_worktree_so_the_worker_can_self_check():
    filled = nc.BRIEF.format(tab="today", text="x", worktree="/tmp/nightcrew-n1",
                             branch="agent/n1")
    assert "/tmp/nightcrew-n1" in filled
    assert "/opt/exocortex/skeleton" in filled  # named as forbidden


def test_max_notes_is_a_small_number():
    """This is the usage knob — it draws on the same rolling subscription
    window as the 3 AM and 5 AM crons. A jump here should be deliberate."""
    assert 1 <= nc.MAX_NOTES <= 5


# --- branch sweep -----------------------------------------------------------

def test_sweep_deletes_only_branches_past_the_ttl(monkeypatch):
    old = (datetime.now() - timedelta(days=nc.BRANCH_TTL_DAYS + 3)).isoformat()
    new = (datetime.now() - timedelta(days=1)).isoformat()
    deleted = []

    def fake_run(cmd, **kw):
        if "for-each-ref" in cmd:
            return subprocess.CompletedProcess(
                cmd, 0, stdout=f"agent/old {old}\nagent/new {new}\n", stderr="")
        if "branch" in cmd and "-D" in cmd:
            deleted.append(cmd[-1])
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(nc.subprocess, "run", fake_run)
    nc.sweep_old_branches()
    assert deleted == ["agent/old"]


def test_sweep_survives_an_unparseable_date(monkeypatch):
    def fake_run(cmd, **kw):
        if "for-each-ref" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="agent/x notadate\n", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    monkeypatch.setattr(nc.subprocess, "run", fake_run)
    nc.sweep_old_branches()  # must not raise


@pytest.mark.parametrize("status", ["ready", "failed", "parked"])
def test_every_status_the_worker_emits_is_one_the_ui_draws(status):
    """routes/nightcrew.TERMINAL and NightCrewLane's STATUS table must agree
    with what do_note can actually produce, or a card renders blank."""
    from routes.nightcrew import TERMINAL
    assert status in TERMINAL


# --- usage limits: the real ceiling, not money ------------------------------

@pytest.mark.parametrize("err", [
    "API Error: 429 Too Many Requests",
    "Claude usage limit reached",
    "rate_limit_error",
    "Overloaded",
])
def test_throttle_markers_are_recognised(err):
    assert nc.looks_throttled(err) is True


@pytest.mark.parametrize("err", [None, "", "ENOENT: no such file", "test failed"])
def test_ordinary_errors_are_not_throttling(err):
    assert nc.looks_throttled(err) is False


def test_throttled_turn_parks_the_note_rather_than_blaming_it(monkeypatch):
    """A rate-limited turn changes no files — identical on the surface to an
    agent that read the note and sensibly declined. Scoring them the same would
    tell her a note was ambiguous when she was actually just throttled."""
    _stub(monkeypatch, touched=[], error="API Error: 429 Too Many Requests")
    run = nc.do_note(NOTE)
    assert run["status"] == "parked"
    assert run["throttled"] is True
    assert "usage limit" in run["reason"]
    assert "still queued for tomorrow" in run["reason"]


def test_non_throttle_turn_error_is_a_failure_with_the_real_message(monkeypatch):
    _stub(monkeypatch, touched=[], error="spawn ENOENT")
    run = nc.do_note(NOTE)
    assert run["status"] == "failed"
    assert "spawn ENOENT" in run["reason"]


def test_a_clean_turn_is_unaffected_by_the_error_path(monkeypatch):
    _stub(monkeypatch, touched=["a.tsx"], error=None)
    assert nc.do_note(NOTE)["status"] == "ready"


def test_green_run_whose_commit_lands_nothing_is_failed(monkeypatch):
    """The stash-pop hole: if the screenshot step eats the diff, the branch is
    empty — a mergeable card with nothing behind it is the lane's one
    unforgivable lie, so a commit that lands nothing downgrades the run."""
    _stub(monkeypatch, touched=["a.tsx"], green=True)
    monkeypatch.setattr(nc, "commit", lambda w, n: False)
    run = nc.do_note(NOTE)
    assert run["status"] == "failed"
    assert "never reached the branch" in run["reason"]


def test_throttled_note_stays_queued_for_tomorrow(data_dir):
    """A throttled turn attempted nothing, and its card promises "still queued
    for tomorrow" — so the undismissed card must NOT block tomorrow's pickup
    the way a real attempt's card does. The card costs her nothing to ignore."""
    import store
    store.write("night_runs.json", {"runs": [
        {"id": "r1", "note_id": "abc", "status": "parked", "throttled": True},
    ]})
    assert nc.already_pending("abc") is False
