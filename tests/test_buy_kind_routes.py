"""Buy-list `kind` contract (consumable | durable | service, '' = unsorted)."""
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


def test_add_stores_kind(buy_client):
    res = buy_client.post("/api/buy/add", json={"name": "Magnesium", "kind": "consumable"})
    assert res.status_code == 200
    assert read_buy_list()["items"][0]["kind"] == "consumable"


def test_add_without_kind_is_unsorted(buy_client):
    buy_client.post("/api/buy/add", json={"name": "Mystery thing"})
    assert read_buy_list()["items"][0]["kind"] == ""


def test_update_files_item_under_kind(buy_client):
    buy_client.post("/api/buy/add", json={"name": "Electrician"})
    buy_client.post("/api/buy/update", json={"name": "Electrician", "kind": "service"})
    assert read_buy_list()["items"][0]["kind"] == "service"


def test_restock_marks_buy_item_consumable(buy_client):
    buy_client.post("/api/active/add", json={"name": "Fish oil"})
    buy_client.post("/api/active/restock", json={"name": "Fish oil"})
    items = read_buy_list()["items"]
    assert items[0]["name"] == "Fish oil"
    assert items[0]["kind"] == "consumable"
