"""What a recipe gives against the targets, and its sensitivity flags (recipe_nutrition.py).

What can silently break here: an amount read as the wrong weight (a bracketed
per-piece weight not multiplied, a range not halved), a guess passing as a
measurement, a food matched to the wrong USDA entry by a word fragment
("butter" → butterfish), a weight she set for an old amount still being used
after the amount changed, a line that can't be weighed being counted as 0,
and her two new records (USDA entry, gram weight) being lost to a merge or
missing from the backup. Built on a tiny hand-made FDC zip.
"""
import sqlite3
import zipfile

import pytest
from flask import Flask

import fdcdb
import foodstore
import recipe_nutrition as rn
import store
from routes import food as food_routes
from routes import recipe_nutrition as recipe_routes
from tests.test_fdcdb import _csv
from tests.test_foodstore import recipe, rows, seed_kitchen

# Tiny USDA: (fdc_id, description, category, calcium mg per 100 g), and portions.
FOODS = (
    ("10", "Butter, salted", "Dairy and Egg Products", "24"),
    ("11", "Fish, butterfish, raw", "Finfish and Shellfish Products", "22"),
    ("20", "Carrots, raw", "Vegetables and Vegetable Products", "33"),
    ("21", "Carrots, cooked, boiled", "Vegetables and Vegetable Products", "30"),
    ("30", "Water convolvulus, raw", "Vegetables and Vegetable Products", "77"),
    ("40", "Vinegar, cider", "Spices and Herbs", "7"),
    ("41", "Apples, raw", "Fruits and Fruit Juices", "6"),
)
PORTIONS = (
    ("1", "10", "1", "1", "", "tbsp", "14.2"),
    ("2", "20", "1", "1", "", "medium", "61"),
    ("3", "20", "2", "1", "", "cup chopped", "128"),
)


def make_zip(path):
    files = {
        "food_category.csv": _csv(("id", "code", "description"), [
            (str(i), str(i), name) for i, name in enumerate(sorted({f[2] for f in FOODS}), 1)]),
        "measure_unit.csv": _csv(("id", "name"), [("9999", "undetermined")]),
        "nutrient.csv": _csv(("id", "name", "unit_name", "nutrient_nbr", "rank"),
                             [("1087", "Calcium, Ca", "MG", "301", "5300")]),
    }
    categories = {name: str(i) for i, name in enumerate(sorted({f[2] for f in FOODS}), 1)}
    files["food.csv"] = _csv(("fdc_id", "data_type", "description", "food_category_id", "publication_date"),
                             [(i, "sr_legacy_food", d, categories[c], "2018-04-01") for i, d, c, _ in FOODS])
    files["food_nutrient.csv"] = _csv(
        ("id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max",
         "median", "footnote", "min_year_acquired"),
        [(str(n), i, "1087", ca, "", "", "", "", "", "", "") for n, (i, _, _, ca) in enumerate(FOODS)])
    files["food_portion.csv"] = _csv(
        ("id", "fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description", "modifier",
         "gram_weight", "data_points", "footnote", "min_year_acquired"),
        [(pid, fid, seq, amount, "9999", "", modifier, grams, "", "", "")
         for pid, fid, seq, amount, _, modifier, grams in PORTIONS])
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in files.items():
            archive.writestr(f"FoodData_Central_sr_legacy_food_csv_test/{name}", text)
    return path


@pytest.fixture
def usda(tmp_path, data_dir, monkeypatch):
    root = tmp_path / "commons"
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    with fdcdb.session(root) as conn:
        fdcdb.load_fdc(conn, make_zip(tmp_path / "sr.zip"))
    rn._suggest.cache_clear()
    yield root
    rn._suggest.cache_clear()


def line_of(view, text):
    return next(line for line in view["lines"] if line["text"] == text)


# --- reading amounts -----------------------------------------------------------

def test_a_written_weight_is_taken_as_is():
    assert rn.read_amount("600 g (1 1/4-1 1/2 lb)")["grams"] == 600


def test_a_bracketed_weight_is_per_piece_times_the_count():
    assert rn.read_amount("2 (3-4 lb)")["grams"] == pytest.approx(2 * 3.5 * 453.592)


def test_a_range_takes_its_middle_and_says_so():
    reading = rn.read_amount("3-4 medium, chunked")
    assert (reading["count"], reading["piece"], reading["note"]) == (3.5, "medium", "the middle of 3–4")


def test_mixed_fractions_read_as_one_number():
    assert rn.read_amount("1 1/2 tsp")["teaspoons"] == 1.5


def test_to_taste_has_nothing_to_weigh():
    assert rn.read_amount("to taste")["kind"] == "none"


# --- weighing with USDA's portions ---------------------------------------------

def test_a_count_uses_usdas_piece_weight():
    grams, how = rn.weigh(rn.read_amount("3 medium"), [{"amount": 1, "unit": None, "description": "medium", "grams": 61}])
    assert grams == 183 and "medium" in how


def test_a_spoon_is_scaled_from_usdas_cup():
    grams, _ = rn.weigh(rn.read_amount("1 tbsp"), [{"amount": 1, "unit": None, "description": "cup", "grams": 240}])
    assert grams == pytest.approx(15)


def test_a_survey_portion_with_its_count_in_the_text_is_divided():
    grams, _ = rn.weigh(rn.read_amount("2"), [{"amount": None, "unit": None,
                                                "description": "2 medium carrots 64724", "grams": 120}])
    assert grams == 120


def test_a_count_with_no_fitting_portion_is_not_guessed():
    grams, _ = rn.weigh(rn.read_amount("1 small"), [{"amount": 1, "unit": None, "description": "cup", "grams": 128}])
    assert grams is None


# --- which USDA entry ------------------------------------------------------------

def test_a_name_matches_whole_words_only(usda):
    assert rn._suggest("butter") == (10, "Butter, salted")


def test_a_raw_form_is_suggested_first(usda):
    assert rn._suggest("carrots")[0] == 20


def test_the_last_word_stands_in_when_the_whole_name_has_no_match(usda):
    assert rn._suggest("apple cider vinegar")[0] == 40


def test_a_lone_word_that_names_something_else_is_not_suggested(usda):
    assert rn._suggest("water") is None


# --- a whole recipe --------------------------------------------------------------

@pytest.fixture
def stew(usda):
    seed_kitchen(recipes=[recipe(lines=(("carrots", "3 medium", ""), ("butter", "2 tbsp", ""),
                                        ("water", "to cover", ""), ("apple cider vinegar", "1 cup", "")))],
                 guide={"hurts": ["butter"], "safe": [], "unsure": []})
    foodstore.adopt()
    return "r1"


def test_a_serving_is_the_recipe_divided_by_its_servings(stew):
    view = rn.recipe(stew)
    calcium = next(row for row in view["report"]["nutrients"] if row["key"] == "calcium")
    # 183 g carrots × 33 mg/100 g + 28.4 g butter × 24 mg/100 g, over 4 servings.
    assert calcium["amount"] == pytest.approx((183 * 0.33 + 28.4 * 0.24) / 4, abs=0.01)


def test_a_line_that_cannot_be_weighed_is_listed_not_counted(stew):
    assert "water" in rn.recipe(stew)["not_counted"]


def test_a_suggested_entry_is_marked_until_she_confirms_it(stew):
    assert line_of(rn.recipe(stew), "carrots")["usda"]["confirmed"] is False
    foodstore.set_usda("carrots", 21)
    assert line_of(rn.recipe(stew), "carrots")["usda"] == {
        "fdc_id": 21, "description": "Carrots, cooked, boiled", "confirmed": True}


def test_her_weight_wins_over_the_worked_out_one(stew):
    foodstore.set_line_grams(stew, "Water", 500, "to cover")
    assert line_of(rn.recipe(stew), "water")["grams_source"] == "yours"


def test_her_weight_for_an_old_amount_is_shown_stale_not_used(stew):
    foodstore.set_line_grams(stew, "carrots", 999, "2 medium")
    line = line_of(rn.recipe(stew), "carrots")
    assert (line["grams"], line["stale_grams"]) == (183, {"grams": 999, "for_amount": "2 medium"})


def test_a_food_that_hurts_her_flags_the_recipe(stew):
    assert rn.recipe(stew)["flags"]["hurts"] == ["butter"]


def test_the_overview_counts_weighed_lines_and_carries_flags(stew):
    one = rn.overview()["recipes"][0]
    # Carrots and butter weigh; water has no amount, and USDA gives this vinegar no cup weight.
    assert (one["counted"], one["lines"], one["flags"]["hurts"]) == (2, 4, ["butter"])


def test_a_locked_database_still_answers_from_the_last_rebuild(stew, monkeypatch):
    rn.overview()
    def locked():
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(foodstore, "rebuild", locked)
    assert rn.overview()["recipes"][0]["lines"] == 4


# --- her record: backup and merge -------------------------------------------------

def test_a_usda_entry_rides_in_the_backup(stew):
    foodstore.set_usda("carrots", 21)
    assert store.read(foodstore.MIRROR_FILE, {})["food_usda"][0]["fdc_id"] == 21


def test_a_merge_carries_the_dropped_foods_usda_entry(stew):
    foodstore.add_food("carrot sticks")
    foodstore.set_usda("carrot sticks", 21)
    kept = foodstore.merge("carrots", "carrot sticks")
    assert rows("SELECT food_id, fdc_id FROM food_usda") == [(kept, 21)]


# --- the HTTP door ------------------------------------------------------------------

@pytest.fixture
def client(stew):
    app = Flask(__name__)
    recipe_routes.register(app)
    food_routes.register(app)
    return app.test_client()


def test_grams_route_refuses_text(client):
    assert client.post("/api/recipes/r1/grams", json={"line": "water", "grams": "lots"}).status_code == 400


def test_grams_route_saves_her_weight(client):
    client.post("/api/recipes/r1/grams", json={"line": "water", "grams": 250, "for_amount": "to cover"})
    assert rows("SELECT grams FROM recipe_line_grams") == [(250.0,)]


def test_usda_route_sets_a_foods_entry(client):
    food_id = rows("SELECT food_id FROM food_names WHERE name = 'carrots'")[0][0]
    client.post(f"/api/food/foods/{food_id}/usda", json={"fdc_id": 21})
    assert rows("SELECT fdc_id FROM food_usda") == [(21,)]


def test_an_unknown_recipe_is_a_404(client):
    assert client.get("/api/recipes/nope/nutrition").status_code == 404
