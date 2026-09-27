"""scripts/run_detached.py — a background job that wakes its session when done.

The bug these pin: a job started "in the background" from an Observatory turn
died when the turn ended, and nothing woke the session to read its result. The
watcher now runs the job in its own process session and queues exactly one
System follow-up into the conversation when it exits.

The follow-up queue itself is covered in test_followups.py; here it's faked
(`woken` records each call), so these assert on what the watcher reports.
"""
import json
import os
import sys
import time

import pytest

from routes import observatory
from scripts import run_detached


@pytest.fixture
def jobs_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(run_detached, "JOBS_DIR", tmp_path / "jobs")
    return tmp_path / "jobs"


@pytest.fixture
def woken(monkeypatch):
    """Every wake-up the watcher queues, as (conv_id, text, system)."""
    calls = []

    def _fake_queue(conv_id, text, record=False, decision=None, system=None):
        calls.append((conv_id, text, system))
        return "sent"

    monkeypatch.setattr(observatory, "queue_followup", _fake_queue)
    return calls


def _job(jobs_dir, argv, conv_id="2026-09-27.160524", label="job"):
    """Write a job folder the way launch() does, without starting a watcher."""
    job_dir = jobs_dir / "j1"
    job_dir.mkdir(parents=True)
    run_detached._write_meta(job_dir, {
        "id": "j1", "conv_id": conv_id, "argv": argv, "label": label,
        "cwd": str(jobs_dir), "log": str(job_dir / "output.log")})
    return job_dir


def test_a_finished_job_wakes_its_conversation_once(jobs_dir, woken):
    job_dir = _job(jobs_dir, [sys.executable, "-c", "print('all 12 passed')"])
    meta = run_detached.watch(job_dir)
    assert meta["exit_code"] == 0 and meta["wake"] == "sent"
    [(conv_id, text, system)] = woken
    assert conv_id == "2026-09-27.160524"
    assert "all 12 passed" in text and "exit 0" in text
    assert system["source"] == "run_detached" and system["item_id"] == "j1"


def test_a_failing_job_reports_its_exit_code(jobs_dir, woken):
    job_dir = _job(jobs_dir, [sys.executable, "-c", "import sys; sys.exit(3)"])
    run_detached.watch(job_dir)
    assert "exit 3" in woken[0][2]["display"]


def test_a_command_that_cannot_start_still_wakes_with_the_reason(jobs_dir, woken):
    job_dir = _job(jobs_dir, ["/no/such/command"])
    meta = run_detached.watch(job_dir)
    assert meta["exit_code"] is None
    assert "couldn't start" in woken[0][1]


def test_a_failed_wake_is_recorded_not_raised(jobs_dir, monkeypatch):
    def _boom(*args, **kwargs):
        raise RuntimeError("queue unavailable")
    monkeypatch.setattr(observatory, "queue_followup", _boom)
    meta = run_detached.watch(_job(jobs_dir, [sys.executable, "-c", "pass"]))
    assert meta["wake"].startswith("failed:")


def test_the_wake_message_carries_only_the_log_tail(jobs_dir, woken):
    script = "for i in range(500): print('line', i)"
    run_detached.watch(_job(jobs_dir, [sys.executable, "-c", script]))
    text = woken[0][1]
    assert "line 499" in text and "line 0\n" not in text


def test_launch_refuses_without_a_conversation(jobs_dir, monkeypatch, capsys):
    monkeypatch.delenv("EXOCORTEX_CONV_ID", raising=False)
    assert run_detached.main(["--", "true"]) == 2
    assert "EXOCORTEX_CONV_ID" in json.loads(capsys.readouterr().out)["error"]
    assert not jobs_dir.exists()


def test_launch_detaches_the_watcher_and_it_runs_to_the_end(jobs_dir):
    """End to end: a real watcher process, in its own session, finishing on
    its own. Its wake-up goes to a conversation that doesn't exist in the
    throwaway data dir, so it's dropped — what's asserted is that it ran."""
    info = run_detached.launch([sys.executable, "-c", "import time; time.sleep(1); print('done')"],
                               "2026-01-01.000000", label="sleepy")
    assert os.getsid(info["watcher_pid"]) != os.getsid(0)
    meta_path = jobs_dir / info["job"] / "meta.json"
    deadline = time.time() + 30
    while time.time() < deadline:
        meta = json.loads(meta_path.read_text())
        if "wake" in meta:
            break
        time.sleep(0.2)
    assert meta["exit_code"] == 0 and "wake" in meta
    assert "done" in (jobs_dir / info["job"] / "output.log").read_text()
