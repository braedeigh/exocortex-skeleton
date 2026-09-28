"""Tests for measures.py — grams in one cup / tablespoon / egg of a food, and its route.

Pure cases feed from_portions USDA-shaped rows; the route case uses the tiny
FDC zip from test_fdcdb.py (kale: 1 cup, chopped = 21 g).
"""
import measures
from tests.test_nutrition import client, conn  # noqa: F401 — fixtures


def _by_unit(rows):
    return {row["unit"]: row for row in measures.from_portions(1, rows)}


def test_a_half_cup_portion_is_divided_to_one_cup():
    assert _by_unit([{"amount": 0.5, "unit": None, "description": "cup", "grams": 107}])["cup"]["grams"] == 214


def test_survey_unit_column_is_read_as_the_unit():
    rows = _by_unit([{"amount": 1, "unit": "tablespoon", "description": None, "grams": 15}])
    assert (rows["tbsp"]["grams"], rows["tbsp"]["kind"]) == (15, "usda")


def test_missing_spoons_are_derived_from_the_nearest_usda_volume_by_nist():
    rows = _by_unit([{"amount": 1, "description": "cup, chopped", "grams": 136},
                     {"amount": 1, "description": "tbsp", "grams": 8.5}])
    assert (rows["tsp"]["grams"], rows["tsp"]["kind"], rows["tsp"]["url"]) == \
        (2.83, "derived", measures.NIST_KITCHEN_URL)


def test_count_words_become_their_own_unit_singular():
    rows = _by_unit([{"amount": 3, "description": "cloves", "grams": 9}])
    assert rows["clove"]["grams"] == 3


def test_a_repeat_of_the_same_unit_and_weight_is_dropped():
    rows = measures.from_portions(1, [{"amount": 0.25, "description": "cup", "grams": 30},
                                      {"amount": 1, "description": "cup", "grams": 120}])
    assert [row["unit"] for row in rows].count("cup") == 1


def test_a_food_without_portions_gets_ounces_only():
    assert [row["unit"] for row in measures.from_portions(1, [])] == ["oz"]


def test_every_measure_carries_a_source_link():
    rows = measures.from_portions(7, [{"amount": 1, "description": "cup", "grams": 200},
                                      {"amount": 1, "description": "large", "grams": 180}])
    assert all(row["url"].startswith("https://") and row["source"] for row in rows)


def test_measures_route_reads_usda_portions(client):
    rows = client.get("/api/nutrition/measures?ids=1").get_json()["measures"]["1"]
    assert rows[0] == {"unit": "cup", "label": "1 cup, chopped", "grams": 21.0, "kind": "usda",
                       "source": "USDA FoodData Central: 1 cup chopped = 21 g",
                       "url": measures.FDC_FOOD_URL.format(1)}


def test_measures_route_refuses_ids_that_are_not_numbers(client):
    assert client.get("/api/nutrition/measures?ids=kale").status_code == 400


def test_saving_a_meal_keeps_how_she_typed_the_amount(client):
    import nutrition
    import store
    client.post("/api/nutrition/meals/bowl",
                json={"items": [{"label": "kale", "fdc_id": 1, "grams": 31.5, "measure": "1.5 cup"}]})
    assert store.read(nutrition.MEALS)["meals"]["bowl"]["items"][0]["measure"] == "1.5 cup"
