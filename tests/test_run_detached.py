"""scripts/run_detached.py — a background job that wakes its session when done.

The bug these pin: a job started "in the background" from an Observatory turn
died when the turn ended, and nothing woke the session to read its result. The
watcher now runs the job in its own process session and queues exactly one
System follow-up into the conversation when it exits.

The follow-up queue itself is covered in test_followups.py; here it's faked
(`woken` records each call), so these assert on what the watcher reports.
"""
import io
import json
import os
import shlex
import subprocess
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


# --- the hook: background Bash becomes a detached job ------------------------

def _bash_event(**tool_input):
    return {"tool_name": "Bash", "tool_input": tool_input}


def test_background_bash_is_rewritten_into_a_detached_launch():
    new = run_detached.rewrite_background_call(
        _bash_event(command="pytest -q && echo ok", description="run tests",
                    run_in_background=True, timeout=600000), "2026-09-27.160524")
    assert new["run_in_background"] is False and new["timeout"] == 600000
    argv = shlex.split(new["command"])
    assert argv[1].endswith("run_detached.py")
    assert argv[argv.index("--label") + 1] == "run tests"
    assert argv[argv.index("--") + 1:] == ["bash", "-c", "pytest -q && echo ok"]


def test_foreground_bash_is_left_alone():
    assert run_detached.rewrite_background_call(
        _bash_event(command="ls"), "2026-09-27.160524") is None


def test_without_a_conversation_nothing_is_rewritten():
    assert run_detached.rewrite_background_call(
        _bash_event(command="sleep 60", run_in_background=True), None) is None


def test_the_hook_fails_open_on_a_garbled_event(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("not json"))
    assert run_detached.hook() == 0
    assert capsys.readouterr().out == ""


def test_the_rewritten_command_really_launches_a_detached_job(jobs_dir, monkeypatch):
    """What the agent's shell would run after the rewrite: it returns at once
    with the launch line, and the original command runs on its own."""
    new = run_detached.rewrite_background_call(
        _bash_event(command="echo from-the-shell", run_in_background=True),
        "2026-01-01.000000")
    env = dict(os.environ, EXOCORTEX_JOBS_DIR=str(jobs_dir),
               EXOCORTEX_CONV_ID="2026-01-01.000000")
    out = subprocess.run(new["command"], shell=True, env=env, capture_output=True,
                         text=True, timeout=30)
    launched = json.loads(out.stdout)
    meta_path = jobs_dir / launched["job"] / "meta.json"
    deadline = time.time() + 30
    while time.time() < deadline and "wake" not in json.loads(meta_path.read_text()):
        time.sleep(0.2)
    assert "from-the-shell" in (jobs_dir / launched["job"] / "output.log").read_text()


def test_session_settings_carry_the_hook_only_with_a_conversation():
    tools = list(observatory._BUILDER_TOOLS)
    with_conv = observatory._session_settings({"conv_id": "2026-09-27.160524"}, tools)
    commands = [h["command"] for entry in with_conv["hooks"]["PreToolUse"]
                for h in entry["hooks"]]
    assert any(c.endswith("run_detached.py --hook") for c in commands)
    assert any("act_ask_gate.py" in c for c in commands)      # the gate is still there
    without = observatory._session_settings({}, tools)
    assert not any("run_detached" in h["command"]
                   for entry in without.get("hooks", {}).get("PreToolUse", [])
                   for h in entry["hooks"])


# --- the sweep: a job whose watcher died still reports back ------------------

def _unfinished(jobs_dir, **meta):
    job_dir = _job(jobs_dir, ["sleep", "999"])
    record = run_detached._read_meta(job_dir)
    record.update(meta)
    run_detached._write_meta(job_dir, record)
    (job_dir / "output.log").write_text("collected 4776 items\n.....\n")
    return job_dir


def test_a_job_cut_off_by_a_reboot_wakes_its_session_once(jobs_dir, woken):
    _unfinished(jobs_dir, watcher_pid=os.getpid(), boot_id="an-earlier-boot",
                started_epoch=time.time() - 600)
    assert run_detached.sweep() == ["j1"]
    [(conv_id, text, system)] = woken
    assert "machine restarted" in text and "collected 4776 items" in text
    assert "interrupted" in system["display"]
    assert run_detached.sweep() == []          # marked, so never twice


def test_a_killed_watcher_is_noticed(jobs_dir, woken):
    dead = subprocess.Popen(["true"])
    dead.wait()
    _unfinished(jobs_dir, watcher_pid=dead.pid, boot_id=run_detached._boot_id())
    assert run_detached.sweep() == ["j1"]
    assert "watcher process was killed" in woken[0][1]


def test_a_running_watcher_is_left_alone(jobs_dir, woken):
    job_dir = _job(jobs_dir, [sys.executable, "-c", "import time; time.sleep(5)"])
    watcher = subprocess.Popen([sys.executable, run_detached.__file__, "--watch",
                                str(job_dir)], env=dict(os.environ))
    try:
        deadline = time.time() + 10
        while time.time() < deadline and "watcher_pid" not in run_detached._read_meta(job_dir):
            time.sleep(0.1)
        assert run_detached.sweep() == [] and woken == []
    finally:
        watcher.kill()
        watcher.wait()


def test_a_just_launched_job_gets_time_to_check_in(jobs_dir, woken):
    _unfinished(jobs_dir, queued_epoch=time.time())
    assert run_detached.sweep() == []
    assert run_detached.sweep(now=time.time() + 3600) == ["j1"]
    assert "never started" in woken[0][1]


def test_a_finished_job_is_never_swept(jobs_dir, woken):
    run_detached.watch(_job(jobs_dir, [sys.executable, "-c", "pass"]))
    woken.clear()
    assert run_detached.sweep(now=time.time() + 3600) == [] and woken == []


def test_a_finishing_watcher_and_the_sweep_never_both_wake(jobs_dir, woken):
    """The race: the sweep read meta.json just before the watcher wrote
    finished_at, then saw the watcher gone and woke the session a second
    time. While the watcher holds the job's lock, the sweep keeps its hands
    off, and once it lets go the sweep re-reads before deciding."""
    dead = subprocess.Popen(["true"])
    dead.wait()
    job_dir = _unfinished(jobs_dir, watcher_pid=dead.pid, boot_id=run_detached._boot_id())
    lock = run_detached._take_lock(job_dir, wait=False)
    try:
        assert run_detached.sweep() == [] and woken == []
        record = run_detached._read_meta(job_dir)          # the watcher finishes
        record["finished_at"] = "2026-09-28 12:00:00"
        run_detached._write_meta(job_dir, record)
    finally:
        lock.close()
    assert run_detached.sweep() == [] and woken == []


# --- running_jobs: what the deploy/reboot guard counts ----------------------

def test_running_jobs_counts_a_job_whose_watcher_is_alive(jobs_dir, woken):
    job_dir = _job(jobs_dir, [sys.executable, "-c", "import time; time.sleep(5)"])
    watcher = subprocess.Popen([sys.executable, run_detached.__file__, "--watch",
                                str(job_dir)], env=dict(os.environ))
    try:
        deadline = time.time() + 10
        while time.time() < deadline and "watcher_pid" not in run_detached._read_meta(job_dir):
            time.sleep(0.1)
        [job] = run_detached.running_jobs()
        assert job["id"] == "j1" and job["conv_id"] == "2026-09-27.160524"
    finally:
        watcher.kill()
        watcher.wait()


def test_running_jobs_skips_finished_and_dead_ones(jobs_dir, woken):
    run_detached.watch(_job(jobs_dir, [sys.executable, "-c", "pass"]))
    assert run_detached.running_jobs() == []
    dead = subprocess.Popen(["true"])
    dead.wait()
    job_dir = jobs_dir / "j1"
    record = run_detached._read_meta(job_dir)
    record.pop("finished_at")
    record["watcher_pid"] = dead.pid
    run_detached._write_meta(job_dir, record)
    assert run_detached.running_jobs() == []
