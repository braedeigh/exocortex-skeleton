"""routes/triage.py — the 🧭 Triage door on the Todos page.

Opening triage writes a brief that points at the skill file in TRIAGE_DIR and
mints a PERSONAL-room Observatory conversation through routes/spinoff.py's
shared door. A second open rejoins the same live conversation. No tmux, no
claude process is ever spawned here: the runner launch is recorded, not run.
"""
import pytest
from flask import Flask

import store
from routes import spinoff, triage


@pytest.fixture
def triage_client(data_dir, monkeypatch):
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    monkeypatch.setattr(store, "TRIAGE_DIR", data_dir / "triage")
    launches = []
    monkeypatch.setattr(spinoff.subprocess, "Popen",
                        lambda argv, **kw: launches.append(argv) or object())
    monkeypatch.delenv("EXOCORTEX_CONV_ID", raising=False)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    triage.register(app)
    client = app.test_client()
    client._launches = launches
    return client


def test_open_writes_brief_pointing_at_the_skill(triage_client, data_dir):
    r = triage_client.post("/api/triage/open", json={})
    assert r.status_code == 200
    brief = (data_dir / "spinoffs" / "triage" / "BRIEF.md").read_text()
    assert str(data_dir / "triage" / "CLAUDE.md") in brief
    assert "## Protocol" in brief


def test_open_mints_personal_room_session_and_starts_it(triage_client):
    body = triage_client.post("/api/triage/open", json={}).get_json()
    assert body["newly_spawned"] is True
    assert body["lane"] == "personal"
    entry = store.read("bot_chats/index", {})[body["conversation_id"]]
    assert entry["spinoff_slug"] == "triage"
    assert entry["lane"] == "personal"
    assert len(triage_client._launches) == 1


def test_second_open_rejoins_the_live_conversation(triage_client):
    first = triage_client.post("/api/triage/open", json={}).get_json()
    second = triage_client.post("/api/triage/open", json={}).get_json()
    assert second["conversation_id"] == first["conversation_id"]
    assert second["newly_spawned"] is False
    assert len(store.read("bot_chats/index", {})) == 1
