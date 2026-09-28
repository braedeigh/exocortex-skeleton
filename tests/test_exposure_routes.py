"""The exposure HTTP contract (routes/exposure.py).

The calculation is tested in test_exposure.py and the storage in
test_exposurestore.py; these check the door: a food's page carries its
latest-year working and the method's constants, a contaminant page carries
its facts and every food it was found in, a re-score over chosen years
comes back computed, and refusals are 400s with the reason, unknown ids 404.
"""
import pytest
from flask import Flask

import commonsdb
import exposurestore
import foodstore
import hazardstore
import reference_loaders
from routes import exposure as exposure_routes
from tests.test_exposure import EPA_PAGE


@pytest.fixture
def client(data_dir, tmp_path, monkeypatch):
    root = tmp_path / "commons"
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    foodstore.add_food("potatoes")
    hazardstore.seed_starter_map()
    exposurestore.set_pdp_codes("potatoes", [("PO", "")])
    with commonsdb.session(root) as conn:
        conn.execute("INSERT INTO pdp_pesticides VALUES (2023, '036', 'Chlorpropham', '')")
        for year in (2022, 2023):
            for pk, ppb in ((1, 3000.0), (2, None)):
                conn.execute("INSERT INTO pdp_samples (year, sample_pk, commod, claim)"
                             " VALUES (?, ?, 'PO', 'NC')", (year, pk))
                conn.execute("INSERT INTO pdp_results (year, sample_pk, commod, pestcode, concen_ppb)"
                             " VALUES (?, ?, 'PO', '036', ?)", (year, pk, ppb))
    page = root / "epa.html"
    page.write_text(EPA_PAGE)
    with commonsdb.session(root) as conn:
        reference_loaders.load_benchmarks(conn, page)
    app = Flask(__name__)
    exposure_routes.register(app)
    test_client = app.test_client()
    test_client.post("/api/exposure/food/score", json={"name": "potatoes", "years": [2023]})
    return test_client


def test_food_page_carries_latest_year_working_and_method(client):
    body = client.get("/api/exposure/food?name=potatoes").get_json()
    headline = body["food"]["headline"]["conventional"]
    assert (headline["years"], headline["terms"][0]["pesticide"], body["method"]["body_kg"]) == \
        ("2023", "Chlorpropham", 16.0)


def test_unknown_food_is_not_an_error(client):
    assert client.get("/api/exposure/food?name=dragonfruit").get_json()["food"] is None


def test_rescore_over_chosen_years_combines_them(client):
    score = client.post("/api/exposure/food/score",
                        json={"name": "potatoes", "years": [2022, 2023]}).get_json()["score"]
    assert (score["years"], score["sample_count"]) == ("2022,2023", 4)


def test_rescore_with_no_years_is_refused(client):
    resp = client.post("/api/exposure/food/score", json={"name": "potatoes", "years": []})
    assert resp.status_code == 400 and "year" in resp.get_json()["error"]


def test_contaminant_page_shows_facts_and_where_found(client):
    listing = client.get("/api/exposure/contaminants").get_json()["contaminants"]
    chlorpropham = next(item for item in listing if item["name"] == "Chlorpropham")
    body = client.get(f"/api/exposure/contaminants/{chlorpropham['id']}").get_json()["contaminant"]
    assert "chronic_dose" in [fact["fact"] for fact in body["facts"]] and \
        [row["food"] for row in body["found_in"]] == ["potatoes"]


def test_unknown_contaminant_is_404(client):
    assert client.get("/api/exposure/contaminants/99999").status_code == 404


def test_she_can_dispute_a_fact(client):
    fact = exposurestore.facts_for("Chlorpropham")[0]
    assert client.post(f"/api/exposure/facts/{fact['id']}/review", json={"review": "disputed"}).status_code == 200
    assert exposurestore.facts_for("Chlorpropham")[0]["review"] == "disputed"


def test_a_bad_review_word_is_refused(client):
    fact = exposurestore.facts_for("Chlorpropham")[0]
    assert client.post(f"/api/exposure/facts/{fact['id']}/review", json={"review": "maybe"}).status_code == 400
