"""Coming up (comingup.py): what the wake shows and what the clock fires.

Each test seeds its own throwaway store (the `data_dir` fixture), so nothing
here touches real data. `coming_up` is SQL-backed, so these also prove the
collection round-trips through exo.db.
"""
from datetime import date, datetime

import pytest

import comingup
import store

TODAY = date(2026, 9, 25)


def _add(**fields):
    raw = {"title": "Thing", "date": "2026-10-17"}
    raw.update(fields)
    return comingup.add_item(raw, fields.pop("created_by", "manual"))


def test_coming_up_is_sql_backed(data_dir):
    assert "coming_up" in store.SQL_COLLECTIONS
    item = _add(title="Festival")
    stored = store.read("coming_up", {})
    assert [it["id"] for it in stored["items"]] == [item["id"]]


def test_clean_item_rejects_missing_title_and_bad_date(data_dir):
    with pytest.raises(comingup.ItemError):
        comingup.clean_item({"date": "2026-10-17"}, "manual")
    with pytest.raises(comingup.ItemError):
        comingup.clean_item({"title": "x", "date": "Oct 17"}, "manual")
    with pytest.raises(comingup.ItemError):
        comingup.clean_item({"title": "x", "date": "2026-10-17", "time": "6pm"}, "manual")
    with pytest.raises(comingup.ItemError):
        comingup.clean_item({"title": "x", "date": "2026-10-17",
                             "end_date": "2026-10-16"}, "manual")


def test_clean_item_records_who_made_it(data_dir):
    assert comingup.clean_item({"title": "x", "date": "2026-10-17"}, "keeper")["created_by"] == "keeper"
    with pytest.raises(comingup.ItemError):
        comingup.clean_item({"title": "x", "date": "2026-10-17"}, "someone")


def test_item_shows_only_inside_its_lead_window(data_dir):
    _add(title="Far", date="2026-12-25", lead_days=14)
    _add(title="Near", date="2026-10-02", lead_days=14)
    items, _ = comingup.upcoming(TODAY, todos={})
    assert [it["title"] for it in items] == ["Near"]


def test_multi_day_event_stays_visible_until_its_end_date(data_dir):
    _add(title="Fest", date="2026-10-17", end_date="2026-10-18")
    items, _ = comingup.upcoming(date(2026, 10, 18), todos={})
    assert [it["title"] for it in items] == ["Fest"]
    items, _ = comingup.upcoming(date(2026, 10, 19), todos={})
    assert items == []


def test_dismissed_item_never_shows(data_dir):
    item = _add(title="Gone", date="2026-09-28")
    comingup.set_status(item["id"], "dismissed")
    items, _ = comingup.upcoming(TODAY, todos={})
    assert items == []


def test_open_todos_with_near_due_dates_are_listed(data_dir):
    todos = {
        "now": {"items": [
            {"id": "car", "text": "Car shop", "due_by": "2026-10-01"},
            {"id": "done-one", "text": "x", "due_by": "2026-10-01", "done": True},
            {"id": "far", "text": "x", "due_by": "2026-12-01"},
            {"id": "past", "text": "x", "due_by": "2026-09-01"},
            {"id": "snoozed", "text": "x", "due_by": "2026-10-01", "snoozed_until": "2026-09-30"},
        ]},
        "done": {"items": [{"id": "in-done", "text": "x", "due_by": "2026-10-01"}]},
    }
    _, rows = comingup.upcoming(TODAY, todos=todos)
    assert [r["todo_id"] for r in rows] == ["car"]


def test_when_label_counts_days(data_dir):
    assert comingup.when_label("2026-09-25", TODAY) == "today"
    assert comingup.when_label("2026-09-26", TODAY) == "tomorrow"
    assert comingup.when_label("2026-10-02", TODAY) == "in 7 days"
    assert comingup.when_label("2026-09-24", TODAY, "2026-09-26").startswith("on now")


def test_format_block_names_the_creator_and_the_time(data_dir):
    _add(title="Doctor", date="2026-10-02", time="15:00", created_by="keeper")
    block = comingup.format_block(TODAY, todos={})
    assert "## Coming up" in block
    assert "in 7 days" in block and "3:00 PM" in block and "set by keeper" in block


def test_format_block_says_so_when_empty(data_dir):
    assert "Nothing dated" in comingup.format_block(TODAY, todos={})


def test_only_pending_items_whose_reminder_moment_passed_are_due(data_dir):
    topic = _add(title="Ask", kind="topic", date="2026-09-25", time="18:00")
    event = _add(title="Doctor", date="2026-09-26", time="15:00",
                 remind_at="2026-09-25 12:00")
    _add(title="Untimed", date="2026-09-25")
    _add(title="Later", kind="topic", date="2026-09-25", time="21:00")
    fired = _add(title="Already", kind="topic", date="2026-09-25", time="17:00")
    comingup.set_status(fired["id"], "fired", fired_at="2026-09-25 17:00")
    due = comingup.due_to_fire(datetime(2026, 9, 25, 18, 30))
    assert [it["id"] for it, _ in due] == [event["id"], topic["id"]]


def test_an_event_time_alone_never_fires_a_reminder(data_dir):
    _add(title="Doctor", date="2026-09-25", time="15:00")
    assert comingup.due_to_fire(datetime(2026, 9, 25, 16, 0)) == []


def test_topic_reminder_defaults_to_its_own_time(data_dir):
    item = comingup.clean_item({"title": "x", "kind": "topic",
                                "date": "2026-10-10", "time": "18:00"}, "manual")
    assert item["remind_at"] == "2026-10-10 18:00"
    with pytest.raises(comingup.ItemError):
        comingup.clean_item({"title": "x", "date": "2026-10-10",
                             "remind_at": "tomorrow"}, "manual")
