"""Tests for the to-do data helpers (data_helpers.py)."""
import data_helpers as dh
import store


def test_ensure_ids_backfills_missing(data_dir):
    data = {"now": {"items": [{"text": "no id yet", "done": False}]},
            "today": {"date": "2026-06-08", "label": "x", "items": []}}
    changed = dh._ensure_todo_ids(data)
    assert changed is True
    assert data["now"]["items"][0]["id"]


def test_ensure_ids_idempotent(data_dir):
    data = {"now": {"items": [{"id": "fixed", "text": "has id", "done": False}]}}
    assert dh._ensure_todo_ids(data) is False
    assert data["now"]["items"][0]["id"] == "fixed"


def test_load_todos_persists_backfilled_ids(data_dir):
    # Write a file the "old" way: items with no ids.
    store.write("todos", {"now": {"items": [{"text": "legacy", "done": False}]}})
    loaded = dh.load_todos()
    assert loaded["now"]["items"][0]["id"]
    # The migration was persisted, so a second read already has the id.
    again = store.read("todos", {})
    assert again["now"]["items"][0]["id"] == loaded["now"]["items"][0]["id"]


def test_find_section_key():
    assert dh.find_section_key("Now") == "now"
    assert dh.find_section_key("Up Next") == "up_next"
    assert dh.find_section_key("Up Next — 3 left") == "up_next"   # trailing label stripped
    assert dh.find_section_key("Bogus") is None


def test_todos_to_sections_autosort_orders_by_due_then_age():
    data = {"now": {"items": [
        {"id": "1", "text": "no date, newer", "done": False, "created": "2026-06-05"},
        {"id": "2", "text": "due soon", "done": False, "due_by": "2026-06-09"},
        {"id": "3", "text": "done one", "done": True},
        {"id": "4", "text": "due later", "done": False, "due_by": "2026-06-20"},
    ]}}
    sections = {s["name"]: s for s in dh.todos_to_sections(data)}
    order = [i["id"] for i in sections["Now"]["items"]]
    # undone+dated (soonest first) → undone undated → done last
    assert order == ["2", "4", "1", "3"]


def test_todos_to_sections_respects_manual_order():
    data = {"now": {"manual_order": True, "items": [
        {"id": "b", "text": "B", "done": False},
        {"id": "a", "text": "A", "done": False},
    ]}}
    sections = {s["name"]: s for s in dh.todos_to_sections(data)}
    assert [i["id"] for i in sections["Now"]["items"]] == ["b", "a"]
    assert sections["Now"]["manual_order"] is True
