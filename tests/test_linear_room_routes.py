"""routes/linear_room.py and the `linear` lane in routes/observatory.py:
a session created in the lane stands in the room folder and never asks
(the act gate would stop it on every Linear call), and GET /api/linear-room
lists exactly the lane's sessions — including one that only its folder
places there.

Minimal app (linear_room + observatory registered), the data dir patched per
test, the room folder pointed at a tmp_path.
"""
import pytest
from flask import Flask

import recap_summary
import store
from routes import linear_room, observatory


@pytest.fixture
def room_client(data_dir, tmp_path, monkeypatch):
    room = tmp_path / "linear-room"
    room.mkdir()
    monkeypatch.setattr(store, "LINEAR_ROOM_DIR", room)
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    monkeypatch.setattr(recap_summary, "_spawn", lambda fn: None)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    linear_room.register(app)
    observatory.register(app)
    return app.test_client()


def test_a_linear_session_stands_in_the_room_and_is_never_gated(room_client):
    body = room_client.post("/api/observatory/conversations",
                            json={"title": "plan", "lane": "linear"}).get_json()
    assert body["ok"] and body["lane"] == "linear"
    entry = store.read("bot_chats/index", {})[body["id"]]
    assert entry["cwd"] == str(store.LINEAR_ROOM_DIR)
    config = observatory._conv_config(entry)
    assert config["act_gate"] is False and config["guard_docs"] is False


def test_the_room_lists_its_own_sessions_and_nothing_else(room_client):
    created = room_client.post("/api/observatory/conversations",
                               json={"title": "plan", "lane": "linear"}).get_json()["id"]
    room_client.post("/api/observatory/conversations", json={"title": "build", "lane": "coding"})
    # An entry with no lane written, rooted in the room folder, still belongs.
    with store.mutate("bot_chats/index", {}) as index:
        index["old-one"] = {"title": "older", "started": "2026-01-01T00:00:00",
                            "cwd": str(store.LINEAR_ROOM_DIR)}
    body = room_client.get("/api/linear-room").get_json()
    assert [r["id"] for r in body["sessions"]] == [created, "old-one"]
    assert body["running"] == 0 and body["model_choices"]
