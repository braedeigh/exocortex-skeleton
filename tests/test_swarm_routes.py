"""Swarm routes (routes/swarms.py) against a minimal app.

What these pin: the list shows a live swarm with its counts; the detail
carries the helper's runs verbatim and the messages between members;
unknown swarms 404; a card says whether it's closed; refresh starts a helper run; the room view lists the
sessions working alone and the room helper's moves; helper-of links a session's
chat to its swarm's helper, else its room's, and a helper one level up or nowhere.
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
    assert card["closed"] is False


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


def test_the_room_view_lists_who_works_alone(client):
    with store.mutate("bot_chats/index", {}) as index:
        index["c"] = {"title": "C", "lane": "coding"}
        index["h"] = {"title": "Room helper", "lane": "coding", "role": "room_helper",
                      "room": "coding"}
    found = client.get("/api/swarms/room/coding").get_json()
    assert [s["conv"] for s in found["solos"]] == ["c"]
    assert found["helper_conv"] == "h" and found["moves"] == []


def _with_helpers(swarm_helper_conv="sh"):
    """Give the fixture's swarm a helper session, and the room a room helper."""
    [swarm_id] = swarms.sync()
    with store.mutate("bot_chats/index", {}) as index:
        index["sh"] = {"title": "Swarm helper · X", "lane": "coding", "role": "swarm_helper",
                       "swarm_id": swarm_id}
        index["rh"] = {"title": "Room helper · Coding", "lane": "coding", "role": "room_helper",
                       "room": "coding"}
        index["solo"] = {"title": "Solo", "lane": "coding"}
    conn = sqlstore.open_db()
    sqlstore.begin_immediate(conn)
    conn.execute("UPDATE swarms SET helper_conv = ? WHERE id = ?", (swarm_helper_conv, swarm_id))
    conn.execute("COMMIT")
    conn.close()


def _helper_of(client, conv):
    return client.get(f"/api/swarms/helper-of/{conv}").get_json()["helper"]


def test_a_swarm_member_links_to_its_swarm_helper(client):
    _with_helpers()
    assert _helper_of(client, "a") == {"kind": "swarm", "conv": "sh", "title": "Swarm helper · X"}


def test_a_session_working_alone_links_to_its_room_helper(client):
    _with_helpers()
    assert _helper_of(client, "solo")["conv"] == "rh"


def test_a_member_of_a_swarm_with_no_helper_yet_falls_back_to_the_room_helper(client):
    _with_helpers(swarm_helper_conv=None)
    assert _helper_of(client, "a")["kind"] == "room"


def test_a_swarm_helper_links_up_to_the_room_helper_and_the_room_helper_nowhere(client):
    _with_helpers()
    assert _helper_of(client, "sh")["conv"] == "rh"
    assert _helper_of(client, "rh") is None


def test_no_helper_in_the_room_means_no_link(client):
    with store.mutate("bot_chats/index", {}) as index:
        index["p"] = {"title": "P", "lane": "personal"}
    assert _helper_of(client, "p") is None
    assert _helper_of(client, "nope") is None
