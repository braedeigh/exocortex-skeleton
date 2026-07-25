"""HTTP contract for the Keeper rollover control (routes/reading_room.py's
POST/GET .../keeper/rollover[/status]).

Isolated per-test via the `data_dir` fixture (store.DATA_DIR -> tmp_path), same
as the other route tests. The cross-process lock these routes probe/rely on is
scripts/keeper_rollover.py's own fcntl.flock on bot_chats/rollover.lock — this
file exercises the route side only, holding/releasing that same lock directly
via fcntl to simulate "a rollover is already running" without actually running
one.
"""
import fcntl
import subprocess

import pytest
from flask import Flask

import store
from routes import reading_room


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    reading_room.register(app)
    return app.test_client()


def _lock_path(data_dir):
    return data_dir / "bot_chats" / "rollover.lock"


def test_status_empty_when_unseeded(client):
    resp = client.get("/api/reading-room/keeper/rollover/status")
    assert resp.status_code == 200
    assert resp.get_json() == {"running": False, "pinned_conv_id": None, "registry": None}


def test_status_reflects_pinned_conv_and_registry(client, data_dir):
    (data_dir / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {
        "2026-07-24.090000": {
            "bot": "keeper", "pinned": True, "archived": False,
            "last_at": "2026-07-24T09:00:00",
        },
        "2026-07-24.080000": {
            # older pinned candidate — the newer one above must win
            "bot": "keeper", "pinned": True, "archived": False,
            "last_at": "2026-07-24T08:00:00",
        },
        "2026-07-24.070000": {
            # not pinned — never a candidate
            "bot": "keeper", "pinned": False, "archived": False,
            "last_at": "2026-07-24T09:30:00",
        },
        "2026-07-23.090000": {
            # archived pinned — excluded
            "bot": "keeper", "pinned": True, "archived": "2026-07-24T00:00:00",
            "last_at": "2026-07-23T09:00:00",
        },
    })
    registry_entry = {"id": "keeper_rollover", "name": "Keeper nightly rollover",
                       "enabled": True, "last_run": "2026-07-24T03:00:05",
                       "last_status": "ok", "last_conv_id": "2026-07-24.090000",
                       "last_cost_usd": 0.42}
    store.write("scheduled_runs.json", {"runs": [registry_entry]})

    resp = client.get("/api/reading-room/keeper/rollover/status")
    body = resp.get_json()
    assert body["running"] is False
    assert body["pinned_conv_id"] == "2026-07-24.090000"
    assert body["registry"] == registry_entry


def test_status_alias_route_matches(client):
    resp = client.get("/api/bots/keeper/rollover/status")
    assert resp.status_code == 200
    assert resp.get_json() == {"running": False, "pinned_conv_id": None, "registry": None}


def test_post_returns_202_and_spawns_detached(client, monkeypatch):
    calls = []

    class FakePopen:
        def __init__(self, argv, **kwargs):
            calls.append((argv, kwargs))

    monkeypatch.setattr(subprocess, "Popen", FakePopen)

    resp = client.post("/api/reading-room/keeper/rollover")
    assert resp.status_code == 202
    assert resp.get_json() == {"ok": True, "started": True}

    assert len(calls) == 1
    argv, kwargs = calls[0]
    assert any("keeper_rollover.py" in str(a) for a in argv)
    assert "roll" in argv
    assert kwargs.get("start_new_session") is True
    assert kwargs.get("stderr") is subprocess.STDOUT


def test_post_alias_route_spawns(client, monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **kw: calls.append((argv, kw)))
    resp = client.post("/api/bots/keeper/rollover")
    assert resp.status_code == 202
    assert len(calls) == 1


def test_post_409_when_lock_already_held(client, data_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **kw: calls.append((argv, kw)))

    lock_path = _lock_path(data_dir)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lock_path, "a+")
    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        resp = client.post("/api/reading-room/keeper/rollover")
        assert resp.status_code == 409
        assert resp.get_json() == {"error": "a rollover is already running"}
        assert calls == []   # never spawned

        status = client.get("/api/reading-room/keeper/rollover/status").get_json()
        assert status["running"] is True
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()

    # lock released — status flips back
    status = client.get("/api/reading-room/keeper/rollover/status").get_json()
    assert status["running"] is False
