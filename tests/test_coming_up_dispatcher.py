"""The Coming up dispatcher (scripts/coming_up_dispatcher.py): due reminders
go to the pinned Keeper as system follow-ups, once, and late ones are missed.

`queue_followup` is recorded rather than run — what it does with a reminder
is covered in test_followups.py; here the question is only what gets sent,
where, and when.
"""
from datetime import datetime

import pytest

import comingup
import store
from routes import observatory
from scripts import coming_up_dispatcher as dispatcher


@pytest.fixture
def sent(data_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(observatory, "queue_followup",
                        lambda conv_id, text, **kw: calls.append((conv_id, text, kw)) or "sent")
    return calls


def _pin_keeper(conv_id="2026-10-16.030000"):
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = {"bot": "keeper", "pinned": True, "last_at": "2026-10-16T03:00:00"}
    return conv_id


def _topic(**over):
    raw = {"title": "Ask how the applications feel", "kind": "topic",
           "date": "2026-10-16", "time": "18:00"}
    raw.update(over)
    return comingup.add_item(raw, over.pop("created_by", "manual"))


def test_due_reminder_goes_to_the_pinned_keeper_marked_system(sent):
    keeper = _pin_keeper()
    item = _topic()
    result = dispatcher.process_due(datetime(2026, 10, 16, 18, 0, 30))
    assert result["fired"] == [item["id"]]
    conv_id, text, kw = sent[0]
    assert conv_id == keeper
    assert text.startswith("[System reminder")
    assert kw["system"]["source"] == "manual" and kw["system"]["item_id"] == item["id"]
    assert kw["system"]["journal"].startswith("Reminder (set by you)")


def test_keeper_set_reminder_says_so(sent):
    _pin_keeper()
    _topic(created_by="keeper")
    dispatcher.process_due(datetime(2026, 10, 16, 18, 1))
    _, text, kw = sent[0]
    assert "a previous Keeper" in text
    assert kw["system"]["source"] == "keeper"
    assert kw["system"]["journal"].startswith("Reminder (set by the keeper)")


def test_a_fired_reminder_never_fires_again(sent):
    _pin_keeper()
    _topic()
    dispatcher.process_due(datetime(2026, 10, 16, 18, 1))
    dispatcher.process_due(datetime(2026, 10, 16, 18, 2))
    assert len(sent) == 1


def test_a_reminder_hours_late_is_missed_not_sent(sent):
    _pin_keeper()
    item = _topic()
    result = dispatcher.process_due(datetime(2026, 10, 17, 2, 0))
    assert result["missed"] == [item["id"]] and sent == []
    assert comingup.load_items()[0]["status"] == "missed"


def test_with_no_pinned_keeper_it_waits(sent):
    item = _topic()
    result = dispatcher.process_due(datetime(2026, 10, 16, 18, 1))
    assert result["waiting"] == [item["id"]] and sent == []
    assert comingup.load_items()[0]["status"] == "pending"


def test_not_due_yet_sends_nothing(sent):
    _pin_keeper()
    _topic()
    assert dispatcher.process_due(datetime(2026, 10, 16, 17, 59))["fired"] == []
    assert sent == []
