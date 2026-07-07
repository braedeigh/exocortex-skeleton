"""scripts/prompt_dispatcher.py — the cron-run job that actually fires
scheduled prompts into tmux (routes/terminal.py's /api/terminal/schedule*
routes only manage the queue; this is the "the terminal guns it at that
time" half).

tmux itself is never invoked in these tests — `tmux()` is monkeypatched to
record calls instead, the same pattern tests/test_terminal_routes.py uses for
routes/terminal.py's `_tmux`.
"""
from datetime import datetime, timedelta

import pytest

import store
from scripts import prompt_dispatcher as dispatcher


AT_FORMAT = dispatcher.AT_FORMAT


def _future(minutes=60):
    return (datetime.now() + timedelta(minutes=minutes)).strftime(AT_FORMAT)


def _past(minutes=60):
    return (datetime.now() - timedelta(minutes=minutes)).strftime(AT_FORMAT)


def _job(**overrides):
    job = {
        "id": "2026-07-06.2000",
        "session": "research2",
        "prompt": "keep going on the thing",
        "at": _past(),
        "status": "pending",
        "created": "2026-07-06 20:00",
        "sent_at": None,
    }
    job.update(overrides)
    return job


@pytest.fixture
def dispatch(data_dir, monkeypatch):
    """Isolate DATA_DIR (via the shared `data_dir` fixture) and capture tmux
    calls instead of running them. `has_session` controls whether the faked
    `has-session` probe reports the session already exists."""
    calls = []
    state = {"has_session": False}

    def fake_tmux(cmd_str):
        calls.append(cmd_str)

        class _R:
            returncode = 0 if (state["has_session"] and cmd_str.startswith("has-session")) else (
                1 if cmd_str.startswith("has-session") else 0
            )
        return _R()

    monkeypatch.setattr(dispatcher, "tmux", fake_tmux)
    monkeypatch.setattr(dispatcher, "SETTLE_DELAY", 0)  # don't actually sleep in tests
    dispatcher.calls = calls
    dispatcher.state = state
    return dispatcher


# --- due-job selection --------------------------------------------------

def test_due_jobs_includes_past_due_pending_job(dispatch):
    jobs = [_job(at=_past())]
    assert dispatcher.due_jobs(jobs, datetime.now()) == jobs


def test_due_jobs_excludes_future_job(dispatch):
    jobs = [_job(at=_future())]
    assert dispatcher.due_jobs(jobs, datetime.now()) == []


def test_due_jobs_excludes_non_pending(dispatch):
    jobs = [_job(status="sent"), _job(status="cancelled"), _job(status="error")]
    assert dispatcher.due_jobs(jobs, datetime.now()) == []


def test_due_jobs_excludes_unparsable_at(dispatch):
    jobs = [_job(at="not a date")]
    assert dispatcher.due_jobs(jobs, datetime.now()) == []


# --- process_due_jobs: dispatch + JSON write -----------------------------

def test_sends_prompt_and_marks_job_sent(dispatch):
    store.write("scheduled_prompts.json", {"jobs": [_job()]})
    result = dispatcher.process_due_jobs()
    job = result["jobs"][0]
    assert job["status"] == "sent"
    assert job["sent_at"] is not None
    # persisted, not just returned
    on_disk = store.read("scheduled_prompts.json")["jobs"][0]
    assert on_disk["status"] == "sent"
    # the prompt text was typed in, then Enter
    send_calls = [c for c in dispatch.calls if "send-keys" in c]
    assert any("-l 'keep going on the thing'" in c for c in send_calls)
    assert any(c.endswith("send-keys -t research2 Enter") for c in send_calls)


def test_new_session_is_spawned_cwd_opt_exocortex_and_registered(dispatch):
    dispatch.state["has_session"] = False
    store.write("scheduled_prompts.json", {"jobs": [_job(session="freshsession")]})
    dispatcher.process_due_jobs()
    assert any("new-session -d -s freshsession -c /opt/exocortex 'claude'" in c for c in dispatch.calls)
    assert "freshsession" in store.read("sessions.json", [])


def test_existing_session_is_not_respawned(dispatch):
    dispatch.state["has_session"] = True
    store.write("sessions.json", ["research2"])
    store.write("scheduled_prompts.json", {"jobs": [_job()]})
    dispatcher.process_due_jobs()
    assert not any("new-session" in c for c in dispatch.calls)
    # still got the prompt
    assert any("send-keys" in c and "-l" in c for c in dispatch.calls)


def test_future_job_is_left_pending(dispatch):
    store.write("scheduled_prompts.json", {"jobs": [_job(at=_future())]})
    result = dispatcher.process_due_jobs()
    assert result["jobs"][0]["status"] == "pending"
    assert not dispatch.calls  # never touched tmux


def test_cancelled_job_is_ignored(dispatch):
    store.write("scheduled_prompts.json", {"jobs": [_job(status="cancelled")]})
    dispatcher.process_due_jobs()
    assert not dispatch.calls


# --- one bad job never crashes the batch ---------------------------------

def test_bad_session_name_marks_error_and_continues(dispatch):
    bad = _job(id="a", session="not valid!", at=_past())
    good = _job(id="b", session="research2", at=_past())
    store.write("scheduled_prompts.json", {"jobs": [bad, good]})
    result = dispatcher.process_due_jobs()
    by_id = {j["id"]: j for j in result["jobs"]}
    assert by_id["a"]["status"] == "error"
    assert "error" in by_id["a"]
    assert by_id["b"]["status"] == "sent"


def test_empty_prompt_marks_error(dispatch):
    store.write("scheduled_prompts.json", {"jobs": [_job(prompt="   ")]})
    result = dispatcher.process_due_jobs()
    assert result["jobs"][0]["status"] == "error"


def test_unparsable_at_marks_error_not_silently_skipped(dispatch):
    store.write("scheduled_prompts.json", {"jobs": [_job(at="garbage")]})
    result = dispatcher.process_due_jobs()
    assert result["jobs"][0]["status"] == "error"
    assert "bad 'at' value" in result["jobs"][0]["error"]


def test_tmux_failure_marks_error_not_crash(dispatch, monkeypatch):
    def boom(cmd_str):
        raise RuntimeError("tmux exploded")
    monkeypatch.setattr(dispatcher, "tmux", boom)
    store.write("scheduled_prompts.json", {"jobs": [_job()]})
    result = dispatcher.process_due_jobs()  # must not raise
    assert result["jobs"][0]["status"] == "error"
    assert "tmux exploded" in result["jobs"][0]["error"]


def test_no_due_jobs_does_not_rewrite_file(dispatch):
    store.write("scheduled_prompts.json", {"jobs": [_job(status="sent")]})
    before_mtime = (store.DATA_DIR / "scheduled_prompts.json").stat().st_mtime_ns
    dispatcher.process_due_jobs()
    after_mtime = (store.DATA_DIR / "scheduled_prompts.json").stat().st_mtime_ns
    assert before_mtime == after_mtime


def test_main_runs_without_arguments(dispatch):
    store.write("scheduled_prompts.json", {"jobs": [_job()]})
    dispatcher.main()  # smoke test: entry point cron will actually call
    assert store.read("scheduled_prompts.json")["jobs"][0]["status"] == "sent"
