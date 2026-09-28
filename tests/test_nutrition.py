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
from tests.test_fdcdb import make_survey_zip, make_zip


@pytest.fixture
def conn(tmp_path, data_dir, monkeypatch):
    root = tmp_path / "commons"
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    with fdcdb.session(root) as connection:
        fdcdb.load_fdc(connection, make_zip(tmp_path / "f.zip"))
        fdcdb.load_fdc(connection, make_survey_zip(tmp_path / "s.zip"))
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
