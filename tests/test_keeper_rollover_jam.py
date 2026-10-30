"""The nightly rollover when the pinned Keeper can't close (scripts/keeper_rollover.py).

Runs the real main() with only the Claude turn faked: the fake writes to the
conversation's log what a real turn writes. A session the API's output filter
has jammed must still give way to a fresh Keeper; any other failed close must
keep aborting, so a day's diary isn't skipped over a passing error.
"""
import json
import sys

import pytest

import store
from routes import observatory as rr
from scripts import keeper_rollover

OLD = "2026-10-30.030137"
FILTER_REPLY = "API Error: Output blocked by content filtering policy"


def _log_lines(reply_text):
    """The tail a failed /endsession leaves in the log, with the given reply."""
    return [
        {"type": "user", "text": "/endsession", "ts": "2026-10-30T12:03:12"},
        {"type": "assistant", "message": {"role": "assistant", "model": "<synthetic>",
                                          "content": [{"type": "text", "text": reply_text}]}},
        {"type": "result", "is_error": True},
        {"type": "error", "error": "claude exited 1"},
    ]


@pytest.fixture
def rollover(data_dir, monkeypatch):
    """A pinned Keeper with a live session, and a faked turn; returns the reply
    its /endsession should get and the turns that ran."""
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index[OLD] = {"bot": "keeper", "pinned": True, "journal": True,
                      "claude_session_id": "abc", "cwd": str(data_dir),
                      "last_at": "2026-10-30T12:03:00", "running": False}
    state = {"reply": FILTER_REPLY, "turns": []}

    def fake_turn(bot, text, conv_id, resume_sid, cwd):
        state["turns"].append((text, conv_id))
        log_path = rr._chats_dir() / f"{conv_id}.jsonl"
        if text == "/endsession":
            with open(log_path, "a", encoding="utf-8") as log:
                for row in _log_lines(state["reply"]):
                    log.write(json.dumps(row) + "\n")
        return log_path

    monkeypatch.setattr(keeper_rollover, "_run_turn_sync", fake_turn)
    monkeypatch.setattr(rr, "attach_boot_package", lambda conv_id: None)
    monkeypatch.setattr(rr, "drain_followups", lambda conv_id: None)
    monkeypatch.setattr(keeper_rollover, "_lock_fh", None)
    monkeypatch.setattr(sys, "argv", ["keeper_rollover.py", "roll"])
    return state


def _pinned():
    return [cid for cid, meta in store.read("bot_chats/index", {}).items()
            if meta.get("pinned") and not meta.get("archived")]


def test_filter_jammed_keeper_gives_way_to_a_fresh_one(rollover):
    assert keeper_rollover.main() == 0

    pinned = _pinned()
    assert len(pinned) == 1 and pinned[0] != OLD
    assert rollover["turns"] == [("/endsession", OLD), ("/journalstart", pinned[0])]
    assert store.read("bot_chats/index", {})[OLD]["archived"]


def test_other_failed_close_still_aborts_and_keeps_the_keeper(rollover):
    rollover["reply"] = "API Error: Connection error."

    assert keeper_rollover.main() == 1

    assert _pinned() == [OLD]
    assert rollover["turns"] == [("/endsession", OLD)]


def test_an_old_filter_block_does_not_excuse_a_later_failed_close(rollover):
    """Only the closing turn's own failure counts: a block earlier in the day
    that the session recovered from says nothing about this error."""
    rollover["reply"] = "API Error: Connection error."
    with open(rr._chats_dir() / f"{OLD}.jsonl", "a", encoding="utf-8") as log:
        for row in _log_lines(FILTER_REPLY):
            log.write(json.dumps(row) + "\n")

    assert keeper_rollover.main() == 1

    assert _pinned() == [OLD]
