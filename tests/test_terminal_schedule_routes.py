"""HTTP contract for the scheduled-prompt queue: /api/terminal/schedule*.

These routes only manage the job queue (scheduled_prompts.json) — the actual
firing happens in scripts/prompt_dispatcher.py (see test_prompt_dispatcher.py),
which is meant to be cron'd separately.
"""
from datetime import datetime, timedelta

import pytest
from flask import Flask

import store
from routes import terminal


AT_FORMAT = "%Y-%m-%d %H:%M"


def _future(minutes=60):
    return (datetime.now() + timedelta(minutes=minutes)).strftime(AT_FORMAT)


def _past(minutes=60):
    return (datetime.now() - timedelta(minutes=minutes)).strftime(AT_FORMAT)


@pytest.fixture
def sched_client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terminal.register(app)
    return app.test_client()


def _add(client, **overrides):
    body = {"session": "research2", "prompt": "keep going on the thing", "at": _future()}
    body.update(overrides)
    return client.post("/api/terminal/schedule/add", json=body)


def _jobs():
    return store.read("scheduled_prompts.json", {"jobs": []}).get("jobs", [])


# --- add: validation ---------------------------------------------------------

def test_add_rejects_past_time(sched_client):
    resp = _add(sched_client, at=_past())
    assert resp.status_code == 400
    assert _jobs() == []


def test_add_rejects_unparsable_time(sched_client):
    resp = _add(sched_client, at="tomorrow morning")
    assert resp.status_code == 400
    assert _jobs() == []


@pytest.mark.parametrize("bad_session", [
    "research_2",      # underscore not allowed
    "research 2",      # space
    "research; rm -rf /",  # injection attempt
    "",
    "x" * 31,          # over the length cap
])
def test_add_rejects_bad_session_name(sched_client, bad_session):
    resp = _add(sched_client, session=bad_session)
    assert resp.status_code == 400
    assert _jobs() == []


def test_add_lowercases_session_name(sched_client):
    # Same normalize-then-validate convention as /api/sessions POST.
    resp = _add(sched_client, session="Research2")
    assert resp.status_code == 200
    assert resp.get_json()["job"]["session"] == "research2"


def test_add_rejects_empty_prompt(sched_client):
    resp = _add(sched_client, prompt="   ")
    assert resp.status_code == 400
    assert _jobs() == []


def test_add_accepts_valid_job_and_persists_pending(sched_client):
    resp = _add(sched_client)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["ok"] is True
    job = data["job"]
    assert job["session"] == "research2"
    assert job["prompt"] == "keep going on the thing"
    assert job["status"] == "pending"
    assert job["sent_at"] is None
    assert job["id"]
    jobs = _jobs()
    assert len(jobs) == 1
    assert jobs[0]["id"] == job["id"]


def test_list_returns_newest_first(sched_client):
    store.write("scheduled_prompts.json", {"jobs": [
        {"id": "2026-07-01.0900", "session": "chat", "prompt": "a", "at": _future(),
         "status": "pending", "created": "2026-07-01 09:00", "sent_at": None},
        {"id": "2026-07-02.0900", "session": "chat", "prompt": "b", "at": _future(),
         "status": "pending", "created": "2026-07-02 09:00", "sent_at": None},
    ]})
    resp = sched_client.get("/api/terminal/schedule")
    assert resp.status_code == 200
    ids = [j["id"] for j in resp.get_json()["jobs"]]
    assert ids == ["2026-07-02.0900", "2026-07-01.0900"]


# --- cancel: state transitions ----------------------------------------------

def test_cancel_transitions_pending_to_cancelled(sched_client):
    job = _add(sched_client).get_json()["job"]
    resp = sched_client.post("/api/terminal/schedule/cancel", json={"id": job["id"]})
    assert resp.status_code == 200
    assert resp.get_json()["job"]["status"] == "cancelled"
    assert _jobs()[0]["status"] == "cancelled"


def test_cancel_rejects_non_pending_job(sched_client):
    job = _add(sched_client).get_json()["job"]
    sched_client.post("/api/terminal/schedule/cancel", json={"id": job["id"]})
    # already cancelled — cancelling again must 400, not silently no-op
    resp = sched_client.post("/api/terminal/schedule/cancel", json={"id": job["id"]})
    assert resp.status_code == 400


def test_cancel_unknown_id_404s(sched_client):
    resp = sched_client.post("/api/terminal/schedule/cancel", json={"id": "nope"})
    assert resp.status_code == 404
