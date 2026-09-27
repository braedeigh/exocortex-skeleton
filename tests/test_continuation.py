"""Self-continuing sessions (continuation.py).

What these pin: a Coding session past its model's cap is asked for a handoff
only once its turn has ended, and only once; other rooms never are; the
handoff opens a fresh Coding session on the same model, parented to the old
one, whose brief carries the handoff and the files in play; the old one is
archived when its last turn ends; and messages to it reach its successor.
"""
import json

import pytest

import config
import continuation
import peermail
import store
from routes import observatory, spinoff


def _seed(conv_id, **fields):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = {"title": f"title {conv_id}", "lane": "coding",
                          "cwd": str(store.DATA_DIR), **fields}


@pytest.fixture
def queued(data_dir, monkeypatch):
    got = []
    monkeypatch.setattr(observatory, "queue_followup",
                        lambda conv_id, text, **kw: got.append((conv_id, text, kw)) or "queued")
    return got


def test_caps_are_per_model_family():
    assert continuation.cap_for({"context_model": "claude-opus-5-5"}) == config.CONTEXT_CAPS["opus"]
    assert continuation.cap_for({"model": "fable"}) == config.CONTEXT_CAPS["fable"]
    assert continuation.cap_for({"model": "mystery"}) is None


def test_under_the_cap_nothing_happens(queued):
    _seed("a", context_model="claude-opus-5-5", context_tokens=90000)
    assert continuation.check("a") is False and queued == []


def test_past_the_cap_it_is_asked_once_when_the_turn_ends(queued):
    _seed("a", context_model="claude-opus-5-5", context_tokens=130000, running=True)
    assert continuation.check("a") is False          # mid-turn: let it finish
    with store.mutate("bot_chats/index", {}) as index:
        index["a"]["running"] = False
    assert continuation.check("a") is True
    assert "peers.py handoff" in queued[0][1]
    assert queued[0][2]["system"]["source"] == "continuation"
    assert continuation.check("a") is False          # never twice


def test_only_rooms_that_continue_themselves_are_asked(queued):
    _seed("p", lane="personal", context_model="claude-opus-5-5", context_tokens=500000)
    _seed("o", lane="orchestra", context_model="claude-opus-5-5", context_tokens=500000)
    _seed("k", journal=True, context_model="claude-opus-5-5", context_tokens=500000)
    assert not any(continuation.check(c) for c in ("p", "o", "k"))


def test_a_handoff_opens_a_parented_session_that_starts_itself(data_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(store, "SPINOFF_DIR", tmp_path / "spinoffs")
    launched = []
    monkeypatch.setattr(spinoff, "_launch_runner", lambda cid, kickoff: launched.append(cid) or True)
    _seed("2026-09-27.100000", model="opus", context_model="claude-opus-5-5",
          context_tokens=130000, continuation={"state": "asked"})
    (store.DATA_DIR / "bot_chats" / "2026-09-27.100000.jsonl").write_text(json.dumps(
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1",
         "name": "Edit", "input": {"file_path": "/repo/app.py", "old_string": "a",
                                   "new_string": "b"}}]}}) + "\n")
    reply = continuation.hand_off("2026-09-27.100000",
                                  "Goal: finish the thing. Done: step one. Left: step two.")
    new_id = reply["conversation_id"]
    assert launched == [new_id]
    index = store.read("bot_chats/index", {})
    child, old = index[new_id], index["2026-09-27.100000"]
    assert (child["spawned_from"], child["spawned_via"]) == ("2026-09-27.100000", "continue")
    assert child["lane"] == "coding" and child["model"] == "opus"
    assert old["continued_by"] == new_id and old["archive_after_turn"] is True
    brief = (store.SPINOFF_DIR / "cont-20260927100000" / "BRIEF.md").read_text()
    assert "## Protocol" in brief and "Left: step two." in brief
    assert "/repo/app.py" in brief
    # its last turn ends → archived
    observatory.after_turn("2026-09-27.100000")
    assert store.read("bot_chats/index", {})["2026-09-27.100000"]["archived"] is True


def test_a_too_short_handoff_is_refused(data_dir):
    _seed("a")
    with pytest.raises(ValueError):
        continuation.hand_off("a", "done")


def test_messages_to_a_handed_off_session_reach_its_successor(data_dir):
    _seed("sender")
    _seed("old", continued_by="new")
    _seed("new")
    row = peermail.send("old", "are you there?", from_conv="sender")
    assert row["to_conv"] == "new"
