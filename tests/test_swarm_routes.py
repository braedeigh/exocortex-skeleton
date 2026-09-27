"""Swarm routes (routes/swarms.py) against a minimal app.

What these pin: the list shows a live swarm with its counts; the detail
carries the helper's runs verbatim and the messages between members;
unknown swarms 404; refresh starts a helper run.
"""
import json

import pytest
from flask import Flask

import peermail
import sqlstore
import store
import swarm_helper
import swarms
from routes import swarms as swarm_routes


@pytest.fixture
def client(data_dir, monkeypatch):
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index["a"] = {"title": "A", "lane": "coding", "running": True}
        index["b"] = {"title": "B", "lane": "coding"}
    peermail.send("b", "hello", from_conv="a")
    app = Flask(__name__)
    swarm_routes.register(app)
    return app.test_client()


def test_the_list_shows_a_swarm_with_its_counts(client):
    [card] = client.get("/api/swarms").get_json()["swarms"]
    assert card["counts"] == {"working": 1, "silent": 1, "needs_input": 0}
    assert {m["conv"] for m in card["members"]} == {"a", "b"}


def test_the_detail_shows_what_the_helper_used(client):
    [swarm_id] = swarms.sync()
    conn = sqlstore.open_db()
    sqlstore.begin_immediate(conn)
    conn.execute("INSERT INTO swarm_helper_runs (swarm_id, at, trigger, input, output)"
                 " VALUES (?, '2026-09-27T10:00:00', 'turn', 'the input', ?)",
                 (swarm_id, json.dumps({"differences": ["both edit x.py"]})))
    conn.execute("COMMIT")
    conn.close()
    got = client.get(f"/api/swarms/{swarm_id}").get_json()
    assert got["runs"][0]["input"] == "the input"
    assert got["differences"] == ["both edit x.py"]
    assert [m["text"] for m in got["messages"]] == ["hello"]


def test_unknown_swarm_is_404(client):
    assert client.get("/api/swarms/999").status_code == 404
    assert client.post("/api/swarms/999/refresh").status_code == 404


def test_refresh_starts_a_run(client):
    [swarm_id] = swarms.sync()
    assert client.post(f"/api/swarms/{swarm_id}/refresh").get_json()["started"] is True
