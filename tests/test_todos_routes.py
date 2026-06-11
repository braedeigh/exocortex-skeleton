"""Behavioral tests for the to-do API (routes/todos.py).

The point of Phase 0 was to make every to-do addressable by a stable `id`
instead of its mutable text. These tests pin that down: id-based add / toggle /
rename / move / remove / reorder, disambiguation of same-text items, and the
legacy text fallback so older clients keep working.
"""
import json

from conftest import read_todos


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload),
                       content_type="application/json")


def _all_items(data):
    out = []
    for sec in data.values():
        if isinstance(sec, dict):
            out.extend(sec.get("items", []))
    return out


# --- add ---------------------------------------------------------------------

def test_add_creates_item_with_id(client, seed):
    seed()
    r = _post(client, "/api/todos/add", {"item": "buy milk", "section": "Now"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True and body["id"]
    items = read_todos()["now"]["items"]
    assert len(items) == 1
    assert items[0]["id"] == body["id"]
    assert items[0]["text"] == "Buy milk"   # first letter capitalized
    assert items[0]["done"] is False
    assert "created" in items[0]


def test_add_duplicate_text_in_section_rejected(client, seed):
    seed()
    _post(client, "/api/todos/add", {"item": "Pay rent", "section": "Now"})
    r = _post(client, "/api/todos/add", {"item": "pay rent", "section": "Now"})
    assert r.status_code == 400
    assert len(read_todos()["now"]["items"]) == 1


def test_add_unknown_section_404(client, seed):
    seed()
    r = _post(client, "/api/todos/add", {"item": "x", "section": "Nope"})
    assert r.status_code == 404


def test_add_keeps_optional_fields(client, seed):
    seed()
    _post(client, "/api/todos/add",
          {"item": "Call clinic", "section": "Now", "due_by": "2026-06-10", "notes": "ask about labs"})
    it = read_todos()["now"]["items"][0]
    assert it["due_by"] == "2026-06-10"
    assert it["notes"] == "ask about labs"


# --- toggle ------------------------------------------------------------------

def test_toggle_by_id_marks_done_and_sinks(client, seed):
    seed({"now": {"items": [
        {"id": "a", "text": "first", "done": False},
        {"id": "b", "text": "second", "done": False},
    ]}})
    _post(client, "/api/todos/toggle", {"id": "a"})
    items = read_todos()["now"]["items"]
    a = next(i for i in items if i["id"] == "a")
    assert a["done"] is True
    assert items[-1]["id"] == "a"          # done item sinks to the bottom


def test_toggle_disambiguates_same_text(client, seed):
    # The whole reason for ids: two items with identical text must be independent.
    seed({"now": {"items": [
        {"id": "a", "text": "Email Bob", "done": False},
        {"id": "b", "text": "Email Bob", "done": False},
    ]}})
    _post(client, "/api/todos/toggle", {"id": "b"})
    by_id = {i["id"]: i for i in read_todos()["now"]["items"]}
    assert by_id["a"]["done"] is False
    assert by_id["b"]["done"] is True


def test_toggle_text_fallback_still_works(client, seed):
    # Legacy clients that send {item: <text>} keep working.
    seed({"now": {"items": [{"id": "a", "text": "Water plants", "done": False}]}})
    _post(client, "/api/todos/toggle", {"item": "Water plants"})
    assert read_todos()["now"]["items"][0]["done"] is True


# --- rename ------------------------------------------------------------------

def test_rename_by_id_changes_text_keeps_id(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "old", "done": False}]}})
    _post(client, "/api/todos/rename", {"id": "a", "new": "new text"})
    it = read_todos()["now"]["items"][0]
    assert it["id"] == "a"
    assert it["text"] == "new text"


def test_rename_empty_is_noop(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "keep", "done": False}]}})
    _post(client, "/api/todos/rename", {"id": "a", "new": "   "})
    assert read_todos()["now"]["items"][0]["text"] == "keep"


# --- move --------------------------------------------------------------------

def test_move_by_id_relocates_and_preserves_fields(client, seed):
    seed({
        "now": {"items": [{"id": "a", "text": "Taxes", "done": False, "notes": "keep me"}]},
        "later": {"items": []},
    })
    _post(client, "/api/todos/move", {"id": "a", "to_section": "Later"})
    data = read_todos()
    assert data["now"]["items"] == []
    moved = data["later"]["items"][0]
    assert moved["id"] == "a"
    assert moved["notes"] == "keep me"      # fields ride along with the move


# --- remove ------------------------------------------------------------------

def test_remove_by_id(client, seed):
    seed({"now": {"items": [
        {"id": "a", "text": "one", "done": False},
        {"id": "b", "text": "two", "done": False},
    ]}})
    _post(client, "/api/todos/remove", {"id": "a"})
    ids = [i["id"] for i in read_todos()["now"]["items"]]
    assert ids == ["b"]


# --- reorder -----------------------------------------------------------------

def test_reorder_by_ids_sets_manual_order(client, seed):
    seed({"now": {"items": [
        {"id": "x", "text": "X", "done": False},
        {"id": "y", "text": "Y", "done": False},
        {"id": "z", "text": "Z", "done": False},
    ]}})
    _post(client, "/api/todos/reorder", {"section": "Now", "items": ["z", "x", "y"]})
    sec = read_todos()["now"]
    assert [i["id"] for i in sec["items"]] == ["z", "x", "y"]
    assert sec["manual_order"] is True


def test_autosort_clears_manual_order(client, seed):
    seed({"now": {"manual_order": True, "items": [{"id": "a", "text": "A", "done": False}]}})
    _post(client, "/api/todos/autosort", {"section": "Now"})
    assert "manual_order" not in read_todos()["now"]


# --- details -----------------------------------------------------------------

def test_details_sets_then_clears(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    _post(client, "/api/todos/details", {"id": "a", "notes": "hello", "due_by": "2026-07-01"})
    it = read_todos()["now"]["items"][0]
    assert it["notes"] == "hello" and it["due_by"] == "2026-07-01"
    # Empty strings clear the fields.
    _post(client, "/api/todos/details", {"id": "a", "notes": "", "due_by": ""})
    it = read_todos()["now"]["items"][0]
    assert "notes" not in it and "due_by" not in it


def test_details_sets_phase1_attributes(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "Pick up meds", "done": False}]}})
    _post(client, "/api/todos/details", {
        "id": "a", "due_time": "20:00", "place_id": "p1",
        "category": "body", "status": "check_first", "duration_min": 15,
    })
    it = read_todos()["now"]["items"][0]
    assert it["due_time"] == "20:00"
    assert it["place_id"] == "p1"
    assert it["category"] == "body"
    assert it["status"] == "check_first"
    assert it["duration_min"] == 15


def test_details_clears_attributes_and_duration(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False,
                             "place_id": "p1", "duration_min": 30, "status": "ready"}]}})
    _post(client, "/api/todos/details", {"id": "a", "place_id": "", "duration_min": 0, "status": ""})
    it = read_todos()["now"]["items"][0]
    assert "place_id" not in it and "duration_min" not in it and "status" not in it


def test_details_only_touches_present_fields(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False, "place_id": "keep"}]}})
    _post(client, "/api/todos/details", {"id": "a", "notes": "new note"})
    it = read_todos()["now"]["items"][0]
    assert it["place_id"] == "keep"   # untouched because not in payload
    assert it["notes"] == "new note"


# --- snooze ------------------------------------------------------------------

def test_snooze_sets_and_clears(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    _post(client, "/api/todos/snooze", {"id": "a", "days": 7})
    assert read_todos()["now"]["items"][0]["snoozed_until"]
    _post(client, "/api/todos/snooze", {"id": "a", "days": 0})
    assert "snoozed_until" not in read_todos()["now"]["items"][0]
