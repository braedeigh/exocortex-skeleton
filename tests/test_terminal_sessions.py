"""Session-list routes in routes/terminal.py: worker listing, titles, and the
rw-* name guard. tmux is faked (no real sessions are touched); titles go
through store.py so the data_dir fixture isolates them."""
from types import SimpleNamespace

import pytest

import store
from routes import terminal


def fake_tmux(cmd):
    if cmd.startswith("list-panes"):
        return SimpleNamespace(stdout="1\n")
    if cmd.startswith("capture-pane"):
        return SimpleNamespace(stdout="$ echo hi\nhi\n")
    if cmd.startswith("list-sessions"):
        return SimpleNamespace(stdout="chat\nrw-worker-1\n")
    return SimpleNamespace(stdout="")


@pytest.fixture
def client(data_dir, tmp_path, monkeypatch):
    from flask import Flask
    monkeypatch.setattr(terminal, "SESSIONS_PATH", tmp_path / "sessions.json")
    monkeypatch.setattr(terminal, "_tmux", fake_tmux)
    monkeypatch.setattr(terminal, "_live_claude_sessions", lambda: [])
    # The worker list is TTL-cached module-globally — start each test cold.
    monkeypatch.setattr(terminal, "_workers_cache", {"at": 0.0, "names": []})
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terminal.register(app)
    return app.test_client()


def test_rw_names_are_reserved_for_workers(client):
    resp = client.post("/api/sessions", json={"name": "rw-sneaky"})
    assert resp.status_code == 400
    assert "reserved" in resp.get_json()["error"]


def test_sessions_payload_includes_workers_and_titles(client):
    data = client.get("/api/sessions").get_json()
    assert data["workers"] == ["rw-worker-1"]
    assert data["titles"] == {}


def test_recaps_include_live_workers_flagged(client):
    data = client.get("/api/terminal/recaps").get_json()["sessions"]
    assert data["rw-worker-1"]["worker"] is True
    assert data["chat"]["worker"] is False
    # No claude in the fake pane -> pane-tail fallback, no error.
    assert data["rw-worker-1"]["source"] == "pane"
    assert data["rw-worker-1"]["error"] is None


def test_title_set_and_clear_roundtrip(client):
    client.post("/api/sessions", json={"name": "scratch"})
    resp = client.post("/api/sessions/title", json={"name": "scratch", "title": "My Scratchpad"})
    assert resp.get_json()["titles"] == {"scratch": "My Scratchpad"}
    assert client.get("/api/sessions").get_json()["titles"] == {"scratch": "My Scratchpad"}
    resp = client.post("/api/sessions/title", json={"name": "scratch", "title": ""})
    assert resp.get_json()["titles"] == {}


def test_title_for_unknown_session_404s(client):
    resp = client.post("/api/sessions/title", json={"name": "nope", "title": "X"})
    assert resp.status_code == 404


def test_deleting_a_session_drops_its_title(client):
    client.post("/api/sessions", json={"name": "temp"})
    client.post("/api/sessions/title", json={"name": "temp", "title": "Temp Stuff"})
    resp = client.delete("/api/sessions", json={"name": "temp"})
    assert resp.status_code == 200
    assert store.read("session_titles", {}) == {}
