"""Behavioral tests for the Kitchen API (routes/kitchen.py).

Kitchen is the biggest feature: an active grocery list backed by a catalog
(category_map + purchase_counts + aisles + notes), a pantry, shopping-trip
logs, weekly meal-prep defaults, and saved recipes. These tests pin the HTTP
contract of every pure-JSON route — the parts that can silently break.

NOT covered here: the receipt/recipe *agent pipelines* (scan-receipt,
parse-recipe-url, parsed-receipts/...) — they shell out to tmux and write to
module-level receipt dirs, so they're exercised manually, not in unit tests.

Same shape as test_todos_routes: a minimal app with only this blueprint, an
isolated temp data dir (via the `data_dir` fixture), read back through `store`.
"""
import json
from datetime import datetime

import pytest

import store


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the kitchen routes."""
    from flask import Flask
    from routes import kitchen
    app = Flask(__name__)
    app.config.update(TESTING=True)
    kitchen.register(app)
    return app.test_client()


def _post(client, path, payload=None):
    return client.post(path, data=json.dumps(payload or {}), content_type="application/json")


def read_kitchen():
    return store.read("kitchen", {})


def _today():
    return datetime.now().strftime("%Y-%m-%d")


# --- active list ---------------------------------------------------------------

def test_add_puts_item_on_list_and_remembers_category(client):
    r = _post(client, "/api/kitchen/add", {"name": "Spinach", "category": "produce"})
    assert r.status_code == 200
    g = read_kitchen()
    assert g["items"] == [{"name": "Spinach", "category": "produce", "checked": False}]
    assert g["category_map"]["spinach"] == "produce"


def test_add_rejects_duplicate_case_insensitively(client):
    _post(client, "/api/kitchen/add", {"name": "Spinach", "category": "produce"})
    r = _post(client, "/api/kitchen/add", {"name": "spinach"})
    assert r.status_code == 400
    assert len(read_kitchen()["items"]) == 1


def test_add_falls_back_to_remembered_category(client):
    store.write("kitchen", {"items": [], "category_map": {"milk": "dairy"}})
    _post(client, "/api/kitchen/add", {"name": "Milk"})
    assert read_kitchen()["items"][0]["category"] == "dairy"


def test_add_with_category_upserts_catalog_even_if_already_listed(client):
    _post(client, "/api/kitchen/add", {"name": "Milk", "category": "other"})
    r = _post(client, "/api/kitchen/add-with-category", {"name": "Milk", "category": "dairy"})
    assert r.get_json()["already_on_list"] is True
    g = read_kitchen()
    assert g["category_map"]["milk"] == "dairy"
    assert len(g["items"]) == 1


def test_add_with_category_rejects_empty_name(client):
    assert _post(client, "/api/kitchen/add-with-category", {"name": "  "}).status_code == 400


def test_toggle_checks_item_and_counts_purchase(client):
    _post(client, "/api/kitchen/add", {"name": "Milk"})
    r = _post(client, "/api/kitchen/toggle", {"name": "Milk"})
    g = read_kitchen()
    assert g["items"][0]["checked"] is True
    assert g["purchase_counts"]["milk"] == 1
    assert r.get_json()["all_checked"] is True


def test_untoggle_decrements_purchase_count(client):
    _post(client, "/api/kitchen/add", {"name": "Milk"})
    _post(client, "/api/kitchen/toggle", {"name": "Milk"})
    _post(client, "/api/kitchen/toggle", {"name": "Milk"})
    g = read_kitchen()
    assert g["items"][0]["checked"] is False
    assert g["purchase_counts"]["milk"] == 0


def test_toggle_reports_all_checked_false_when_others_remain(client):
    _post(client, "/api/kitchen/add", {"name": "Milk"})
    _post(client, "/api/kitchen/add", {"name": "Eggs"})
    r = _post(client, "/api/kitchen/toggle", {"name": "Milk"})
    assert r.get_json()["all_checked"] is False


def test_remove_checked_item_undoes_its_purchase_count(client):
    _post(client, "/api/kitchen/add", {"name": "Milk"})
    _post(client, "/api/kitchen/toggle", {"name": "Milk"})
    _post(client, "/api/kitchen/remove", {"name": "Milk"})
    g = read_kitchen()
    assert g["items"] == []
    assert g["purchase_counts"]["milk"] == 0


def test_remove_unchecked_item_leaves_counts_alone(client):
    store.write("kitchen", {
        "items": [{"name": "Milk", "category": "other", "checked": False}],
        "category_map": {},
        "purchase_counts": {"milk": 5},
    })
    _post(client, "/api/kitchen/remove", {"name": "Milk"})
    assert read_kitchen()["purchase_counts"]["milk"] == 5


def test_item_note_sets_note_case_insensitively(client):
    _post(client, "/api/kitchen/add", {"name": "Milk"})
    _post(client, "/api/kitchen/item/note", {"name": "milk", "note": "lactose-free"})
    assert read_kitchen()["items"][0]["note"] == "lactose-free"


def test_safety_tag_set_and_clear(client):
    _post(client, "/api/kitchen/safety-tag", {"name": "Oats", "tag": "inflammatory"})
    assert read_kitchen()["safety_tags"]["oats"] == "inflammatory"
    _post(client, "/api/kitchen/safety-tag", {"name": "Oats", "tag": ""})
    assert "oats" not in read_kitchen()["safety_tags"]


def test_safety_tag_rejects_unknown_tag(client):
    assert _post(client, "/api/kitchen/safety-tag", {"name": "Oats", "tag": "scary"}).status_code == 400


def test_clear_moves_checked_to_pantry_and_logs_one_trip(client):
    _post(client, "/api/kitchen/add", {"name": "Milk"})
    _post(client, "/api/kitchen/add", {"name": "Eggs"})
    _post(client, "/api/kitchen/toggle", {"name": "Milk"})
    _post(client, "/api/kitchen/clear")
    _post(client, "/api/kitchen/clear")  # second clear same day must not double-log
    g = read_kitchen()
    assert [i["name"] for i in g["items"]] == ["Eggs"]
    assert g["pantry"]["milk"] == {"added": _today()}
    trips = store.read("kitchen_trips", {"trips": []})["trips"]
    assert trips == [{"date": _today()}]


def test_clear_all_empties_list_but_keeps_catalog(client):
    _post(client, "/api/kitchen/add", {"name": "Milk", "category": "dairy"})
    _post(client, "/api/kitchen/clear-all")
    g = read_kitchen()
    assert g["items"] == []
    assert g["category_map"]["milk"] == "dairy"


# --- pantry ----------------------------------------------------------------------

def test_pantry_add_and_remove(client):
    _post(client, "/api/kitchen/pantry/add", {"name": "Rice"})
    assert read_kitchen()["pantry"]["rice"] == {"added": _today()}
    _post(client, "/api/kitchen/pantry/remove", {"name": "Rice"})
    assert "rice" not in read_kitchen()["pantry"]


def test_pantry_need_moves_item_back_to_list_with_remembered_category(client):
    store.write("kitchen", {
        "items": [], "category_map": {"rice": "grains"},
        "pantry": {"rice": {"added": "2026-06-01"}},
    })
    _post(client, "/api/kitchen/pantry/need", {"name": "Rice"})
    g = read_kitchen()
    assert g["pantry"] == {}
    assert g["items"] == [{"name": "Rice", "category": "grains", "checked": False}]


def test_pantry_need_does_not_duplicate_listed_item(client):
    _post(client, "/api/kitchen/add", {"name": "Rice"})
    _post(client, "/api/kitchen/pantry/add", {"name": "Rice"})
    _post(client, "/api/kitchen/pantry/need", {"name": "rice"})
    assert len(read_kitchen()["items"]) == 1


# --- aisles / locations / categories ----------------------------------------------

def test_aisle_set_and_clear_keeps_category_map_consistent(client):
    _post(client, "/api/kitchen/aisle/set", {"name": "Tahini", "aisle": 7})
    g = read_kitchen()
    assert g["aisles"]["tahini"] == 7
    assert g["category_map"]["tahini"] == "@aisles"
    _post(client, "/api/kitchen/aisle/set", {"name": "Tahini", "aisle": None})
    g = read_kitchen()
    assert "tahini" not in g["aisles"]
    assert g["category_map"]["tahini"] == "other"


def test_aisle_set_rejects_garbage(client):
    assert _post(client, "/api/kitchen/aisle/set", {"name": "Tahini", "aisle": "seven"}).status_code == 400


def test_location_set_handles_aisle_section_and_clear(client):
    _post(client, "/api/kitchen/location/set", {"name": "Tahini", "location": "aisle:5"})
    g = read_kitchen()
    assert g["aisles"]["tahini"] == 5 and g["category_map"]["tahini"] == "@aisles"
    _post(client, "/api/kitchen/location/set", {"name": "Tahini", "location": "produce"})
    g = read_kitchen()
    assert "tahini" not in g["aisles"] and g["category_map"]["tahini"] == "produce"
    _post(client, "/api/kitchen/location/set", {"name": "Tahini", "location": ""})
    assert read_kitchen()["category_map"]["tahini"] == "other"


def test_category_rename_touches_order_map_and_items(client):
    store.write("kitchen", {
        "items": [{"name": "Milk", "category": "dairy", "checked": False}],
        "category_map": {"milk": "dairy", "rice": "grains"},
        "category_order": ["dairy", "grains"],
    })
    _post(client, "/api/kitchen/category/rename", {"old": "dairy", "new": "fridge"})
    g = read_kitchen()
    assert g["category_order"] == ["fridge", "grains"]
    assert g["category_map"]["milk"] == "fridge"
    assert g["items"][0]["category"] == "fridge"


def test_category_rename_into_existing_merges_order_slots(client):
    store.write("kitchen", {"items": [], "category_map": {},
                            "category_order": ["dairy", "fridge"]})
    _post(client, "/api/kitchen/category/rename", {"old": "dairy", "new": "fridge"})
    assert read_kitchen()["category_order"] == ["fridge"]


def test_category_rename_protects_aisles_sentinel(client):
    assert _post(client, "/api/kitchen/category/rename",
                 {"old": "@aisles", "new": "x"}).status_code == 400


def test_category_delete_reassigns_and_counts_moves(client):
    store.write("kitchen", {
        "items": [{"name": "Milk", "category": "dairy", "checked": False}],
        "category_map": {"yogurt": "dairy"},
        "category_order": ["dairy", "other"],
    })
    r = _post(client, "/api/kitchen/category/delete", {"name": "dairy"})
    assert r.get_json()["moved"] == 2
    g = read_kitchen()
    assert g["category_order"] == ["other"]
    assert g["category_map"]["yogurt"] == "other"
    assert g["items"][0]["category"] == "other"


def test_category_order_saved_verbatim(client):
    _post(client, "/api/kitchen/category-order", {"order": ["produce", "dairy", "other"]})
    assert read_kitchen()["category_order"] == ["produce", "dairy", "other"]


# --- catalog -----------------------------------------------------------------------

def test_catalog_add_does_not_downgrade_known_category_to_other(client):
    _post(client, "/api/kitchen/catalog/add", {"name": "Milk", "category": "dairy"})
    _post(client, "/api/kitchen/catalog/add", {"name": "Milk", "category": "other"})
    assert read_kitchen()["category_map"]["milk"] == "dairy"


def test_catalog_remove_drops_map_and_counts(client):
    store.write("kitchen", {"items": [], "category_map": {"milk": "dairy"},
                            "purchase_counts": {"milk": 4}})
    _post(client, "/api/kitchen/catalog/remove", {"name": "Milk"})
    g = read_kitchen()
    assert "milk" not in g["category_map"]
    assert "milk" not in g["purchase_counts"]


def test_catalog_rename_migrates_every_keyed_map_and_display_casing(client):
    store.write("kitchen", {
        "items": [{"name": "Oat milk", "category": "dairy", "checked": False}],
        "category_map": {"oat milk": "dairy"},
        "purchase_counts": {"oat milk": 3},
        "aisles": {"oat milk": 9},
        "item_notes": {"oat milk": "unsweetened"},
        "last_bought": {"oat milk": "2026-06-01"},
        "pantry": {"oat milk": {"added": "2026-06-01"}},
    })
    _post(client, "/api/kitchen/catalog/rename",
          {"old_name": "Oat Milk", "new_name": "Oatly Milk"})
    g = read_kitchen()
    for m in ("category_map", "purchase_counts", "aisles", "item_notes", "last_bought", "pantry"):
        assert "oatly milk" in g[m], m
        assert "oat milk" not in g[m], m
    assert g["items"][0]["name"] == "Oatly Milk"  # user's casing preserved


def test_catalog_note_set_and_clear(client):
    _post(client, "/api/kitchen/catalog/note", {"name": "Milk", "note": "2%"})
    assert read_kitchen()["item_notes"]["milk"] == "2%"
    _post(client, "/api/kitchen/catalog/note", {"name": "Milk", "note": ""})
    assert "milk" not in read_kitchen()["item_notes"]


# --- meal notes ----------------------------------------------------------------------

def test_meal_note_added_at_front_with_date(client):
    _post(client, "/api/kitchen/meal-notes", {"text": "first"})
    _post(client, "/api/kitchen/meal-notes", {"text": "second"})
    notes = store.read("meal_notes", [])
    assert [n["text"] for n in notes] == ["second", "first"]
    assert notes[0]["date"] == _today()


def test_meal_note_rejects_empty_and_caps_at_fifty(client):
    assert _post(client, "/api/kitchen/meal-notes", {"text": "  "}).status_code == 400
    store.write("meal_notes", [{"date": "2026-01-01", "text": f"n{i}"} for i in range(50)])
    _post(client, "/api/kitchen/meal-notes", {"text": "newest"})
    notes = store.read("meal_notes", [])
    assert len(notes) == 50 and notes[0]["text"] == "newest"


def test_meal_note_delete_by_index_ignores_out_of_range(client):
    store.write("meal_notes", [{"date": "d", "text": "a"}, {"date": "d", "text": "b"}])
    _post(client, "/api/kitchen/meal-notes/delete", {"index": 0})
    assert [n["text"] for n in store.read("meal_notes", [])] == ["b"]
    _post(client, "/api/kitchen/meal-notes/delete", {"index": 99})
    assert len(store.read("meal_notes", [])) == 1


# --- trips -----------------------------------------------------------------------------

def test_trip_log_is_idempotent_per_date_and_sorted(client):
    _post(client, "/api/kitchen/trips/log", {"date": "2026-06-10"})
    _post(client, "/api/kitchen/trips/log", {"date": "2026-06-08"})
    _post(client, "/api/kitchen/trips/log", {"date": "2026-06-10"})
    trips = store.read("kitchen_trips", {"trips": []})["trips"]
    assert [t["date"] for t in trips] == ["2026-06-08", "2026-06-10"]


def test_trip_remove_drops_only_that_date(client):
    _post(client, "/api/kitchen/trips/log", {"date": "2026-06-10"})
    _post(client, "/api/kitchen/trips/log", {"date": "2026-06-08"})
    _post(client, "/api/kitchen/trips/remove", {"date": "2026-06-10"})
    trips = store.read("kitchen_trips", {"trips": []})["trips"]
    assert [t["date"] for t in trips] == ["2026-06-08"]


# --- meal defaults / weekly meal prep -----------------------------------------------------

def test_this_week_vegetables_caps_at_two_and_stamps_week(client):
    _post(client, "/api/meal-defaults/this-week/vegetables",
          {"vegetables": ["kale", "carrots", "beets"]})
    tw = store.read("meal_defaults", {})["meal_prep"]["this_week"]
    assert tw["vegetables"] == ["kale", "carrots"]
    assert tw["week_of"] == _today()


def test_this_week_protein_rejects_empty(client):
    assert _post(client, "/api/meal-defaults/this-week/protein", {"protein": ""}).status_code == 400
    _post(client, "/api/meal-defaults/this-week/protein", {"protein": "salmon"})
    assert store.read("meal_defaults", {})["meal_prep"]["this_week"]["protein"] == "salmon"


def test_side_salad_toggle_flips_and_accepts_explicit(client):
    r = _post(client, "/api/meal-defaults/side-salad/toggle")
    assert r.get_json()["enabled"] is True
    r = _post(client, "/api/meal-defaults/side-salad/toggle", {"enabled": False})
    assert r.get_json()["enabled"] is False
    assert store.read("meal_defaults", {})["side_salad"]["enabled_this_week"] is False


def test_generate_list_is_pantry_aware_for_staples_only(client):
    store.write("meal_defaults", {
        "meal_prep": {
            "grain": "rice",
            "always_vegetables": ["onion"],
            "this_week": {"protein": "salmon", "vegetables": ["kale"]},
        },
        "breakfast_staples": ["kefir"],
    })
    store.write("kitchen", {
        "items": [{"name": "kale", "category": "produce", "checked": False}],
        "category_map": {"rice": "grains"},
        # rice + onion both in pantry: rice (pantry-aware) skipped, onion (core) still added
        "pantry": {"rice": {"added": "2026-06-01"}, "onion": {"added": "2026-06-01"}},
    })
    r = _post(client, "/api/meal-defaults/generate-list")
    out = r.get_json()
    assert sorted(out["added"]) == ["kefir", "onion", "salmon"]
    assert out["skipped_in_pantry"] == ["rice"]
    assert out["skipped_already_on_list"] == ["kale"]


def test_generate_list_auto_rotates_to_least_recently_bought_protein(client):
    store.write("meal_defaults", {
        "meal_prep": {"protein_rotation": ["chicken", "beef"], "this_week": {}},
    })
    store.write("kitchen", {"items": [], "category_map": {},
                            "last_bought": {"chicken": "2026-06-10", "beef": "2026-05-01"}})
    r = _post(client, "/api/meal-defaults/generate-list")
    assert "beef" in r.get_json()["added"]
    assert store.read("meal_defaults", {})["meal_prep"]["this_week"]["protein"] == "beef"


# --- recipes (CRUD + to-grocery; the parse pipeline is agent-driven, not tested) -------------

def _save_recipe(client, **recipe):
    recipe.setdefault("name", "Lentil soup")
    r = _post(client, "/api/kitchen/recipes/save", {"recipe": recipe})
    assert r.status_code == 200
    return r.get_json()["id"]


def read_recipes():
    return store.read("recipes", {"recipes": []})["recipes"]


def test_recipe_save_mints_id_and_created(client):
    rid = _save_recipe(client)
    rec = read_recipes()[0]
    assert rec["id"] == rid and rec["created"] == _today()


def test_recipe_save_requires_name(client):
    assert _post(client, "/api/kitchen/recipes/save", {"recipe": {}}).status_code == 400


def test_recipe_resave_preserves_lineage_fields(client):
    store.write("recipes", {"recipes": [
        {"id": "abc", "name": "Soup", "parent_id": "old", "is_archived": True},
    ]})
    _post(client, "/api/kitchen/recipes/save", {"recipe": {"id": "abc", "name": "Soup v2"}})
    rec = read_recipes()[0]
    assert rec["name"] == "Soup v2"
    assert rec["parent_id"] == "old" and rec["is_archived"] is True


def test_save_as_variant_archives_parent_and_links_child(client):
    pid = _save_recipe(client, name="Soup")
    r = _post(client, "/api/kitchen/recipes/save-as-variant",
              {"recipe": {"id": pid, "name": "Soup, spicier"}})
    new_id = r.get_json()["id"]
    by_id = {x["id"]: x for x in read_recipes()}
    assert by_id[pid]["is_archived"] is True
    child = by_id[new_id]
    assert child["parent_id"] == pid and child["is_archived"] is False


def test_recipe_remove_restitches_chain_and_promotes_parent(client):
    store.write("recipes", {"recipes": [
        {"id": "v1", "name": "Soup", "is_archived": True},
        {"id": "v2", "name": "Soup 2", "parent_id": "v1", "is_archived": False},
    ]})
    _post(client, "/api/kitchen/recipes/remove", {"id": "v2"})
    recs = read_recipes()
    assert [r["id"] for r in recs] == ["v1"]
    assert recs[0]["is_archived"] is False  # promoted back to active head


def test_recipe_my_notes_404s_on_unknown_id(client):
    assert _post(client, "/api/kitchen/recipes/my-notes/save",
                 {"id": "nope", "my_notes": "x"}).status_code == 404


def test_recipe_to_grocery_filters_and_maps_through_catalog(client):
    store.write("recipes", {"recipes": [{
        "id": "r1", "name": "Salad",
        "choice_groups": [{"id": "g1", "members": ["feta", "goat cheese"]}],
        "ingredients": [
            {"item": "Baby spinach", "qty": "2 cups", "category": "produce"},
            {"item": "Salt", "stocking_status": "n_a"},
            {"item": "feta"},
            {"item": "goat cheese"},
            {"item": "Walnuts", "category": "snacks"},
        ],
    }]})
    store.write("kitchen", {"items": [], "category_map": {"spinach": "produce"}})
    r = _post(client, "/api/kitchen/recipes/to-grocery",
              {"id": "r1", "skip": ["walnuts"], "picks": {"g1": ["feta"]}})
    out = r.get_json()
    assert out["added"] == 2  # Spinach (mapped via catalog) + feta (picked)
    assert out["skipped_na"] == 1 and out["skipped_unpicked"] == 1 and out["skipped_unchecked"] == 1
    g = read_kitchen()
    names = {i["name"]: i for i in g["items"]}
    # "Baby spinach" canonicalized to the catalog item, with qty carried as the note
    assert "Spinach" in names and names["Spinach"]["note"] == "2 cups"
    assert names["Spinach"]["category"] == "produce"
    # picks remembered on the recipe for next time
    assert read_recipes()[0]["last_picks"] == {"g1": ["feta"]}


def test_catalog_rename_relinks_historic_grocery_trip_line_items(client):
    store.write("grocery_trips", {"trips": [
        {"date": "2026-06-01", "store": "HEB",
         "line_items": [{"name": "OAT MILK 64OZ", "catalog_name": "oat milk"}]},
    ]})
    store.write("kitchen", {"items": [], "category_map": {"oat milk": "dairy"}})
    _post(client, "/api/kitchen/catalog/rename",
          {"old_name": "oat milk", "new_name": "Oatly Milk"})
    trips = store.read("grocery_trips", {"trips": []})["trips"]
    assert trips[0]["line_items"][0]["catalog_name"] == "oatly milk"


def test_trip_remove_also_drops_matching_activity_entries(client):
    store.write("activity_log", {"entries": [
        {"date": "2026-06-10", "type": "kitchen"},
        {"date": "2026-06-10", "type": "run"},
    ]})
    _post(client, "/api/kitchen/trips/log", {"date": "2026-06-10"})
    _post(client, "/api/kitchen/trips/remove", {"date": "2026-06-10"})
    entries = store.read("activity_log", {"entries": []})["entries"]
    assert entries == [{"date": "2026-06-10", "type": "run"}]
