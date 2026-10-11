"""Server-side follow-ups (routes/observatory.py, "Follow-ups" section).

The bug these pin: an Approve tap was recorded, but the retry cue that wakes
the session was sent by her BROWSER, which gave up after 30 seconds of "a
turn is already running" (or stopped when her phone locked). Now the server
queues the cue and starts it the moment the conversation is free.

The turn process is faked (`hosted` records what would have started), so
these assert on what the server decides to run, not on a model.
"""
import json

import pytest

from routes import observatory
import store
from tests.test_observatory_routes import (  # noqa: F401  (bot_client is a fixture)
    bot_client, _seed_conv, _seed_pending, _conv_log)


@pytest.fixture
def hosted(bot_client, monkeypatch):
    """Every turn the server starts, as (conv_id, text). The fake host
    'finishes' instantly unless a test holds the conversation busy itself."""
    started = []

    def _fake_host(config, text, resume_sid, conv_id, log_path):
        started.append((conv_id, text))
        with store.mutate("bot_chats/index", {}) as index:
            index[conv_id]["running"] = False
        return True

    monkeypatch.setattr(observatory, "_spawn_host", _fake_host)
    return started


def _set_running(conv_id, running):
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["running"] = running
    # _effective_running also trusts a live process record; a test that says
    # "busy" means busy regardless of pids.
    return conv_id


def test_approve_on_an_idle_session_resumes_it_immediately(bot_client, hosted):
    cid = _seed_conv()
    _seed_pending(cid, "git status")
    resp = bot_client.post(f"/api/observatory/conversation/{cid}/approve", json={})
    assert resp.get_json()["resume"] == "sent"
    assert hosted == [(cid, observatory.APPROVE_CUE)]
    decisions = [e for e in _conv_log(cid) if e.get("type") == "decision"]
    assert decisions[-1]["command"] == "git status"


def test_approve_while_busy_waits_then_fires_when_the_turn_ends(bot_client, hosted, monkeypatch):
    cid = _seed_conv()
    _seed_pending(cid, "git status")
    monkeypatch.setattr(observatory, "_effective_running",
                        lambda conv_id, entry: bool(entry.get("running")))
    _set_running(cid, True)
    resp = bot_client.post(f"/api/observatory/conversation/{cid}/approve", json={})
    assert resp.get_json()["resume"] == "queued"
    assert hosted == []
    # ...an hour later, long past the old 30-second browser budget, the turn ends
    _set_running(cid, False)
    assert observatory.drain_followups(cid) is True
    assert hosted == [(cid, observatory.APPROVE_CUE)]
    assert observatory.drain_followups(cid) is False       # sent once, not twice


def test_deny_queues_the_denied_nudge(bot_client, hosted):
    cid = _seed_conv()
    _seed_pending(cid, "rm -rf x")
    bot_client.post(f"/api/observatory/conversation/{cid}/deny", json={})
    assert hosted == [(cid, observatory.DENY_CUE)]


def test_an_old_pages_own_resume_is_ignored(bot_client, hosted):
    cid = _seed_conv()
    _seed_pending(cid, "git status")
    bot_client.post(f"/api/observatory/conversation/{cid}/approve", json={})
    # a cached page still fires its resume after the tap
    resp = bot_client.post(f"/api/observatory/conversation/{cid}/send", json={
        "text": observatory.APPROVE_CUE, "record": False,
        "decision": {"kind": "approve", "command": "git status"}})
    assert resp.status_code == 200
    assert len(hosted) == 1
    assert len([e for e in _conv_log(cid) if e.get("type") == "decision"]) == 1


def test_a_follow_up_that_cannot_launch_stays_queued(bot_client, monkeypatch):
    cid = _seed_conv()
    monkeypatch.setattr(observatory, "_spawn_host", lambda *a, **k: False)
    assert observatory.queue_followup(cid, "hello") == "queued"
    entry = store.read("bot_chats/index", {})[cid]
    assert entry["running"] is False                     # not stuck "busy"
    assert observatory.drain_all_followups() == 0        # still waiting
    queued = json.loads(observatory._followups_path(cid).read_text())
    assert [it["text"] for it in queued["items"]] == ["hello"]


def test_follow_up_for_a_vanished_conversation_is_dropped(bot_client, hosted):
    observatory._chats_dir()
    with observatory._FollowupFile("2026-01-01.000000") as data:
        data["items"].append({"text": "x", "record": False})
    assert observatory.drain_followups("2026-01-01.000000") is False
    queued = json.loads(observatory._followups_path("2026-01-01.000000").read_text())
    assert queued["items"] == []


def test_system_reminder_is_journaled_as_S_and_logged_as_a_reminder(bot_client, hosted):
    cid = _seed_conv()
    with store.mutate("bot_chats/index", {}) as index:
        index[cid]["journal"] = True
        index[cid]["awaiting_input"] = "which one?"
    observatory.queue_followup(cid, "System reminder: ask about Permafest", system={
        "display": "Reminder: Permafest", "journal": "Reminder (set by you): Permafest",
        "source": "manual", "item_id": "abc"})
    assert bot_client._mints == [("S", "Reminder (set by you): Permafest")]
    reminder = [e for e in _conv_log(cid) if e.get("type") == "reminder"][-1]
    assert reminder["source"] == "manual" and reminder["item_id"] == "abc"
    assert not any(e.get("type") == "user" for e in _conv_log(cid))
    entry = store.read("bot_chats/index", {})[cid]
    assert entry["awaiting_input"] == "which one?"      # a reminder isn't her answer
    assert "last_prompt" not in entry


def test_rollover_hands_waiting_reminders_to_the_new_keeper(bot_client):
    observatory._chats_dir()
    with observatory._FollowupFile("old") as data:
        data["items"] += [{"text": "r", "system": {"item_id": "1"}},
                          {"text": observatory.APPROVE_CUE, "decision": {"kind": "approve"}}]
    assert observatory.move_system_followups("old", "new") == 1
    old = json.loads(observatory._followups_path("old").read_text())
    new = json.loads(observatory._followups_path("new").read_text())
    assert [it["text"] for it in old["items"]] == [observatory.APPROVE_CUE]
    assert [it["text"] for it in new["items"]] == ["r"]
