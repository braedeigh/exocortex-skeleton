"""routes/spinoff.py — the shared spawn door for /spinoff.

Mirrors test_person_routes.py's session-spawning contract tests: a minimal
Flask app registering only `spinoff`, ensure_claude_session/send_prompt
monkeypatched to record calls instead of touching tmux, and store.SPINOFF_DIR
pointed at a tmp_path via the data_dir-style fixture below.
"""
import json

import pytest
from flask import Flask

import store
from routes import spinoff


@pytest.fixture
def spinoff_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "SPINOFF_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def client(spinoff_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    spinoff.register(app)
    return app.test_client()


def _post(client, slug):
    return client.post("/api/spinoff/open", data=json.dumps({"slug": slug}),
                       content_type="application/json")


def _write_brief(spinoff_dir, slug, text="Do the thing.\n"):
    d = spinoff_dir / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "BRIEF.md").write_text(text)


def test_bad_slug_400(client):
    r = _post(client, "NOT-A-SLUG")
    assert r.status_code == 400
    assert r.get_json() == {"error": "bad slug"}


def test_missing_brief_400_and_no_spawn_attempted(client, spinoff_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(spinoff.shared, "ensure_claude_session",
                         lambda *a, **k: calls.append(("ensure", a, k)) or True)
    r = _post(client, "some-slug")
    assert r.status_code == 400
    assert r.get_json()["error"] == f"no brief at {spinoff_dir / 'some-slug' / 'BRIEF.md'}"
    assert calls == []


def test_valid_slug_spawns_session_and_sends_kickoff_with_brief_path(client, spinoff_dir, monkeypatch):
    _write_brief(spinoff_dir, "cool-idea")
    calls = {}

    def fake_ensure(name, cwd, dirs=()):
        calls["ensure"] = (name, cwd, dirs)
        return True

    def fake_send(session, text, delay=4.0, block=False):
        calls["send"] = (session, text)

    monkeypatch.setattr(spinoff.shared, "ensure_claude_session", fake_ensure)
    monkeypatch.setattr(spinoff.shared, "send_prompt", fake_send)

    r = _post(client, "cool-idea")
    assert r.status_code == 200
    brief_path = str(spinoff_dir / "cool-idea" / "BRIEF.md")
    assert r.get_json() == {
        "ok": True, "session": "spin-cool-idea",
        "newly_spawned": True, "brief": brief_path,
    }
    assert calls["ensure"][0] == "spin-cool-idea"
    assert calls["send"][0] == "spin-cool-idea"
    assert brief_path in calls["send"][1]


def test_already_running_session_skips_kickoff(client, spinoff_dir, monkeypatch):
    _write_brief(spinoff_dir, "already-up")
    send_calls = []
    monkeypatch.setattr(spinoff.shared, "ensure_claude_session", lambda *a, **k: False)
    monkeypatch.setattr(spinoff.shared, "send_prompt",
                         lambda *a, **k: send_calls.append((a, k)))

    r = _post(client, "already-up")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["newly_spawned"] is False
    assert send_calls == []


def test_memory_guard_raises_503(client, spinoff_dir, monkeypatch):
    _write_brief(spinoff_dir, "no-room")

    def fake_ensure(*a, **k):
        raise RuntimeError("refusing to spawn Claude session 'spin-no-room': only 100MB available")

    monkeypatch.setattr(spinoff.shared, "ensure_claude_session", fake_ensure)
    r = _post(client, "no-room")
    assert r.status_code == 503
    assert "refusing to spawn" in r.get_json()["error"]
