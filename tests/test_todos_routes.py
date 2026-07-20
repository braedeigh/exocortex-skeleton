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


def test_toggle_stamps_and_clears_done_at(client, seed):
    # done_at drives the overnight sweep: set on check, removed on un-check.
    # Stamped to minute precision now, so assert the day prefix + a 'T'.
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    seed({"now": {"items": [{"id": "a", "text": "task", "done": False}]}})
    _post(client, "/api/todos/toggle", {"id": "a"})
    a = read_todos()["now"]["items"][0]
    assert a["done"] is True
    assert a["done_at"].startswith(today) and "T" in a["done_at"]
    _post(client, "/api/todos/toggle", {"id": "a"})
    a = read_todos()["now"]["items"][0]
    assert a["done"] is False and "done_at" not in a


def test_toggle_stamps_minute_precision(client, seed):
    import re
    seed({"now": {"items": [{"id": "a", "text": "task", "done": False}]}})
    _post(client, "/api/todos/toggle", {"id": "a"})
    a = read_todos()["now"]["items"][0]
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$", a["done_at"])


def test_add_inserts_at_top(client, seed):
    seed({"now": {"items": [{"id": "old", "text": "Existing", "done": False}]}})
    _post(client, "/api/todos/add", {"item": "brand new", "section": "Now"})
    items = read_todos()["now"]["items"]
    assert items[0]["text"] == "Brand new"   # new item lands on top


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
        "category": "body", "duration_min": 15,
    })
    it = read_todos()["now"]["items"][0]
    assert it["due_time"] == "20:00"
    assert it["place_id"] == "p1"
    assert "category" not in it   # retired 2026-07-14 (fronts vocabulary); silently ignored
    assert it["duration_min"] == 15


def test_details_clears_attributes_and_duration(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False,
                             "place_id": "p1", "duration_min": 30}]}})
    _post(client, "/api/todos/details", {"id": "a", "place_id": "", "duration_min": 0})
    it = read_todos()["now"]["items"][0]
    assert "place_id" not in it and "duration_min" not in it


def test_details_only_touches_present_fields(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False, "place_id": "keep"}]}})
    _post(client, "/api/todos/details", {"id": "a", "notes": "new note"})
    it = read_todos()["now"]["items"][0]
    assert it["place_id"] == "keep"   # untouched because not in payload
    assert it["notes"] == "new note"


def test_details_sets_then_clears_fronts(client, seed):
    """Life-domain tagging is the `fronts` LIST (ids from fronts.json, so an
    item can sit on several fronts at once); details sets it, dedupes it, and
    an empty list clears it (absent = untagged), same contract as the attrs."""
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    _post(client, "/api/todos/details", {"id": "a", "fronts": ["connection", "health", "connection"]})
    assert read_todos()["now"]["items"][0]["fronts"] == ["connection", "health"]
    _post(client, "/api/todos/details", {"id": "a", "fronts": []})
    assert "fronts" not in read_todos()["now"]["items"][0]


def test_details_accepts_legacy_theme_string_as_fronts_alias(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    _post(client, "/api/todos/details", {"id": "a", "theme": "job"})
    it = read_todos()["now"]["items"][0]
    assert it["fronts"] == ["job"] and "theme" not in it
    _post(client, "/api/todos/details", {"id": "a", "theme": ""})
    assert "fronts" not in read_todos()["now"]["items"][0]


def test_details_sets_then_clears_after_fields(client, seed):
    """The "do after" feature reuses the details/clear contract: after_date
    and after_id are set together and each clears independently on ""."""
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    _post(client, "/api/todos/details", {"id": "a", "after_date": "2026-08-01", "after_id": "b"})
    it = read_todos()["now"]["items"][0]
    assert it["after_date"] == "2026-08-01" and it["after_id"] == "b"
    _post(client, "/api/todos/details", {"id": "a", "after_date": "", "after_id": ""})
    it = read_todos()["now"]["items"][0]
    assert "after_date" not in it and "after_id" not in it


# --- cleared / finished --------------------------------------------------------

def test_details_sets_then_clears_finished_fields(client, seed):
    """finished_on/finished_time follow the same set/clear contract as the
    other detail attrs (empty string clears; distinct from done_at)."""
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    _post(client, "/api/todos/details", {"id": "a", "finished_on": "2026-07-19", "finished_time": "09:15"})
    it = read_todos()["now"]["items"][0]
    assert it["finished_on"] == "2026-07-19" and it["finished_time"] == "09:15"
    _post(client, "/api/todos/details", {"id": "a", "finished_on": "", "finished_time": ""})
    it = read_todos()["now"]["items"][0]
    assert "finished_on" not in it and "finished_time" not in it


def test_details_sets_then_clears_finished_note(client, seed):
    """finished_note ("how it went") follows the same set/clear contract as
    the other detail attrs, and is distinct from the item's `notes`."""
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False, "notes": "keep me"}]}})
    _post(client, "/api/todos/details", {"id": "a", "finished_note": "went great"})
    it = read_todos()["now"]["items"][0]
    assert it["finished_note"] == "went great"
    assert it["notes"] == "keep me"   # unrelated to the description notes field
    _post(client, "/api/todos/details", {"id": "a", "finished_note": ""})
    it = read_todos()["now"]["items"][0]
    assert "finished_note" not in it
    assert it["notes"] == "keep me"


def test_cleared_matches_datetime_done_at(client, seed):
    # done_at is now minute-precision; matching against ?date must compare
    # only the day part.
    seed({"now": {"items": [
        {"id": "a", "text": "Minute stamped", "done": True, "done_at": "2026-07-19T09:15"},
    ]}})
    r = client.get("/api/todos/cleared?date=2026-07-19")
    got = {i["id"] for i in r.get_json()["items"]}
    assert got == {"a"}


def test_cleared_marked_and_note_passthrough(client, seed):
    seed({"now": {"items": [
        {"id": "a", "text": "With both", "done": True, "done_at": "2026-07-19T09:15",
         "finished_note": "went great"},
        {"id": "b", "text": "Neither", "done": True, "finished_on": "2026-07-19"},
    ]}})
    items = client.get("/api/todos/cleared?date=2026-07-19").get_json()["items"]
    by_id = {i["id"]: i for i in items}
    assert by_id["a"]["marked"] == "2026-07-19T09:15"   # raw done_at, unformatted
    assert by_id["a"]["note"] == "went great"
    assert "marked" not in by_id["b"]   # no done_at at all -> absent
    assert "note" not in by_id["b"]     # no finished_note -> absent


def test_cleared_matches_done_at_across_buckets(client, seed):
    seed({
        "now": {"items": [
            {"id": "a", "text": "Ladder done", "done": True, "done_at": "2026-07-19"},
            {"id": "b", "text": "Not done", "done": False},
            {"id": "c", "text": "Other day", "done": True, "done_at": "2026-07-18"},
        ]},
        "done": {"items": [
            {"id": "d", "text": "Archived done", "done": True, "done_at": "2026-07-19"},
        ]},
    })
    r = client.get("/api/todos/cleared?date=2026-07-19")
    body = r.get_json()
    got = {(i["id"], i["text"]) for i in body["items"]}
    assert got == {("a", "Ladder done"), ("d", "Archived done")}
    assert all("time" not in i for i in body["items"])


def test_cleared_finished_on_overrides_done_at(client, seed):
    seed({"now": {"items": [
        {"id": "a", "text": "A", "done": True, "done_at": "2026-07-19", "finished_on": "2026-07-20"},
        {"id": "b", "text": "B", "done": True, "done_at": "2026-07-20", "finished_on": "2026-07-19"},
    ]}})
    today = {i["id"] for i in client.get("/api/todos/cleared?date=2026-07-20").get_json()["items"]}
    yesterday = {i["id"] for i in client.get("/api/todos/cleared?date=2026-07-19").get_json()["items"]}
    assert today == {"a"}
    assert yesterday == {"b"}


def test_cleared_time_passthrough_requires_finished_on(client, seed):
    seed({"now": {"items": [
        {"id": "a", "text": "A", "done": True, "finished_on": "2026-07-19", "finished_time": "14:30"},
        {"id": "b", "text": "B", "done": True, "done_at": "2026-07-19", "finished_time": "08:00"},
    ]}})
    items = client.get("/api/todos/cleared?date=2026-07-19").get_json()["items"]
    by_id = {i["id"]: i for i in items}
    assert by_id["a"]["time"] == "14:30"
    assert "time" not in by_id["b"]


def test_cleared_missing_date_returns_empty(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": True, "done_at": "2026-07-19"}]}})
    r = client.get("/api/todos/cleared")
    assert r.get_json() == {"items": [], "marked_items": []}


def test_cleared_marker_moment_prefers_the_edited_claim(client, seed):
    seed({"now": {"items": [
        # Untouched timed tap — marker at the tap minute.
        {"id": "a", "text": "Timed tap", "done": True, "done_at": "2026-07-19T09:15"},
        # Legacy day-only stamp — no minute, no marker (summary card only).
        {"id": "b", "text": "Legacy tap", "done": True, "done_at": "2026-07-19"},
        # Claimed a full moment — marker moves to the claim, off the tap day.
        {"id": "c", "text": "Claimed moment", "done": True,
         "done_at": "2026-07-19T10:00", "finished_on": "2026-07-18", "finished_time": "08:00"},
        # Claimed a day without a time — claim overrides the tap, no minute,
        # so no marker anywhere.
        {"id": "d", "text": "Day-only claim", "done": True,
         "done_at": "2026-07-19T11:00", "finished_on": "2026-07-18"},
    ]}})
    day19 = client.get("/api/todos/cleared?date=2026-07-19").get_json()
    assert day19["marked_items"] == [{"id": "a", "text": "Timed tap", "time": "09:15"}]
    # Summary still files by EFFECTIVE day: a and b here, c and d on the 18th.
    assert {i["id"] for i in day19["items"]} == {"a", "b"}
    day18 = client.get("/api/todos/cleared?date=2026-07-18").get_json()
    assert day18["marked_items"] == [{"id": "c", "text": "Claimed moment", "time": "08:00"}]
    assert {i["id"] for i in day18["items"]} == {"c", "d"}


# --- snooze ------------------------------------------------------------------

def test_snooze_sets_and_clears(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    _post(client, "/api/todos/snooze", {"id": "a", "days": 7})
    assert read_todos()["now"]["items"][0]["snoozed_until"]
    _post(client, "/api/todos/snooze", {"id": "a", "days": 0})
    assert "snoozed_until" not in read_todos()["now"]["items"][0]


def test_add_with_more_details_persists_attributes(client):
    res = client.post("/api/todos/add", json={
        "item": "drop off package", "section": "Now",
        "due_by": "2026-06-13", "due_time": "14:30",
        "category": "car", "duration_min": "15",
        "fronts": ["finances", "errands"], "notes": "the UPS one",
    })
    assert res.status_code == 200
    from tests.conftest import read_todos
    item = read_todos()["now"]["items"][0]
    assert item["due_time"] == "14:30"
    assert "category" not in item   # retired 2026-07-14 (fronts vocabulary); silently ignored
    assert item["fronts"] == ["finances", "errands"]
    assert item["duration_min"] == 15


def test_add_accepts_after_fields(client, seed):
    seed()
    res = client.post("/api/todos/add", json={
        "item": "unpack boxes", "section": "Later",
        "after_date": "2026-08-01", "after_id": "movein",
    })
    assert res.status_code == 200
    item = read_todos()["later"]["items"][0]
    assert item["after_date"] == "2026-08-01"
    assert item["after_id"] == "movein"


# --- bulk --------------------------------------------------------------------

def test_bulk_details_patches_all_matched_leaves_others(client, seed):
    seed({"now": {"items": [
        {"id": "a", "text": "A", "done": False},
        {"id": "b", "text": "B", "done": False},
        {"id": "c", "text": "C", "done": False, "fronts": ["keep"]},
    ]}})
    r = _post(client, "/api/todos/bulk",
              {"ids": ["a", "b"], "action": "details", "patch": {"fronts": ["job"]}})
    assert r.get_json() == {"ok": True, "updated": 2, "missing": []}
    by_id = {i["id"]: i for i in read_todos()["now"]["items"]}
    assert by_id["a"]["fronts"] == ["job"]
    assert by_id["b"]["fronts"] == ["job"]
    assert by_id["c"]["fronts"] == ["keep"]


def test_bulk_details_empty_value_clears_field(client, seed):
    seed({"now": {"items": [
        {"id": "a", "text": "A", "done": False, "duration_min": 30},
        {"id": "b", "text": "B", "done": False, "place_id": "p1"},
    ]}})
    _post(client, "/api/todos/bulk",
          {"ids": ["a", "b"], "action": "details", "patch": {"place_id": "", "duration_min": 0}})
    for it in read_todos()["now"]["items"]:
        assert "place_id" not in it and "duration_min" not in it


def test_bulk_snooze_sets_until_and_zero_clears(client, seed):
    seed({"now": {"items": [
        {"id": "a", "text": "A", "done": False},
        {"id": "b", "text": "B", "done": False},
    ]}})
    _post(client, "/api/todos/bulk", {"ids": ["a", "b"], "action": "snooze", "days": 3})
    for it in read_todos()["now"]["items"]:
        assert it["snoozed_until"]
    _post(client, "/api/todos/bulk", {"ids": ["a", "b"], "action": "snooze", "days": 0})
    for it in read_todos()["now"]["items"]:
        assert "snoozed_until" not in it


def test_bulk_move_appends_to_target_across_sections(client, seed):
    # Matched items from every section land appended to the target in
    # encounter order; an item already in the target stays where it is.
    seed({
        "now": {"items": [{"id": "a", "text": "A", "done": False}]},
        "up_next": {"items": [{"id": "b", "text": "B", "done": False}]},
        "later": {"items": [
            {"id": "old", "text": "Old", "done": False},
            {"id": "c", "text": "C", "done": False},
        ]},
    })
    r = _post(client, "/api/todos/bulk",
              {"ids": ["a", "b", "c"], "action": "move", "to_section": "Later"})
    assert r.get_json() == {"ok": True, "updated": 2, "missing": []}
    data = read_todos()
    assert data["now"]["items"] == [] and data["up_next"]["items"] == []
    assert [i["id"] for i in data["later"]["items"]] == ["old", "c", "a", "b"]


def test_bulk_move_unknown_section_404_leaves_data_untouched(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    before = read_todos()
    r = _post(client, "/api/todos/bulk",
              {"ids": ["a"], "action": "move", "to_section": "Nope"})
    assert r.status_code == 404
    assert read_todos() == before


def test_bulk_remove_deletes_all_matched(client, seed):
    seed({
        "now": {"items": [
            {"id": "a", "text": "A", "done": False},
            {"id": "b", "text": "B", "done": False},
        ]},
        "later": {"items": [{"id": "c", "text": "C", "done": False}]},
    })
    r = _post(client, "/api/todos/bulk", {"ids": ["a", "c"], "action": "remove"})
    assert r.get_json() == {"ok": True, "updated": 2, "missing": []}
    data = read_todos()
    assert [i["id"] for i in data["now"]["items"]] == ["b"]
    assert data["later"]["items"] == []


def test_bulk_applies_matched_and_reports_missing(client, seed):
    # Partially-missing ids aren't an error: an id can vanish between the
    # client's last poll and the tap. Matched items still get the action.
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    r = _post(client, "/api/todos/bulk",
              {"ids": ["a", "ghost"], "action": "snooze", "days": 2})
    assert r.get_json() == {"ok": True, "updated": 1, "missing": ["ghost"]}
    assert read_todos()["now"]["items"][0]["snoozed_until"]


def test_bulk_empty_ids_is_noop(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    r = _post(client, "/api/todos/bulk", {"ids": [], "action": "remove"})
    assert r.status_code == 200
    assert r.get_json() == {"ok": True, "updated": 0, "missing": []}
    assert len(read_todos()["now"]["items"]) == 1


def test_bulk_unknown_action_400(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "A", "done": False}]}})
    r = _post(client, "/api/todos/bulk", {"ids": ["a"], "action": "explode"})
    assert r.status_code == 400
    assert read_todos()["now"]["items"][0] == {"id": "a", "text": "A", "done": False}


def test_bulk_text_fallback_still_matches(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "Water plants", "done": False}]}})
    r = _post(client, "/api/todos/bulk",
              {"ids": ["Water plants"], "action": "snooze", "days": 1})
    assert r.get_json() == {"ok": True, "updated": 1, "missing": []}
    assert read_todos()["now"]["items"][0]["snoozed_until"]


# --- subtasks ------------------------------------------------------------------

def test_subtask_add_persists_with_id_text_and_done_false(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "Plan trip", "done": False}]}})
    r = _post(client, "/api/todos/subtask/add", {"id": "a", "text": "book flights"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True and body["sub_id"]
    subs = read_todos()["now"]["items"][0]["subtasks"]
    assert len(subs) == 1
    assert subs[0] == {"id": body["sub_id"], "text": "book flights", "done": False}


def test_subtask_add_strips_and_ignores_empty_text(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "Plan trip", "done": False}]}})
    _post(client, "/api/todos/subtask/add", {"id": "a", "text": "   "})
    assert "subtasks" not in read_todos()["now"]["items"][0]
    _post(client, "/api/todos/subtask/add", {"id": "a", "text": "  book hotel  "})
    subs = read_todos()["now"]["items"][0]["subtasks"]
    assert subs[0]["text"] == "book hotel"


def test_subtask_toggle_flips_only_that_one(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "Plan trip", "done": False, "subtasks": [
        {"id": "s1", "text": "book flights", "done": False},
        {"id": "s2", "text": "book hotel", "done": False},
    ]}]}})
    _post(client, "/api/todos/subtask/toggle", {"id": "a", "sub_id": "s1"})
    subs = {s["id"]: s for s in read_todos()["now"]["items"][0]["subtasks"]}
    assert subs["s1"]["done"] is True
    assert subs["s2"]["done"] is False
    _post(client, "/api/todos/subtask/toggle", {"id": "a", "sub_id": "s1"})
    subs = {s["id"]: s for s in read_todos()["now"]["items"][0]["subtasks"]}
    assert subs["s1"]["done"] is False


def test_subtask_remove_deletes_it_and_pops_key_when_last(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "Plan trip", "done": False, "subtasks": [
        {"id": "s1", "text": "book flights", "done": False},
        {"id": "s2", "text": "book hotel", "done": False},
    ]}]}})
    _post(client, "/api/todos/subtask/remove", {"id": "a", "sub_id": "s1"})
    it = read_todos()["now"]["items"][0]
    assert [s["id"] for s in it["subtasks"]] == ["s2"]
    _post(client, "/api/todos/subtask/remove", {"id": "a", "sub_id": "s2"})
    it = read_todos()["now"]["items"][0]
    assert "subtasks" not in it


def test_toggle_parent_to_done_marks_all_subtasks_done(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "Plan trip", "done": False, "subtasks": [
        {"id": "s1", "text": "book flights", "done": False},
        {"id": "s2", "text": "book hotel", "done": True},
    ]}]}})
    _post(client, "/api/todos/toggle", {"id": "a"})
    subs = read_todos()["now"]["items"][0]["subtasks"]
    assert all(s["done"] for s in subs)


def test_toggle_parent_back_to_not_done_leaves_subtasks_done(client, seed):
    seed({"now": {"items": [{"id": "a", "text": "Plan trip", "done": False, "subtasks": [
        {"id": "s1", "text": "book flights", "done": False},
    ]}]}})
    _post(client, "/api/todos/toggle", {"id": "a"})   # -> done, cascades subtasks
    _post(client, "/api/todos/toggle", {"id": "a"})   # -> not done again
    it = read_todos()["now"]["items"][0]
    assert it["done"] is False
    assert it["subtasks"][0]["done"] is True   # left as-is, not un-cascaded


def test_add_skips_empty_and_bad_attributes(client):
    client.post("/api/todos/add", json={
        "item": "plain one", "section": "Now",
        "due_time": "", "category": "", "duration_min": "nope",
    })
    from tests.conftest import read_todos
    item = read_todos()["now"]["items"][0]
    for f in ("due_time", "category", "duration_min"):
        assert f not in item
