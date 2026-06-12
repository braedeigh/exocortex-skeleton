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


def test_todos_to_sections_newest_undated_on_top():
    # A freshly added (newer `created`) undated item floats above older ones.
    data = {"now": {"items": [
        {"id": "old", "text": "older", "done": False, "created": "2026-06-01"},
        {"id": "new", "text": "just added", "done": False, "created": "2026-06-11"},
        {"id": "mid", "text": "middle", "done": False, "created": "2026-06-05"},
    ]}}
    sections = {s["name"]: s for s in dh.todos_to_sections(data)}
    assert [i["id"] for i in sections["Now"]["items"]] == ["new", "mid", "old"]


def test_sweep_archives_yesterdays_done_keeps_todays(data_dir):
    today = dh.datetime.now().strftime("%Y-%m-%d")
    data = {
        "now": {"items": [
            {"id": "active", "text": "still going", "done": False},
            {"id": "fresh", "text": "checked today", "done": True, "done_at": today},
            {"id": "stale", "text": "checked before", "done": True, "done_at": "2020-01-01"},
            {"id": "legacy", "text": "old done, no date", "done": True},
        ]},
        "done": {"items": []},
    }
    moved = dh._sweep_done_todos(data)
    assert moved is True
    now_ids = [i["id"] for i in data["now"]["items"]]
    done_ids = [i["id"] for i in data["done"]["items"]]
    # Today's check-off lingers in place; the active item stays; the rest file away.
    assert now_ids == ["active", "fresh"]
    assert set(done_ids) == {"stale", "legacy"}


def test_sweep_is_noop_when_nothing_to_archive(data_dir):
    today = dh.datetime.now().strftime("%Y-%m-%d")
    data = {"now": {"items": [
        {"id": "a", "text": "active", "done": False},
        {"id": "b", "text": "done today", "done": True, "done_at": today},
    ]}}
    assert dh._sweep_done_todos(data) is False


def test_load_todos_runs_the_sweep(data_dir):
    store.write("todos", {
        "now": {"items": [{"id": "x", "text": "old done", "done": True, "done_at": "2020-01-01"}]},
        "done": {"items": []},
    })
    loaded = dh.load_todos()
    assert [i["id"] for i in loaded["now"]["items"]] == []
    assert [i["id"] for i in loaded["done"]["items"]] == ["x"]
    # The sweep was persisted, so a second raw read already reflects it.
    again = store.read("todos", {})
    assert again["done"]["items"][0]["id"] == "x"


def test_todos_to_sections_respects_manual_order():
    data = {"now": {"manual_order": True, "items": [
        {"id": "b", "text": "B", "done": False},
        {"id": "a", "text": "A", "done": False},
    ]}}
    sections = {s["name"]: s for s in dh.todos_to_sections(data)}
    assert [i["id"] for i in sections["Now"]["items"]] == ["b", "a"]
    assert sections["Now"]["manual_order"] is True


def test_todos_for_tab_filters_by_category_and_skips_done():
    data = {
        "now": {"items": [
            {"id": "a", "text": "buy lemons", "done": False, "category": "kitchen"},
            {"id": "b", "text": "call mechanic", "done": False, "category": "car"},
            {"id": "c", "text": "old kitchen chore", "done": True, "category": "kitchen"},
        ]},
        "later": {"items": [
            {"id": "d", "text": "deep-clean fridge", "done": False, "category": "kitchen", "due_by": "2026-07-01"},
        ]},
        "done": {"items": [
            {"id": "e", "text": "archived", "done": True, "category": "kitchen"},
        ]},
    }
    out = dh.todos_for_tab("kitchen", data)
    assert [i["id"] for i in out] == ["a", "d"]
    assert out[1]["due_by"] == "2026-07-01"
    assert dh.todos_for_tab("body", data) == []
