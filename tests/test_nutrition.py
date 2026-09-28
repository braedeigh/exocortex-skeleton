"""Adding up a day of food against the targets (nutrition.py), and its HTTP door.

Built on the tiny FDC zip from test_fdcdb.py (kale: calcium with a sample
range, vitamin C without one; the baby kale has no figures at all). Checks
the promises the page makes: an unknown nutrient lists the foods it's
missing from instead of counting them as zero, the low/high range adds up
the sample min/max, grams scale per 100 g, servings multiply, a UL that
doesn't count food can't be gone over, and "both" shows each sex's target.
"""
import pytest
from flask import Flask

import commons
import dri
import fdcdb
import nutrition
import store
from routes import nutrition as nutrition_routes
from tests.test_fdcdb import make_zip


@pytest.fixture
def conn(tmp_path, data_dir, monkeypatch):
    root = tmp_path / "commons"
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    with fdcdb.session(root) as connection:
        fdcdb.load_fdc(connection, make_zip(tmp_path / "f.zip"))
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


def test_saving_a_meal_keeps_its_note(client):
    client.post("/api/nutrition/meals/bowl", json={"items": []})
    assert store.read(nutrition.MEALS)["meals"]["bowl"]["note"] == "kept"


def test_meal_with_negative_grams_is_refused(client):
    response = client.post("/api/nutrition/meals/bowl", json={"items": [{"label": "kale", "fdc_id": 1, "grams": -5}]})
    assert response.status_code == 400


def test_settings_refuse_an_unknown_sex(client):
    assert client.post("/api/nutrition/settings", json={"sex": "other"}).status_code == 400


def test_settings_saved_and_read_back(client):
    client.post("/api/nutrition/settings", json={"sex": "female", "age": 29})
    assert nutrition.settings() == {"sex": "female", "age": 29}


def test_search_route_finds_by_words(client):
    assert client.get("/api/nutrition/search?q=kale baby").get_json()["foods"][0]["fdc_id"] == 2
