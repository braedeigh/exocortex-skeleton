"""Recurring reminders on the phone: scripts/todo_push_dispatcher.py pushes a
reminder that's due at its `push_at` time, once a day until it's logged, and
scripts/log_activity.py (the Keeper's door) logging a dose is what stops it.

The HTTP door is stubbed (`post_reminder` is recorded, not sent); what's under
test is what gets pushed, when, and how often.
"""
from datetime import datetime

import pytest

import store
from routes import reminders as reminders_route
from scripts import log_activity
from scripts import todo_push_dispatcher as dispatcher


ESTRADIOL = {
    "id": "rem_estradiol", "emoji": "💉", "label": "Estradiol", "type": "estradiol",
    "schedule": "interval", "every_days": 5, "overdue_days": 7, "weekdays": [],
    "mode": "log", "times": [], "private": True, "due_text": "Time for your shot",
    "push_at": "19:00",
}


@pytest.fixture
def pushes(data_dir, monkeypatch):
    sent = []
    (store.DATA_DIR / "push_hook_secret").write_text("s3cret")
    monkeypatch.setattr(dispatcher, "post_reminder",
                        lambda secret, title, body: sent.append((title, body)) or True)
    return sent


def _setup(reminder, log_dates):
    store.write("reminders.json", {"reminders": [reminder]})
    store.write("activity_log.json",
                {"entries": [{"date": d, "type": reminder["type"]} for d in log_dates]})


def test_due_reminder_pushes_once_at_its_time_and_again_the_next_day(pushes):
    _setup(ESTRADIOL, ["2026-11-07"])  # 5 days later = due Nov 12
    dispatcher.process_due(datetime(2026, 11, 12, 18, 59))
    assert pushes == []  # not yet 7 PM
    dispatcher.process_due(datetime(2026, 11, 12, 19, 0))
    dispatcher.process_due(datetime(2026, 11, 12, 19, 5))
    assert len(pushes) == 1  # once per day, not once per minute
    dispatcher.process_due(datetime(2026, 11, 13, 19, 1))
    assert len(pushes) == 2  # still unlogged tomorrow → one more


def test_not_pushed_before_the_interval_is_up(pushes):
    _setup(ESTRADIOL, ["2026-11-09"])
    dispatcher.process_due(datetime(2026, 11, 12, 19, 0))  # 3 days in, every 5
    assert pushes == []


def test_a_dose_the_keeper_logs_silences_the_push(pushes):
    _setup(ESTRADIOL, ["2026-11-07"])
    assert log_activity.main(["estradiol", "--date", "2026-11-12"],
                             today=datetime(2026, 11, 12, 21, 0)) == 0
    dispatcher.process_due(datetime(2026, 11, 13, 19, 0))
    assert pushes == []
    entries = store.read("activity_log.json")["entries"]
    assert {"date": "2026-11-12", "type": "estradiol"} in entries


def test_private_reminder_keeps_its_name_off_the_lock_screen(pushes):
    _setup(ESTRADIOL, [])
    dispatcher.process_due(datetime(2026, 11, 12, 19, 0))
    (title, body), = pushes
    assert "Estradiol" not in title + body
    assert title == "⏰ Time for your shot"


def test_public_reminder_says_what_it_is(pushes):
    _setup({**ESTRADIOL, "private": False, "label": "Sheets", "emoji": "🛌",
            "type": "laundry-sheets"}, [])
    dispatcher.process_due(datetime(2026, 11, 12, 19, 0))
    assert pushes == [("🛌 Sheets", "Time for your shot")]


@pytest.mark.parametrize("change", [
    {"push_at": ""}, {"mode": "track"}, {"snoozed_until": "2026-11-20"},
])
def test_no_push_without_a_time_or_while_silent_or_snoozed(pushes, change):
    _setup({**ESTRADIOL, **change}, [])
    dispatcher.process_due(datetime(2026, 11, 12, 19, 0))
    assert pushes == []


def test_a_push_hours_late_is_skipped_not_sent(pushes):
    _setup(ESTRADIOL, [])
    dispatcher.process_due(datetime(2026, 11, 12, 23, 30))  # machine was asleep
    assert pushes == []


def test_weekly_reminder_follows_its_weekday(pushes):
    _setup({**ESTRADIOL, "schedule": "weekly", "weekdays": [4]}, [])  # Thursday
    dispatcher.process_due(datetime(2026, 11, 11, 19, 0))  # Wed — last Thu unlogged
    dispatcher.process_due(datetime(2026, 11, 12, 19, 0))  # Thu
    assert len(pushes) == 2
    _setup({**ESTRADIOL, "schedule": "weekly", "weekdays": [4]}, ["2026-11-12"])
    dispatcher.process_due(datetime(2026, 11, 13, 19, 0))  # Fri, logged Thu
    assert len(pushes) == 2


# --- the Keeper's logging script --------------------------------------------

def test_log_activity_refuses_unknown_types_and_future_dates(data_dir):
    _setup(ESTRADIOL, [])
    today = datetime(2026, 11, 12, 12, 0)
    assert log_activity.main(["estrogen"], today=today) == 2
    assert log_activity.main(["estradiol", "--date", "2026-11-14"], today=today) == 2
    assert store.read("activity_log.json")["entries"] == []


def test_log_activity_finds_by_label_and_undoes_with_remove(data_dir):
    _setup(ESTRADIOL, [])
    today = datetime(2026, 11, 12, 12, 0)
    log_activity.main(["Estradiol", "--date", "yesterday"], today=today)
    log_activity.main(["Estradiol", "--date", "yesterday"], today=today)  # no duplicate
    assert store.read("activity_log.json")["entries"] == [{"date": "2026-11-11", "type": "estradiol"}]
    log_activity.main(["estradiol", "--date", "2026-11-11", "--remove"], today=today)
    assert store.read("activity_log.json")["entries"] == []


# --- push_at through the manager's save -------------------------------------

@pytest.fixture
def client(data_dir):
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    reminders_route.register(app)
    return app.test_client()


@pytest.mark.parametrize("given,kept", [
    ("19:00", "19:00"), ("7:05", "07:05"), ("25:00", ""), ("evening", ""), (None, ""),
])
def test_save_keeps_a_real_push_time_and_drops_anything_else(client, given, kept):
    client.post("/api/reminders/save", json={"reminders": [{"label": "Estradiol", "push_at": given}]})
    assert store.read("reminders.json")["reminders"][0]["push_at"] == kept
