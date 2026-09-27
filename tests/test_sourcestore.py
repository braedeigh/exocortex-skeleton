"""The map's sources in SQL (sourcestore.py) and the routes that write them.

What can silently break here, worst first: a source's honesty axes taking a
value outside their vocabulary (a proxy passing as a placement), a removed
source leaving links pointing at nothing, a recipe line failing to reach its
source through a product link, USDA's numbers or the origin record being
dropped on an edit, and the move from ecosystem.json losing or renaming a
source (every existing link points at those ids), and an origin request
doubling up (the button pressed twice must stay one request).
"""
import json
import sqlite3

import pytest
from flask import Flask

import foodstore
import sourcestore
import sqlstore
import store


def rows(sql, params=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def make_source(source_id=None, **fields):
    body = {"name": "Onions", "lat": 26.2, "lng": -98.2}
    body.update(fields)
    return sourcestore.add(sourcestore.clean(body), body.get("counties", []),
                           source_id=source_id)


@pytest.fixture
def client(data_dir):
    from routes import ecosystem
    app = Flask(__name__)
    app.config.update(TESTING=True)
    ecosystem.register(app)
    return app.test_client()


def post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


# --- the table holds the vocabulary -------------------------------------------

def test_table_refuses_a_geo_source_outside_the_vocabulary(data_dir):
    conn = sqlstore.open_db()
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO food_sources (id, name, lat, lng, geo_source)"
                         " VALUES ('x', 'Onions', 1, 2, 'verified')")
    finally:
        conn.close()


def test_clean_coerces_unknown_origin_to_unknown(data_dir):
    assert sourcestore.clean({"origin": "a blog"})["origin"] == "unknown"


# --- links --------------------------------------------------------------------

def test_removing_a_source_removes_its_links(data_dir):
    foodstore.add_food("onion")
    sid = make_source()
    sourcestore.link(sid, food="onion")
    sourcestore.remove(sid)
    assert rows("SELECT COUNT(*) FROM food_links WHERE target = 'ecosystem'")[0][0] == 0


def test_a_product_link_traces_its_food(data_dir):
    foodstore.add_food("eggs")
    product_id = foodstore.add_product("eggs", "HEB AA LG EGGS")
    sid = make_source(name="HEB eggs")
    sourcestore.link(sid, product_id=product_id)
    eggs = next(f for f in sourcestore.map_foods() if f["name"] == "eggs")
    assert eggs["source_ids"] == [sid]


def test_for_food_finds_sources_through_products(data_dir):
    food_id = foodstore.add_food("eggs")
    product_id = foodstore.add_product("eggs", "HEB AA LG EGGS")
    sid = make_source(name="HEB eggs")
    sourcestore.link(sid, product_id=product_id)
    assert [s["id"] for s in sourcestore.for_food(food_id)] == [sid]


def test_public_links_name_the_food_not_the_product(data_dir):
    foodstore.add_food("eggs")
    product_id = foodstore.add_product("eggs", "HEB AA LG EGGS")
    sid = make_source(name="HEB eggs")
    sourcestore.link(sid, product_id=product_id)
    link = sourcestore.get(sid, include_products=False)["links"][0]
    assert "product_name" not in link and link["food_name"] == "eggs"


def test_link_route_refuses_an_unknown_food(client):
    sid = make_source()
    response = post(client, "/api/ecosystem/link", {"source_id": sid, "food": "dragonfruit"})
    assert response.status_code == 400


def test_link_route_links_by_food_name(client):
    foodstore.add_food("onion")
    sid = make_source()
    assert post(client, "/api/ecosystem/link", {"source_id": sid, "food": "onion"}).status_code == 200
    assert [l["food_name"] for l in sourcestore.get(sid)["links"]] == ["onion"]


def test_unlink_route_removes_one_link(client):
    foodstore.add_food("onion")
    sid = make_source()
    link_id = sourcestore.link(sid, food="onion")
    post(client, "/api/ecosystem/unlink", {"link_id": link_id})
    assert sourcestore.get(sid)["links"] == []


def test_add_route_can_link_in_the_same_call(client):
    foodstore.add_food("onion")
    response = post(client, "/api/ecosystem/source/add",
                    {"name": "Onions", "lat": 26.2, "lng": -98.2, "food": "onion"})
    sid = response.get_json()["id"]
    assert [l["food_name"] for l in sourcestore.get(sid)["links"]] == ["onion"]


# --- origin + USDA's numbers --------------------------------------------------

def test_add_route_keeps_the_origin_record(client):
    response = post(client, "/api/ecosystem/source/add", {
        "name": "Onions", "lat": 26.2, "lng": -98.2, "origin": "usda-nass",
        "origin_detail": "Census 2022 — ONIONS", "origin_date": "2026-09-27"})
    source = sourcestore.get(response.get_json()["id"])
    assert (source["origin"], source["origin_detail"], source["origin_date"]) == (
        "usda-nass", "Census 2022 — ONIONS", "2026-09-27")


def test_add_route_keeps_usda_county_numbers(client):
    response = post(client, "/api/ecosystem/source/add", {
        "name": "Onions", "lat": 26.2, "lng": -98.2, "precision": "area",
        "area_kind": "counties", "counties": ["48215"],
        "county_detail": [{"fips": "48215", "county": "Hidalgo", "state": "Texas",
                           "value": 1200, "unit": "ACRES"}]})
    detail = sourcestore.get(response.get_json()["id"])["county_detail"]
    assert detail == [{"fips": "48215", "county": "Hidalgo", "state": "Texas",
                       "value": 1200.0, "unit": "ACRES"}]


def test_editing_counties_keeps_numbers_for_counties_that_stay(client):
    response = post(client, "/api/ecosystem/source/add", {
        "name": "Onions", "lat": 26.2, "lng": -98.2, "precision": "area",
        "area_kind": "counties", "counties": ["48215", "48061"],
        "county_detail": [{"fips": "48215", "value": 1200, "unit": "ACRES"}]})
    sid = response.get_json()["id"]
    post(client, "/api/ecosystem/source/update", {"id": sid, "counties": ["48215"]})
    assert [(c["fips"], c["value"]) for c in sourcestore.get(sid)["county_detail"]] == [
        ("48215", 1200.0)]


# --- recipes ------------------------------------------------------------------

def test_recipe_lines_resolve_by_any_name_the_food_goes_by(data_dir):
    food_id = foodstore.add_food("onion")
    foodstore.add_name("onion", "yellow onion")
    store.write("recipes", {"recipes": [
        {"id": "r1", "name": "Soup", "ingredients": [{"item": "Yellow  Onion"}]}]})
    assert sourcestore.map_recipes()[0]["ingredients"][0]["food_id"] == food_id


# --- backup -------------------------------------------------------------------

def test_sources_ride_in_the_food_catalog_backup(data_dir):
    make_source(source_id="seed0009")
    backup = json.loads((store.DATA_DIR / foodstore.MIRROR_FILE).read_text())
    assert [s["id"] for s in backup["food_sources"]] == ["seed0009"]


# --- requests: "find where this comes from" -----------------------------------

def test_asking_twice_returns_the_same_open_request(client):
    foodstore.add_food("kale")
    first = post(client, "/api/ecosystem/request-link", {"food": "kale", "from": "recipe:r1"})
    second = post(client, "/api/ecosystem/request-link", {"food": "Kale", "from": "grocery"})
    assert first.get_json()["id"] == second.get_json()["id"]


def test_a_request_by_id_and_by_name_is_one_request(data_dir):
    food_id = foodstore.add_food("kale")
    assert sourcestore.request(food_id)[0] == sourcestore.request("kale")[0]


def test_a_request_can_name_something_that_isnt_a_food_yet(data_dir):
    request_id, food_id = sourcestore.request("chuck roast", asked_from="recipe:r1")
    assert food_id is None
    assert sourcestore.requested() == {"food_ids": [], "names": ["chuck roast"]}


def test_request_route_refuses_an_empty_food(client):
    assert post(client, "/api/ecosystem/request-link", {"food": "  "}).status_code == 400


def test_linking_the_food_answers_its_request(data_dir):
    food_id = foodstore.add_food("kale")
    sourcestore.request("kale")
    sourcestore.link(make_source(), food="kale")
    assert sourcestore.requested()["food_ids"] == []
    assert sourcestore.requests()[0]["status"] == "answered"


def test_linking_a_product_answers_its_foods_request(data_dir):
    foodstore.add_food("eggs")
    product_id = foodstore.add_product("eggs", "HEB AA LG EGGS")
    sourcestore.request("eggs")
    sourcestore.link(make_source(name="HEB eggs"), product_id=product_id)
    assert sourcestore.requested()["food_ids"] == []


def test_a_withdrawn_request_can_be_asked_again(client):
    foodstore.add_food("kale")
    first = post(client, "/api/ecosystem/request-link", {"food": "kale"}).get_json()["id"]
    post(client, "/api/ecosystem/request/close", {"id": first, "status": "withdrawn"})
    second = post(client, "/api/ecosystem/request-link", {"food": "kale"}).get_json()["id"]
    assert second != first


def test_close_route_refuses_reopening(client):
    foodstore.add_food("kale")
    request_id = sourcestore.request("kale")[0]
    response = post(client, "/api/ecosystem/request/close", {"id": request_id, "status": "open"})
    assert response.status_code == 400


def test_merging_foods_keeps_one_open_request(data_dir):
    foodstore.add_food("kale")
    foodstore.add_food("curly kale")
    sourcestore.request("kale")
    sourcestore.request("curly kale")
    foodstore.merge("kale", "curly kale")
    assert len(sourcestore.requests("open")) == 1


def test_requests_ride_in_the_food_catalog_backup(data_dir):
    foodstore.add_food("kale")
    sourcestore.request("kale", asked_from="grocery")
    backup = json.loads((store.DATA_DIR / foodstore.MIRROR_FILE).read_text())
    assert [r["asked_from"] for r in backup["source_requests"]] == ["grocery"]


# --- moving the old JSON in ---------------------------------------------------

LEGACY = {"sources": [
    {"id": "seed0009", "name": "Onions", "lat": 26.2, "lng": -98.2, "precision": "area",
     "area_kind": "counties", "counties": ["48215"], "transparency": "partial",
     "geo_source": "proxy"},
    {"id": "seed0001", "name": "Quinoa", "lat": -19.0, "lng": -66.0, "precision": "area",
     "radius_km": 300, "transparency": "partial", "geo_source": "guess"},
]}


def test_adopt_legacy_keeps_ids(data_dir):
    sourcestore.adopt_legacy(LEGACY, apply=True)
    assert sorted(s["id"] for s in sourcestore.all_sources()) == ["seed0001", "seed0009"]


def test_adopt_legacy_twice_changes_nothing(data_dir):
    sourcestore.adopt_legacy(LEGACY, apply=True)
    report = sourcestore.adopt_legacy(LEGACY, apply=True)
    assert all(line.startswith("have") for line in report)


def test_adopt_legacy_dry_run_writes_nothing(data_dir):
    sourcestore.adopt_legacy(LEGACY)
    assert sourcestore.all_sources() == []


def test_adopt_legacy_marks_only_county_sources_as_usda(data_dir):
    sourcestore.adopt_legacy(LEGACY, apply=True)
    origins = {s["id"]: s["origin"] for s in sourcestore.all_sources()}
    assert origins == {"seed0009": "usda-nass", "seed0001": "unknown"}


# --- a food's page ------------------------------------------------------------

def test_food_page_lists_where_it_comes_from(data_dir):
    from routes import food as food_routes
    app = Flask(__name__)
    food_routes.register(app)
    foodstore.add_food("onion")
    sid = make_source()
    sourcestore.link(sid, food="onion")
    page = app.test_client().get("/api/food/page?name=onion").get_json()
    assert [s["id"] for s in page["sources"]] == [sid]


# --- the machine's proposals (rung 34) ----------------------------------------

def test_a_proposal_may_never_claim_a_confirmed_place(data_dir):
    conn = sqlstore.open_db()
    try:
        conn.execute("INSERT INTO foods (id, name) VALUES (1, 'onions')")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO source_proposals (food_id, name, lat, lng, geo_source)"
                         " VALUES (1, 'Onions', 1, 2, 'placed')")
    finally:
        conn.close()


def test_a_proposal_must_be_for_a_food_or_a_product(data_dir):
    conn = sqlstore.open_db()
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO source_proposals (name, lat, lng, geo_source)"
                         " VALUES ('Onions', 1, 2, 'proxy')")
    finally:
        conn.close()
