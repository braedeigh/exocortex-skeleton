"""routes/research_room.py — the research lane's two doors: the mint a
dispatched worker's conversation comes through, and GET /api/research-room,
the list behind the Observatory's Research door. Plus the lane itself in
routes/observatory.py: its profile, its cwd inference, and the create route
accepting it.

Minimal app (research_room + observatory registered, nothing else), the
data dir monkeypatched per test, the research-room folder pointed at a
tmp_path so the cwd the lane hands out is a real directory.
"""
import pytest
from flask import Flask

import recap_summary
import store
from routes import observatory, research_room


@pytest.fixture
def room_client(data_dir, tmp_path, monkeypatch):
    room = tmp_path / "research-room"
    room.mkdir()
    monkeypatch.setattr(store, "RESEARCH_ROOM_DIR", room)
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    # The roster asks recap_summary for card summaries — never let a test
    # kick off a real background Haiku call.
    monkeypatch.setattr(recap_summary, "_spawn", lambda fn: None)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research_room.register(app)
    observatory.register(app)
    return app.test_client()


def _index():
    return store.read("bot_chats/index", {})


# --- the lane -----------------------------------------------------------------

def test_the_research_lane_stands_in_the_room_folder_and_does_not_ask(room_client):
    profile = observatory._lane_profile("research")
    assert profile["cwd"] == str(store.RESEARCH_ROOM_DIR)
    assert profile["act_gate"] is False and profile["guard_docs"] is False
    assert profile["allowed_tools"] == list(observatory._BUILDER_TOOLS)


def test_a_session_rooted_in_the_room_folder_derives_to_research(room_client):
    assert observatory._conv_lane({"cwd": str(store.RESEARCH_ROOM_DIR)}) == "research"
    # The other grounds still place the way they did.
    assert observatory._conv_lane({"cwd": str(store.BUILD_DIR)}) == "orchestra"
    assert observatory._conv_lane({}) == "orchestra"


def test_create_accepts_the_research_lane_and_roots_it_in_the_room(room_client):
    body = room_client.post("/api/observatory/conversations",
                            json={"title": "desk", "lane": "research"}).get_json()
    assert body["ok"] and body["lane"] == "research"
    entry = _index()[body["id"]]
    assert entry["lane"] == "research"
    assert entry["cwd"] == str(store.RESEARCH_ROOM_DIR)
    # Unwritten, like every lane: the lane keeps driving the safety nets.
    assert "act_gate" not in entry and "guard_docs" not in entry
    assert observatory._conv_config(entry)["act_gate"] is False


# --- the mint -----------------------------------------------------------------

def test_a_minted_worker_conversation_points_back_at_its_research_session(room_client, tmp_path):
    skill = tmp_path / "worker" / "CLAUDE.md"
    skill.parent.mkdir()
    skill.write_text("# job\n")
    conv_id = research_room.mint_research_conversation(
        "s1", "Does X cause Y?", model="haiku", system_prompt_file=skill)
    entry = _index()[conv_id]
    assert entry["lane"] == "research"
    assert entry["origin"] == "research"
    assert entry["research_session_id"] == "s1"
    assert entry["title"] == "Does X cause Y?"
    assert entry["cwd"] == str(store.RESEARCH_ROOM_DIR)
    assert entry["model"] == "haiku"
    assert entry["system_prompt_file"] == str(skill)
    assert entry["journal"] is False


def test_the_mint_leaves_out_what_it_cannot_vouch_for(room_client, tmp_path):
    """An unknown model and a missing skill file write NO field — absent, so
    the session follows the CLI default and runs bare, rather than a broken
    reference the turn would trip on."""
    conv_id = research_room.mint_research_conversation(
        "s2", "", model="not-a-model", system_prompt_file=tmp_path / "nope" / "CLAUDE.md")
    entry = _index()[conv_id]
    assert "model" not in entry and "system_prompt_file" not in entry
    assert entry["title"] == "Research s2"


# --- the list -----------------------------------------------------------------

def test_the_room_lists_research_sessions_only_archived_included_newest_first(room_client):
    worker = research_room.mint_research_conversation("s1", "worker one")
    desk = room_client.post("/api/observatory/conversations",
                            json={"title": "desk", "lane": "research"}).get_json()["id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[worker]["started"] = "2026-09-01T00:00:00"
        index[worker]["archived"] = "2026-09-02T00:00:00"
        index[desk]["started"] = "2026-09-03T00:00:00"
        index[desk]["last_error"] = "claude exited 1"
        # Her own chat in another room, and a pre-lane session rooted in the
        # room folder (placed by cwd, so it belongs here too).
        index["plain"] = {"title": "coding", "lane": "coding", "started": "2026-09-04T00:00:00"}
        index["old"] = {"title": "old desk", "cwd": str(store.RESEARCH_ROOM_DIR),
                        "started": "2026-08-01T00:00:00"}
    body = room_client.get("/api/research-room").get_json()
    ids = [r["id"] for r in body["sessions"]]
    assert ids == [desk, worker, "old"]
    assert body["sessions"][0]["research_session_id"] is None
    assert body["sessions"][0]["last_error"] == "claude exited 1"
    assert body["sessions"][1]["research_session_id"] == "s1"
    assert body["sessions"][1]["archived"]
    assert body["failed"] == 1 and body["running"] == 0
    assert body["model_choices"] == list(observatory._MODEL_CHOICES)
