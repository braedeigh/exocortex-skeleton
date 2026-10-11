"""The research tables' HTTP contract (routes/research_tables.py).

The store's rules are tested in test_hazardstore.py; these check the door:
refusals come back as 400 with the reason, unknown ids as 404, and what the
owner writes through the page is hers — born confirmed, overriding an agent's
verdict while keeping it in the history.
"""
import pytest
from flask import Flask

import foodstore
import hazardstore
import store
from routes import research_tables

SOURCE = "2026-09-24.1000"


@pytest.fixture
def client(data_dir):
    store.write("research.json", {
        "topics": [],
        "entries": [{"id": SOURCE, "kind": "source", "text": "USDA PDP", "topics": [],
                     "url": "https://example.org", "verdict": "", "status": "",
                     "reply_to": None, "created": "2026-09-24 10:00"}],
        "sessions": [],
    })
    foodstore.add_food("potatoes")
    hazardstore.seed_starter_map()
    app = Flask(__name__)
    research_tables.register(app)
    return app.test_client()


def test_make_a_table_and_get_its_grid(client):
    resp = client.post("/api/research/tables/add",
                       json={"name": "Metals", "kind": "measures", "hazard": "Heavy metal"})
    assert resp.status_code == 200
    assert [c["name"] for c in resp.get_json()["columns"]] == ["Arsenic", "Cadmium", "Lead", "Mercury"]


def test_a_bad_table_is_refused_with_the_reason(client):
    resp = client.post("/api/research/tables/add", json={"name": "X", "kind": "pie"})
    assert resp.status_code == 400 and "kind" in resp.get_json()["error"]


def test_table_list_carries_the_vocabulary(client):
    body = client.get("/api/research/tables").get_json()
    assert body["vocab"]["lenses"] == ["health", "sustainability"]


def test_owner_reviews_a_number(client):
    measure_id, _ = hazardstore.record_measure("potatoes", "Lead", "concentration", 12, "ppb",
                                               source_id=SOURCE)
    resp = client.post(f"/api/research/measures/{measure_id}/review", json={"review": "disputed"})
    assert resp.get_json()["review"] == "disputed"


def test_reviewing_an_unknown_number_is_404(client):
    assert client.post("/api/research/measures/999/review", json={"review": "confirmed"}).status_code == 404


def test_owner_verdict_is_born_confirmed_and_keeps_the_agents(client):
    measure_id, _ = hazardstore.record_measure("potatoes", "Lead", "concentration", 12, "ppb",
                                               source_id=SOURCE)
    hazardstore.judge("potatoes", "health", "organic", reasoning="agent's view", grounds=[measure_id])
    body = client.post("/api/research/judgments/set",
                       json={"food": "potatoes", "lens": "health", "verdict": "conventional",
                             "reasoning": "lead is in the soil"}).get_json()
    assert (body["verdict"], body["review"], body["author"]) == ("conventional", "confirmed", "owner")
    assert body["history"][0]["snapshot"]["verdict"] == "organic"
    assert body["history"][0]["snapshot"]["author"] == "llm"
    assert [g["id"] for g in body["grounds"]] == [measure_id]


def test_hazard_loop_is_refused(client):
    pesticide = next(h["id"] for h in client.get("/api/research/hazards").get_json()["hazards"]
                     if h["name"] == "Pesticide")
    resp = client.post(f"/api/research/hazards/{pesticide}/update", json={"parents": ["Herbicide"]})
    assert resp.status_code == 400 and "loop" in resp.get_json()["error"]


def test_seeding_leaves_a_map_that_has_hazards_alone(client):
    before = client.get("/api/research/hazards").get_json()["hazards"]
    after = client.post("/api/research/hazards/seed").get_json()["hazards"]
    assert after == before
