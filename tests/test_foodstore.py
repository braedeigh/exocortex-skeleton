"""The kitchen as connected rows (foodstore.py) and its routes (routes/food.py).

What can silently break here, in order of how badly: a name that should match
a food and doesn't (the whole point is the join), her catalog being wiped by a
rebuild (it is a record, not a derivation), a merge that loses a name or a
product, and money drifting through floats.
"""
import json

import pytest
from flask import Flask

import foodstore
import sqlstore
import store
from routes import food as food_routes


def rows(sql, params=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def seed_kitchen(recipes=(), items=(), trips=(), kitchen_trips=(), category_map=None,
                 guide=None):
    store.write("recipes", {"recipes": list(recipes)})
    store.write("kitchen", {"items": list(items), "category_map": category_map or {}})
    store.write("grocery_trips", {"trips": list(trips)})
    store.write("kitchen_trips", {"trips": list(kitchen_trips)})
    store.write("expense_receipts", {})
    if guide is not None:
        store.write_file("food_guide.json", guide)


def recipe(rid="r1", name="Roast", lines=(("beef chuck roast", "3 lb", ""),)):
    return {"id": rid, "name": name, "servings": 4, "ingredients": [
        {"item": item, "qty": qty, "stocking_status": status}
        for item, qty, status in lines]}


def trip(date="2026-09-01", lines=(("PRIME CHUCK ROAST BNLS", 22.65, "chuck roast"),),
         **extra):
    base = {"date": date, "store": "HEB", "total": 30.06, "saved": 0,
            "items": len(lines), "receipt": f"receipts/grocery/{date}.jpg",
            "line_items": [{"name": n, "qty": 1, "price": p, "catalog_name": c}
                           for n, p, c in lines]}
    base.update(extra)
    return base


# --- matching ------------------------------------------------------------------

def test_names_resolve_to_one_food_across_recipe_list_and_receipt(data_dir):
    seed_kitchen(recipes=[recipe()], items=[{"name": "Chuck roast"}], trips=[trip()])
    foodstore.adopt()
    food_id = foodstore.merge("chuck roast", "beef chuck roast")
    resolved = {r[0] for r in rows(
        "SELECT food_id FROM recipe_lines UNION SELECT food_id FROM grocery_list"
        " UNION SELECT food_id FROM shopping_lines")}
    assert resolved == {food_id}


def test_matching_ignores_case_and_spacing(data_dir):
    seed_kitchen(recipes=[recipe(lines=(("  Kale ", "1", ""),))], items=[{"name": "kale"}])
    foodstore.adopt()
    assert rows("SELECT COUNT(*) FROM foods")[0][0] == 1


def test_adopt_never_merges_on_its_own(data_dir):
    """'onion' and 'onions' stay two foods until someone says otherwise."""
    seed_kitchen(recipes=[recipe(lines=(("onion", "1", ""), ("onions", "2", "")))])
    foodstore.adopt()
    assert rows("SELECT COUNT(*) FROM foods")[0][0] == 2


def test_adopt_takes_category_kind_and_safety_from_the_kitchen(data_dir):
    seed_kitchen(items=[{"name": "foil"}, {"name": "kale"}],
                 category_map={"foil": "household", "kale": "vegetables"},
                 guide={"safe": ["kale"], "hurts": []})
    foodstore.adopt()
    got = {r[0]: r[1:] for r in rows("SELECT name, kind, category, safety FROM foods")}
    assert got == {"foil": ("household", "household", None),
                   "kale": ("food", "vegetables", "safe")}


def test_receipt_line_becomes_a_product_under_the_picked_food(data_dir):
    seed_kitchen(trips=[trip()])
    foodstore.adopt()
    assert rows(
        "SELECT p.name, f.name FROM products p JOIN foods f ON f.id = p.food_id"
    ) == [("PRIME CHUCK ROAST BNLS", "chuck roast")]
    assert rows("SELECT product_id IS NOT NULL FROM shopping_lines") == [(1,)]


def test_a_learned_receipt_name_is_recognised_on_the_next_trip(data_dir):
    seed_kitchen(trips=[trip()])
    foodstore.adopt()
    # A later trip where the name wasn't picked at import still lands.
    store.write("grocery_trips", {"trips": [
        trip(), trip("2026-09-08", lines=(("PRIME CHUCK ROAST BNLS", 21.0, ""),))]})
    foodstore.rebuild()
    assert rows("SELECT COUNT(DISTINCT food_id) FROM shopping_lines"
                " WHERE food_id IS NOT NULL")[0][0] == 1
    assert rows("SELECT COUNT(*) FROM shopping_lines WHERE food_id IS NULL")[0][0] == 0


# --- her record survives -------------------------------------------------------

def test_rebuild_never_clears_her_catalog(data_dir):
    seed_kitchen(recipes=[recipe()])
    foodstore.adopt()
    foodstore.set_rotation("r1", per_week=1)
    foodstore.rebuild()
    assert rows("SELECT COUNT(*) FROM foods")[0][0] == 1
    assert rows("SELECT COUNT(*) FROM meal_rotation")[0][0] == 1


def test_every_edit_writes_the_mirror(data_dir):
    seed_kitchen()
    foodstore.add_food("bone broth")
    mirror = json.loads((store.DATA_DIR / "food_catalog.json").read_text())
    assert [f["name"] for f in mirror["foods"]] == ["bone broth"]
    assert mirror["food_names"] == [{"name": "bone broth", "food_id": 1}]


def test_an_empty_catalog_is_restored_from_the_mirror(data_dir):
    seed_kitchen(recipes=[recipe()])
    foodstore.adopt()
    conn = sqlstore.open_db()
    conn.execute("DELETE FROM foods")
    conn.commit()
    conn.close()
    assert foodstore.rebuild()["restored"] is True
    assert rows("SELECT COUNT(*) FROM recipe_lines WHERE food_id IS NOT NULL")[0][0] == 1


def test_a_failed_edit_changes_nothing(data_dir):
    seed_kitchen()
    foodstore.add_food("kale")
    with pytest.raises(Exception):
        foodstore.add_food("Kale")  # names are unique regardless of case
    assert rows("SELECT COUNT(*) FROM foods")[0][0] == 1


# --- merge ---------------------------------------------------------------------

def test_merge_moves_names_products_and_links(data_dir):
    seed_kitchen()
    keep = foodstore.add_food("onion")
    drop = foodstore.add_food("yellow onion")
    pid = foodstore.add_product(drop, "YELLOW ONION", store_name="HEB")
    foodstore.link("ecosystem", "src1", food=drop)
    foodstore.merge(keep, drop)
    assert {r[0] for r in rows("SELECT name FROM food_names WHERE food_id = ?", (keep,))} \
        == {"onion", "yellow onion"}
    assert rows("SELECT food_id FROM products WHERE id = ?", (pid,)) == [(keep,)]
    assert rows("SELECT food_id FROM food_links") == [(keep,)]
    assert rows("SELECT COUNT(*) FROM foods")[0][0] == 1


def test_merge_keeps_the_kept_foods_judgment(data_dir):
    seed_kitchen()
    keep = foodstore.add_food("kale", safety="safe")
    drop = foodstore.add_food("kale bunch", safety="unsure", category="produce")
    foodstore.merge(keep, drop)
    assert rows("SELECT safety, category FROM foods") == [("safe", "produce")]


def test_merge_into_itself_is_refused(data_dir):
    seed_kitchen()
    kale = foodstore.add_food("kale")
    with pytest.raises(ValueError):
        foodstore.merge(kale, "kale")


# --- trips and money -----------------------------------------------------------

def test_prices_are_exact_cents(data_dir):
    seed_kitchen(trips=[trip(lines=(("A", 0.1, ""), ("B", 0.2, "")))])
    foodstore.rebuild()
    assert rows("SELECT SUM(price_cents) FROM shopping_lines")[0][0] == 30


def test_kitchen_trips_twin_is_not_counted_twice(data_dir):
    seed_kitchen(trips=[trip("2026-09-01")],
                 kitchen_trips=[{"date": "2026-09-01", "store": "HEB", "total": 30.06},
                                {"date": "2026-09-05", "store": "HEB", "total": 12.0}])
    foodstore.rebuild()
    assert [r[0] for r in rows("SELECT date FROM shopping_trips ORDER BY date")] \
        == ["2026-09-01", "2026-09-05"]


def test_trip_finds_its_expense_through_the_receipt_map(data_dir):
    seed_kitchen(trips=[trip("2026-09-01")])
    store.write("expense_receipts", {"exp-1": {"filename": "2026-09-01.jpg", "parsed": True}})
    foodstore.rebuild()
    assert rows("SELECT expense_id FROM shopping_trips") == [("exp-1",)]


def test_recipe_cost_prices_only_what_must_be_bought(data_dir):
    seed_kitchen(
        recipes=[recipe(lines=(("chuck roast", "3 lb", ""), ("salt", "", "usually_have")))],
        trips=[trip("2026-09-01", lines=(("CHUCK", 20.0, "chuck roast"), ("SALT", 1.0, "salt"))),
               trip("2026-09-08", lines=(("CHUCK", 22.5, "chuck roast"),))])
    foodstore.adopt()
    # The later price wins, and salt (usually on hand) is not counted.
    assert rows("SELECT lines_to_buy, priced_lines, known_cents FROM recipe_cost") \
        == [(1, 1, 2250)]


# --- routes --------------------------------------------------------------------

@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    food_routes.register(app)
    return app.test_client()


def test_catalog_lists_unmatched_names(client):
    seed_kitchen(recipes=[recipe()])
    body = client.get("/api/food/catalog").get_json()
    assert body["foods"] == [] and body["unmatched"] == ["beef chuck roast"]


def test_merge_route_accepts_names(client):
    seed_kitchen()
    foodstore.add_food("onion")
    foodstore.add_food("onions")
    resp = client.post("/api/food/merge", json={"keep": "onion", "drop": "onions"})
    assert resp.status_code == 200
    assert rows("SELECT COUNT(*) FROM foods")[0][0] == 1


def test_unknown_food_is_a_400_not_a_500(client):
    seed_kitchen()
    resp = client.post("/api/food/merge", json={"keep": "nope", "drop": "also nope"})
    assert resp.status_code == 400 and "no such food" in resp.get_json()["error"]


def test_bad_safety_value_is_refused(client):
    seed_kitchen()
    resp = client.post("/api/food/foods", json={"name": "kale", "safety": "maybe"})
    assert resp.status_code == 400
