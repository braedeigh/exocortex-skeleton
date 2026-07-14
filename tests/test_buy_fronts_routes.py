"""Buy-list `fronts` contract — zero-or-more front ids (routes/fronts.py) per item."""
import pytest
from flask import Flask

import store
from routes import inventory


@pytest.fixture
def buy_client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    inventory.register(app)
    return app.test_client()


def read_buy_list():
    return store.read("buy_list.json", {"items": []})


def test_add_stores_fronts(buy_client):
    res = buy_client.post(
        "/api/buy/add",
        json={"name": "Shikibuton", "fronts": ["living-space", "health"]},
    )
    assert res.status_code == 200
    assert read_buy_list()["items"][0]["fronts"] == ["living-space", "health"]


def test_add_without_fronts_is_empty_list(buy_client):
    buy_client.post("/api/buy/add", json={"name": "Mystery thing"})
    assert read_buy_list()["items"][0]["fronts"] == []


def test_add_sanitizes_fronts(buy_client):
    buy_client.post(
        "/api/buy/add",
        json={"name": "Weird tags", "fronts": ["health", "", 42, "  ", " job "]},
    )
    assert read_buy_list()["items"][0]["fronts"] == ["health", "job"]


def test_update_retags_fronts(buy_client):
    buy_client.post("/api/buy/add", json={"name": "Tarot deck", "fronts": ["hobbies"]})
    buy_client.post(
        "/api/buy/update", json={"name": "Tarot deck", "fronts": ["practice"]}
    )
    assert read_buy_list()["items"][0]["fronts"] == ["practice"]


def test_update_can_clear_fronts(buy_client):
    buy_client.post("/api/buy/add", json={"name": "Makeup", "fronts": ["appearance"]})
    buy_client.post("/api/buy/update", json={"name": "Makeup", "fronts": []})
    assert read_buy_list()["items"][0]["fronts"] == []


def test_update_without_fronts_leaves_tags_alone(buy_client):
    buy_client.post("/api/buy/add", json={"name": "MCT oil", "fronts": ["health"]})
    buy_client.post("/api/buy/update", json={"name": "MCT oil", "priority": "low"})
    assert read_buy_list()["items"][0]["fronts"] == ["health"]
