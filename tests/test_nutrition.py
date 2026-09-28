"""Adding up a day of food against the targets (nutrition.py), and its HTTP door.

Built on the tiny FDC zip from test_fdcdb.py (kale: calcium with a sample
range, vitamin C without one; the baby kale has no figures at all). Checks
the promises the page makes: an unknown nutrient lists the foods it's
missing from instead of counting them as zero, a fill_from entry fills only
the gaps and is named in `filled`, the low/high range adds up
the sample min/max, grams scale per 100 g, servings multiply, a UL that
doesn't count food can't be gone over, and "both" shows each sex's target.
"""
import pytest
from flask import Flask

import commons
import dri
import fdcdb
import histamine
import nutrition
import store
from routes import nutrition as nutrition_routes
from tests.test_fdcdb import make_branded_zip, make_survey_zip, make_zip


@pytest.fixture
def conn(tmp_path, data_dir, monkeypatch):
    root = tmp_path / "commons"
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    with fdcdb.session(root) as connection:
        fdcdb.load_fdc(connection, make_zip(tmp_path / "f.zip"))
        fdcdb.load_fdc(connection, make_survey_zip(tmp_path / "s.zip"))
        fdcdb.load_fdc(connection, make_branded_zip(tmp_path / "b.zip"))
        dri.ensure_schema(connection)
        for sex, calcium in (("female", 1000), ("male", 1200)):
            connection.execute("INSERT INTO dri_values VALUES ('calcium', ?, '19-30', 'rda', ?, 'mg', '', 'test', NULL)",
                               (sex, calcium))
        connection.commit()
        yield connection


def _calcium(conn, items):
    return nutrition.totals(conn, items)["calcium"]


def test_grams_scale_per_100_g(conn):
    assert _calcium(conn, [{"fdc_id": 1, "grams": 50}])["amount"] == pytest.approx(127.0)


def test_range_adds_up_sample_min_and_max(conn):
    total = _calcium(conn, [{"fdc_id": 1, "grams": 200}])
    assert (total["low"], total["high"]) == pytest.approx((400.0, 600.0))


def test_unknown_is_listed_not_counted_as_zero(conn):
    total = _calcium(conn, [{"fdc_id": 1, "grams": 100, "label": "kale"},
                            {"fdc_id": 2, "grams": 100, "label": "baby kale"}])
    assert (total["amount"], total["missing"]) == (254.0, ["baby kale"])


def test_fill_from_fills_a_gap_and_says_so(conn):
    total = _calcium(conn, [{"fdc_id": 2, "grams": 100, "label": "baby kale", "fill_from": 50}])
    assert (total["amount"], total["filled"], total["missing"]) == (150.0, ["baby kale"], [])


def test_by_food_splits_the_total_and_merges_a_food_eaten_twice(conn):
    total = _calcium(conn, [{"fdc_id": 1, "grams": 100, "label": "kale", "meal": "lunch"},
                            {"fdc_id": 2, "grams": 100, "label": "baby kale", "fill_from": 50},
                            {"fdc_id": 1, "grams": 50, "label": "kale", "meal": "dinner"}])
    assert [(s["label"], s["amount"], s["meals"]) for s in total["by_food"]] == [
        ("kale", pytest.approx(381.0), ["lunch", "dinner"]), ("baby kale", pytest.approx(150.0), [])]


def test_fill_from_never_overrides_a_measured_figure(conn):
    total = _calcium(conn, [{"fdc_id": 1, "grams": 100, "label": "kale", "fill_from": 50}])
    assert (total["amount"], total["filled"]) == (254.0, [])


def test_servings_multiply_a_meals_grams():
    data = {"meals": {"bowl": {"items": [{"label": "kale", "fdc_id": 1, "grams": 60}]}},
            "day": [{"meal": "bowl", "servings": 2}]}
    assert nutrition.day_items(data)[0]["grams"] == 120.0


def test_both_shows_each_sexs_target(conn):
    rows = {r["key"]: r for r in nutrition.report(conn, [{"fdc_id": 1, "grams": 100}], sex="both", age=29)["nutrients"]}
    assert {s: j["target"]["value"] for s, j in rows["calcium"]["by_sex"].items()} == {"female": 1000, "male": 1200}


def test_ul_that_skips_food_cannot_be_gone_over():
    target = {"ul": {"value": 350, "unit": "mg", "source": "t"}, "rda": {"value": 310, "unit": "mg", "source": "t"},
              "_nutrient": "magnesium"}
    assert nutrition._judge(900, "mg", target)["status"] == "met"


def test_food_ul_is_gone_over():
    target = {"ul": {"value": 40, "unit": "mg", "source": "t"}, "rda": {"value": 8, "unit": "mg", "source": "t"},
              "_nutrient": "zinc"}
    assert nutrition._judge(41, "mg", target)["status"] == "over"


def test_target_converts_to_the_totals_unit():
    target = {"rda": {"value": 900, "unit": "µg", "source": "t"}, "_nutrient": "copper"}
    assert nutrition._judge(0.45, "mg", target)["percent"] == 50


def test_every_source_carries_a_link(conn):
    commons.write_manifest({"files": [{"path": dri.TABLE_FILE, "url": "https://example.org/dri.pdf"}]})
    cited = nutrition.sources()
    assert (cited["targets_url"], cited["update_2019_url"], cited["composition_url"]) == (
        "https://example.org/dri.pdf", "https://doi.org/10.17226/25353", nutrition.FDC_URL)


@pytest.fixture
def client(conn):
    app = Flask(__name__)
    nutrition_routes.register(app)
    store.write(nutrition.MEALS, {"meals": {"bowl": {"note": "kept", "items": []}},
                                  "day": [{"meal": "bowl", "servings": 1}]})
    return app.test_client()


def test_day_route_adds_up_the_usual_day(client):
    client.post("/api/nutrition/meals/bowl", json={"items": [{"label": "kale", "fdc_id": 1, "grams": 100}]})
    rows = {r["key"]: r for r in client.get("/api/nutrition/day").get_json()["report"]["nutrients"]}
    assert rows["calcium"]["amount"] == 254.0


def test_saving_a_meal_keeps_fill_from(client):
    client.post("/api/nutrition/meals/bowl",
                json={"items": [{"label": "baby kale", "fdc_id": 2, "grams": 100, "fill_from": 50}]})
    assert store.read(nutrition.MEALS)["meals"]["bowl"]["items"][0]["fill_from"] == 50


def test_saving_a_meal_keeps_its_note(client):
    client.post("/api/nutrition/meals/bowl", json={"items": []})
    assert store.read(nutrition.MEALS)["meals"]["bowl"]["note"] == "kept"


def test_meal_with_negative_grams_is_refused(client):
    response = client.post("/api/nutrition/meals/bowl", json={"items": [{"label": "kale", "fdc_id": 1, "grams": -5}]})
    assert response.status_code == 400


def test_servings_change_a_counted_meal(client):
    client.post("/api/nutrition/servings/bowl", json={"servings": 2.5})
    assert store.read(nutrition.MEALS)["day"] == [{"meal": "bowl", "servings": 2.5}]


def test_zero_servings_leaves_the_day_but_keeps_the_meal(client):
    client.post("/api/nutrition/servings/bowl", json={"servings": 0})
    data = store.read(nutrition.MEALS)
    assert data["day"] == [] and "bowl" in data["meals"]


def test_a_new_meal_joins_the_day_when_given_servings(client):
    client.post("/api/nutrition/meals/snack", json={"items": []})
    client.post("/api/nutrition/servings/snack", json={"servings": 1})
    assert [slot["meal"] for slot in store.read(nutrition.MEALS)["day"]] == ["bowl", "snack"]


def test_servings_for_an_unknown_meal_are_refused(client):
    assert client.post("/api/nutrition/servings/nope", json={"servings": 1}).status_code == 400


def test_deleting_a_meal_takes_it_out_of_the_day(client):
    client.delete("/api/nutrition/meals/bowl")
    assert store.read(nutrition.MEALS) == {"meals": {}, "day": []}


def test_settings_refuse_an_unknown_sex(client):
    assert client.post("/api/nutrition/settings", json={"sex": "other"}).status_code == 400


def test_settings_saved_and_read_back(client):
    client.post("/api/nutrition/settings", json={"sex": "female", "age": 29})
    assert nutrition.settings() == {"sex": "female", "age": 29}


def test_search_route_finds_by_words(client):
    assert client.get("/api/nutrition/search?q=kale baby").get_json()["foods"][0]["fdc_id"] == 2


def _energy(conn, kcal_by_food):
    conn.execute("INSERT OR IGNORE INTO fdc_nutrients VALUES (1008, 'Energy', 'KCAL', '208', 300)")
    for fdc_id, kcal in kcal_by_food.items():
        conn.execute("INSERT INTO fdc_amounts (fdc_id, nutrient_id, amount) VALUES (?, 1008, ?)", (fdc_id, kcal))
    conn.commit()


def test_ranking_puts_the_richest_food_first(conn):
    ranked = nutrition.ranking(conn, "calcium")["foods"]
    assert [food["fdc_id"] for food in ranked] == [1, 50]


def test_ranking_leaves_out_foods_with_no_figure(conn):
    assert 2 not in [food["fdc_id"] for food in nutrition.ranking(conn, "calcium")["foods"]]


def test_ranking_per_100_kcal_divides_by_energy(conn):
    _energy(conn, {1: 50, 50: 10})
    ranked = nutrition.ranking(conn, "calcium", per="100kcal")["foods"]
    assert [(food["fdc_id"], food["amount"]) for food in ranked] == [(50, 1500.0), (1, 508.0)]


def test_ranking_per_100_kcal_skips_near_zero_calorie_foods(conn):
    _energy(conn, {1: 50, 50: 1})
    assert [food["fdc_id"] for food in nutrition.ranking(conn, "calcium", per="100kcal")["foods"]] == [1]


def test_ranking_narrows_by_words(conn):
    assert nutrition.ranking(conn, "calcium", words="baby")["foods"] == []


def test_rank_route_refuses_an_unknown_nutrient(client):
    assert client.get("/api/nutrition/rank/unobtainium").status_code == 400


def test_rank_route_ranks(client):
    body = client.get("/api/nutrition/rank/calcium?per=100g").get_json()
    assert (body["unit"], body["foods"][0]["fdc_id"]) == ("mg", 1)


def test_matrix_column_is_one_gram_of_the_food(conn):
    built = nutrition.matrix(conn, [{"fdc_id": 1, "label": "kale", "grams": 500}], sex="female", age=29)
    assert built["A"][built["nutrients"].index("calcium")] == [pytest.approx(2.54)]


def test_matrix_leaves_unknown_as_none_not_zero(conn):
    built = nutrition.matrix(conn, [{"fdc_id": 2, "label": "baby kale", "grams": 100}], sex="female", age=29)
    assert built["A"][built["nutrients"].index("calcium")] == [None]


def test_matrix_both_takes_the_higher_floor(conn):
    built = nutrition.matrix(conn, [{"fdc_id": 1, "label": "kale", "grams": 100}], sex="both", age=29)
    assert built["lower"][built["nutrients"].index("calcium")] == 1200


def _sighi(monkeypatch):
    # A one-food SIGHI list: raw kale rated 0 (the real list doesn't carry kale).
    entries = [{"name": "kale", "rating": "0", "flags": [], "remark": "", "category": "Vegetables"}]
    monkeypatch.setattr("histamine.names", lambda: histamine.index(entries))


def test_rank_route_rates_each_food_against_sighi(client, monkeypatch):
    _sighi(monkeypatch)
    body = client.get("/api/nutrition/rank/calcium?per=100g").get_json()
    assert (body["foods"][0]["histamine"]["verdict"], body["histamine_source"]["loaded"]) == ("low", True)


def test_rank_route_low_histamine_keeps_only_sighi_zeros(client, monkeypatch):
    entries = [{"name": "kale, baby", "rating": "2", "flags": [], "remark": "", "category": None}]
    monkeypatch.setattr("histamine.names", lambda: histamine.index(entries))
    body = client.get("/api/nutrition/rank/calcium?per=100g&histamine=low").get_json()
    assert body["foods"] == []


def test_nutrient_route_gives_the_days_row_and_the_facts(client):
    body = client.get("/api/nutrition/nutrient/calcium").get_json()
    assert (body["row"]["key"], body["facts"]["sheet"]["missing"]) == ("calcium", True)


def test_nutrient_route_refuses_an_unknown_nutrient(client):
    assert client.get("/api/nutrition/nutrient/unobtainium").status_code == 400


def test_starring_a_food_saves_it_and_unstarring_removes_it(client):
    client.post("/api/nutrition/highlights/1", json={"on": True, "description": "Kale, raw"})
    starred = [food["fdc_id"] for food in client.get("/api/nutrition/highlights").get_json()["foods"]]
    client.post("/api/nutrition/highlights/1", json={"on": False})
    assert (starred, client.get("/api/nutrition/highlights").get_json()["foods"]) == ([1], [])


def test_starring_without_a_description_is_refused(client):
    assert client.post("/api/nutrition/highlights/1", json={"on": True}).status_code == 400


# Single foods: real USDA names, one row each for what the rule keeps and drops.
def _usda(description, category, data_type="sr_legacy_food"):
    return {"description": description, "category": category, "data_type": data_type}


@pytest.mark.parametrize("food", [
    _usda("Kale, raw", "Vegetables and Vegetable Products", "foundation_food"),
    _usda("Milk, whole, 3.25% milkfat, with added vitamin D", "Dairy and Egg Products"),
    _usda("Potatoes, Russet, flesh and skin, baked", "Vegetables and Vegetable Products"),
    _usda("Rice, white, long-grain, regular, enriched, cooked", "Cereal Grains and Pasta"),
    _usda("Beef, chuck, blade roast, separable lean and fat, trimmed to 1/8\" fat, all grades, cooked, braised",
          "Beef Products"),
])
def test_single_food_keeps_plain_foods_and_their_cooked_forms(food):
    assert nutrition.is_single_food(food)


@pytest.mark.parametrize("food", [
    _usda("Beans, baked, canned, with pork", "Legumes and Legume Products"),
    _usda("Potatoes, french fried, all types, salt added in processing, frozen, unprepared",
          "Vegetables and Vegetable Products"),
    _usda("Milk shakes, thick chocolate", "Dairy and Egg Products"),
    _usda("Ice creams, vanilla, rich", "Sweets"),
    _usda("Cheese, pasteurized process, KRAFT, American", "Dairy and Egg Products"),
    _usda("Kale, raw", "Vegetables", "survey_fndds_food"),
])
def test_single_food_drops_dishes_brands_and_other_groups(food):
    assert not nutrition.is_single_food(food)


def test_rank_and_search_routes_keep_single_foods_when_asked(client, monkeypatch):
    monkeypatch.setattr(nutrition, "is_single_food", lambda food: food["description"] == "Kale, raw")
    ranked = client.get("/api/nutrition/rank/calcium?per=100g&single=1").get_json()["foods"]
    found = client.get("/api/nutrition/search?q=kale&single=1").get_json()["foods"]
    assert {f["description"] for f in ranked + found} == {"Kale, raw"}


# The meal-prep calculator: fewest grams of candidate foods that close the gaps.
KALE, SURVEY, BABY_KALE = ({"fdc_id": 1, "label": "kale"}, {"fdc_id": 50, "label": "survey kale"},
                           {"fdc_id": 2, "label": "baby kale"})


def _plan(conn, items, candidates, **options):
    plan = nutrition.plan_additions(conn, items, candidates, sex="female", age=29, **options)
    calcium = next(row for row in plan["nutrients"] if row["key"] == "calcium")
    return plan, calcium


def test_plan_uses_the_fewest_grams_to_meet_the_target(conn):
    plan, calcium = _plan(conn, [], [KALE, SURVEY], cap_grams=1000)
    assert ([(f["label"], f["grams"]) for f in plan["foods"]], calcium["closed"]) == (
        [("kale", pytest.approx(393.7, abs=0.1))], True)


def test_plan_counts_what_she_already_eats(conn):
    plan, _ = _plan(conn, [{"fdc_id": 1, "label": "kale", "grams": 200}], [KALE], cap_grams=1000)
    assert plan["foods"][0]["grams"] == pytest.approx(193.7, abs=0.1)


def test_plan_gets_as_close_as_it_can_when_the_cap_stops_it(conn):
    plan, calcium = _plan(conn, [], [KALE, SURVEY], cap_grams=100)
    assert (calcium["after"], calcium["closed"]) == (pytest.approx(404.0, abs=0.01), False)


def test_plan_never_leans_on_an_unknown_figure(conn):
    plan, calcium = _plan(conn, [{"fdc_id": 1, "label": "kale", "grams": 100}], [BABY_KALE], cap_grams=100)
    assert (plan["foods"], calcium["unknown_in"]) == ([], ["baby kale"])


def test_plan_stays_under_a_ceiling_that_counts_food(conn):
    conn.execute("INSERT INTO dri_values VALUES ('calcium', 'female', '19-30', 'ul', 1100, 'mg', '', 'test', NULL)")
    plan, calcium = _plan(conn, [{"fdc_id": 50, "label": "survey kale", "grams": 600}], [KALE], cap_grams=1000)
    assert (calcium["after"], plan["already_over"]) == (pytest.approx(1000.0), [])


def test_plan_lists_a_ceiling_already_passed(conn):
    conn.execute("INSERT INTO dri_values VALUES ('calcium', 'female', '19-30', 'ul', 1100, 'mg', '', 'test', NULL)")
    plan, _ = _plan(conn, [{"fdc_id": 1, "label": "kale", "grams": 500}], [SURVEY])
    assert (plan["already_over"], plan["foods"]) == (["calcium"], [])


def test_plan_route_adds_only_starred_foods(client):
    client.post("/api/nutrition/settings", json={"sex": "female", "age": 29})
    client.post("/api/nutrition/highlights/1", json={"on": True, "description": "kale"})
    body = client.get("/api/nutrition/plan?cap=1000").get_json()
    assert [(f["fdc_id"], f["grams"]) for f in body["foods"]] == [(1, pytest.approx(393.7, abs=0.1))]


def test_plan_route_refuses_a_bad_cap(client):
    assert client.get("/api/nutrition/plan?cap=-5").status_code == 400


def test_nutrient_route_says_whether_the_body_stores_it(client):
    body = client.get("/api/nutrition/nutrient/vitamin_b12").get_json()
    assert body["storage"]["kind"] == "stores"


def test_day_route_marks_each_nutrient_stored_or_steady(client):
    storage = client.get("/api/nutrition/day").get_json()["storage"]
    assert (storage["thiamin"]["kind"], storage["energy"]["kind"]) == ("steady", "unsourced")


def test_plan_moves_a_stored_nutrient_into_weekly_sittings(conn):
    plan, calcium = _plan(conn, [], [KALE], cap_grams=1000)
    kale = plan["foods"][0]
    assert (kale["daily_grams"], kale["weekly_grams"], kale["times_a_week"], calcium["judged"]) == (
        0.0, pytest.approx(2755.9, abs=0.5), 3, "week")


def test_plan_keeps_a_daily_nutrient_every_day(conn):
    plan = nutrition.plan_additions(conn, [], [KALE], cap_grams=1000, sex="female", age=29, weekly_keys=set())
    kale = plan["foods"][0]
    assert (kale["daily_grams"], kale["weekly_grams"]) == (pytest.approx(393.7, abs=0.1), 0.0)


# Packaged foods: a label's figures count, and say they're a label's.
def test_a_packaged_foods_figure_counts_and_is_named_as_a_label(conn):
    total = _calcium(conn, [{"fdc_id": 901, "grams": 40, "label": "oats"}])
    assert (total["amount"], total["labelled"], total["missing"]) == (20.0, ["oats"], [])


def test_a_nutrient_the_label_leaves_out_is_missing_not_zero(conn):
    total = nutrition.totals(conn, [{"fdc_id": 901, "grams": 40, "label": "oats"}])["iron"]
    assert (total["amount"], total["missing"], total["labelled"]) == (0.0, ["oats"], [])


def test_packaged_route_finds_by_name_and_by_typed_barcode(client):
    by_name = client.get("/api/nutrition/packaged?q=oaty").get_json()["foods"]
    by_code = client.get("/api/nutrition/packaged?q=0 12345 67890 5").get_json()["foods"]
    assert ([f["fdc_id"] for f in by_name], [f["fdc_id"] for f in by_code]) == ([901], [901])


def test_packaged_route_says_nothing_found_for_an_unknown_barcode(client):
    assert client.get("/api/nutrition/packaged?q=000000000017").get_json()["foods"] == []
