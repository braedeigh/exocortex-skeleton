"""Shared recipes (recipe_shares.py, routes/recipe_share.py).

What can silently break here is privacy and revocation: a visitor seeing her
notes, her food guide or her targets, or a link still working after she
stops sharing. Plus the ranking and the visitor's own age and sex being the
ones used. Built on the tiny USDA and the stew from test_recipe_nutrition.py.
"""
import pytest
from flask import Flask

import foodstore
import nutrition
import public_config
import recipe_shares
import store
from routes import recipe_share as share_routes
from tests.test_foodstore import recipe, seed_kitchen
from tests.test_recipe_nutrition import stew, usda  # noqa: F401 — fixtures


@pytest.fixture
def private_stew(stew):
    # Her own notes, tags and a food guide entry ride on the recipe; none may reach a visitor.
    data = store.read("recipes", {})
    data["recipes"][0].update(my_notes="for my bad weeks", notes="halve the salt for me",
                              tags=["flare"], instructions=["Chop.", "Simmer."])
    store.write("recipes", data)
    store.write("nutrition_settings", {"sex": "female", "age": 40})
    return stew


# --- her side ------------------------------------------------------------------------

def test_sharing_twice_keeps_one_link(private_stew):
    assert recipe_shares.share(private_stew) == recipe_shares.share(private_stew)


def test_an_unknown_recipe_cannot_be_shared(private_stew):
    with pytest.raises(KeyError):
        recipe_shares.share("nope")


def test_stopping_closes_the_link(private_stew):
    token = recipe_shares.share(private_stew)
    recipe_shares.unshare(private_stew)
    assert recipe_shares.open_shared(token) is None


def test_sharing_again_after_stopping_makes_a_new_link(private_stew):
    old = recipe_shares.share(private_stew)
    recipe_shares.unshare(private_stew)
    assert recipe_shares.share(private_stew) != old


# --- what a visitor sees -------------------------------------------------------------

def test_a_visitor_sees_the_recipe_and_its_steps(private_stew):
    view = recipe_shares.open_shared(recipe_shares.share(private_stew))
    assert (view["name"], view["instructions"], view["ingredients"][0]["item"]) == \
        ("Roast", ["Chop.", "Simmer."], "carrots")


def test_a_visitor_never_sees_her_notes_tags_or_guide(private_stew):
    view = recipe_shares.open_shared(recipe_shares.share(private_stew))
    text = repr(view)
    assert not any(secret in text for secret in
                   ("for my bad weeks", "halve the salt", "flare", "hurts", "stocking_status"))


def test_a_visitors_numbers_use_their_age_and_sex_not_hers(private_stew, monkeypatch):
    asked = []
    real = nutrition.report

    def spy(conn, items, sex=None, age=None):
        asked.append((sex, age))
        return real(conn, items, sex=sex, age=age)
    monkeypatch.setattr(nutrition, "report", spy)
    recipe_shares.open_shared(recipe_shares.share(private_stew), sex="male", age=70)
    assert asked == [("male", 70)]


def test_no_age_given_means_no_targets_not_hers(private_stew, monkeypatch):
    asked = []
    real = nutrition.report

    def spy(conn, items, sex=None, age=None):
        asked.append((sex, age))
        return real(conn, items, sex=sex, age=age)
    monkeypatch.setattr(nutrition, "report", spy)
    view = recipe_shares.open_shared(recipe_shares.share(private_stew))
    assert (asked, view["nutrition"]["report"]["age"]) == ([("both", 0)], None)


def test_a_visitor_still_gets_the_nutrients(private_stew):
    view = recipe_shares.open_shared(recipe_shares.share(private_stew))
    calcium = next(row for row in view["nutrition"]["report"]["nutrients"] if row["key"] == "calcium")
    assert calcium["amount"] > 0


# --- popular -------------------------------------------------------------------------

@pytest.fixture
def two_shared(private_stew):
    data = store.read("recipes", {})
    data["recipes"].append(recipe(rid="r2", name="Carrot mash", lines=(("carrots", "2 medium", ""),)))
    store.write("recipes", data)
    foodstore.adopt()
    return recipe_shares.share("r1"), recipe_shares.share("r2")


def test_popular_puts_the_most_opened_first(two_shared):
    stew_token, mash_token = two_shared
    recipe_shares.open_shared(mash_token, count=True)
    assert [r["token"] for r in recipe_shares.popular()["recipes"]] == [mash_token, stew_token]


def test_changing_the_age_box_does_not_count_a_view(two_shared):
    stew_token, _ = two_shared
    recipe_shares.open_shared(stew_token, age=30)
    assert recipe_shares.mine()["r1"]["views"] == 0


def test_popular_leaves_out_a_recipe_she_stopped_sharing(two_shared):
    recipe_shares.unshare("r2")
    assert [r["name"] for r in recipe_shares.popular()["recipes"]] == ["Roast"]


def test_popular_lists_ingredients_to_filter_by(two_shared):
    mash = next(r for r in recipe_shares.popular()["recipes"] if r["name"] == "Carrot mash")
    assert mash["ingredients"] == ["carrots"]


# --- the HTTP door -------------------------------------------------------------------

@pytest.fixture
def client(private_stew):
    app = Flask(__name__)
    share_routes.register(app)
    return app.test_client()


def test_the_share_pages_and_their_api_are_open_to_visitors():
    assert all(public_config.is_public_path(path) for path in
               ("/share/r/abc", "/share/recipes", "/api/share/r/abc", "/api/share/recipes"))


def test_sharing_by_hand_stays_behind_the_login():
    assert not any(public_config.is_public_path(path) for path in
                   ("/api/recipes/r1/share", "/api/recipes/r1/unshare", "/api/recipes/shares"))


def test_share_route_returns_the_link(client):
    body = client.post("/api/recipes/r1/share").get_json()
    assert body["path"] == f"/share/r/{body['token']}"


def test_a_closed_link_is_a_404(client):
    token = client.post("/api/recipes/r1/share").get_json()["token"]
    client.post("/api/recipes/r1/unshare")
    assert client.get(f"/api/share/r/{token}").status_code == 404


def test_the_first_open_counts_a_view(client):
    token = client.post("/api/recipes/r1/share").get_json()["token"]
    client.get(f"/api/share/r/{token}?count=1&sex=female&age=33")
    assert client.get("/api/recipes/shares").get_json()["r1"]["views"] == 1


def test_a_half_typed_age_still_shows_the_recipe(client):
    token = client.post("/api/recipes/r1/share").get_json()["token"]
    body = client.get(f"/api/share/r/{token}?age=3x&sex=robot").get_json()
    assert body["nutrition"]["report"]["age"] is None
