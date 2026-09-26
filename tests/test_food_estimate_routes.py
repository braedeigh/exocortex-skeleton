"""The grocery list's buy-organic door (routes/food.py → estimatestore.py).

The contract: list-verdicts returns every list item with its research verdict
and estimate plus the words to show them in; a review of an unknown estimate
is a 400, never a 500; and a run is refused while one is already going.
"""
import fcntl

import pytest
from flask import Flask

import estimatestore
import foodstore
import store
from routes import food


@pytest.fixture
def client(data_dir):
    store.write("kitchen.json", {"items": [{"name": "Kale", "category": "produce"}]})
    foodstore.add_food("kale", category="produce")
    app = Flask(__name__)
    food.register(app)
    return app.test_client()


def _estimate():
    return estimatestore.save("kale", {
        "verdict": "organic", "confidence": "high", "summary": "Heavily sprayed.",
        "qualifiers": [], "contaminants": []})


def test_list_verdicts_carries_the_estimate_and_vocab(client):
    _estimate()
    body = client.get("/api/food/list-verdicts").get_json()
    assert (body["items"][0]["estimate"]["verdict"], body["vocab"]["verdicts"]["organic"],
            body["running"]) == ("organic", "buy organic", False)


def test_review_sets_the_mark(client):
    estimate_id = _estimate()
    client.post(f"/api/food/estimates/{estimate_id}/review", json={"review": "confirmed"})
    assert client.get("/api/food/list-verdicts").get_json()["items"][0]["estimate"]["review"] == "confirmed"


def test_review_of_unknown_estimate_is_a_400(client):
    assert client.post("/api/food/estimates/999/review", json={"review": "confirmed"}).status_code == 400


def test_run_is_refused_while_one_is_going(client):
    with open(estimatestore.lock_path(), "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        assert client.post("/api/food/estimates/run", json={}).status_code == 409


def test_food_page_answers_with_vocab(client):
    body = client.get("/api/food/page?name=Kale").get_json()
    assert (body["food"]["name"], body["vocab"]["verdicts"]["organic"]) == ("kale", "buy organic")


def test_food_pages_lists_the_catalog(client):
    assert [f["name"] for f in client.get("/api/food/pages").get_json()["foods"]] == ["kale"]
