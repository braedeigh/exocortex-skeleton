"""The kitchen↔ecosystem bridge depends on each tab's data payload carrying a bit
of the *other* tab's data, so a recipe can be traced to the map:

  - /api/data/kitchen   must include `ecosystem` (the placed sources), so a recipe
    can show "where it comes from".
  - /api/data/ecosystem must include `eco_recipes` (light: id/name/ingredients), so
    the map's "trace a recipe" picker has recipes to offer. It's a dedicated key,
    NOT `recipes`: the light list is public (it powers the shareable /food-map),
    while the full `recipes` stream stays private. See public_config.STREAMS.

These are easy to drop in a refactor and would silently kill the feature, so pin
them. Uses the real server app (the data routes live there, not in a blueprint)
against an isolated temp data dir.
"""
import json

import pytest

import store


@pytest.fixture
def authed_client(data_dir):
    import server
    c = server.app.test_client()
    with c.session_transaction() as sess:
        sess["authed"] = True
    return c


def _seed_kitchen_and_eco():
    import foodstore
    import sourcestore
    sourcestore.add(sourcestore.clean({"name": "Onions", "lat": 31.5, "lng": -99.3,
                                       "precision": "area", "transparency": "partial"}),
                    source_id="s1")
    foodstore.add_food("onion")
    foodstore.add_name("onion", "yellow onion")
    sourcestore.link("s1", food="onion")
    store.write("recipes.json", {"recipes": [
        {"id": "r1", "name": "Soup", "instructions": ["simmer"],
         "ingredients": [{"item": "yellow onion", "category": "produce"}]},
        {"id": "r2", "name": "Archived", "is_archived": True, "ingredients": []},
    ]})


def test_kitchen_payload_includes_ecosystem_sources(authed_client):
    _seed_kitchen_and_eco()
    data = authed_client.get("/api/data/kitchen").get_json()
    assert "ecosystem" in data, "kitchen payload must carry ecosystem for sourcing"
    names = [s["name"] for s in data["ecosystem"]["sources"]]
    assert "Onions" in names


def test_ecosystem_payload_includes_light_recipes(authed_client):
    _seed_kitchen_and_eco()
    data = authed_client.get("/api/data/ecosystem").get_json()
    assert "eco_recipes" in data, "ecosystem payload must carry eco_recipes for the picker"
    recipes = data["eco_recipes"]
    # Light shape: ingredients kept (the matcher needs them), instructions dropped.
    soup = next(r for r in recipes if r["id"] == "r1")
    assert soup["ingredients"][0]["item"] == "yellow onion"
    assert "instructions" not in soup
    # Archived recipes are excluded from the picker.
    assert all(r["id"] != "r2" for r in recipes)


def test_ecosystem_recipe_lines_carry_their_food(authed_client):
    _seed_kitchen_and_eco()
    data = authed_client.get("/api/data/ecosystem").get_json()
    soup = next(r for r in data["eco_recipes"] if r["id"] == "r1")
    onion_id = next(f["id"] for f in data["eco_foods"] if f["name"] == "onion")
    assert soup["ingredients"][0]["food_id"] == onion_id


def test_kitchen_payload_carries_resolved_recipes(authed_client):
    _seed_kitchen_and_eco()
    data = authed_client.get("/api/data/kitchen").get_json()
    soup = next(r for r in data["eco_recipes"] if r["id"] == "r1")
    assert soup["ingredients"][0]["food_name"] == "onion"
