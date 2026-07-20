"""HTTP contract for the feature-usage tab beacon + readback routes."""
from datetime import datetime

import pytest

import store


@pytest.fixture
def client(data_dir):
    """Minimal app exposing only the usage routes."""
    from flask import Flask
    from routes import usage
    app = Flask(__name__)
    app.config.update(TESTING=True)
    usage.register(app)
    return app.test_client()


def read_usage():
    return store.read("feature_usage.json", {"days": {}})


def today():
    return datetime.now().strftime("%Y-%m-%d")


def test_beacon_increments_a_fresh_day(client):
    res = client.post("/api/usage/tab", json={"tab": "habits"})
    assert res.status_code == 200
    assert res.get_json() == {"ok": True}
    assert read_usage()["days"][today()]["tabs"] == {"habits": 1}


def test_beacon_increments_twice_to_two(client):
    client.post("/api/usage/tab", json={"tab": "habits"})
    client.post("/api/usage/tab", json={"tab": "habits"})
    assert read_usage()["days"][today()]["tabs"]["habits"] == 2


def test_bad_tab_name_400s_and_persists_nothing(client):
    for bad in ("Habits", "kitchen sink", "a" * 41, "", None):
        res = client.post("/api/usage/tab", json={"tab": bad})
        assert res.status_code == 400
    assert read_usage() == {"days": {}}


def test_get_usage_returns_persisted_shape(client):
    client.post("/api/usage/tab", json={"tab": "kitchen"})
    res = client.get("/api/usage")
    assert res.status_code == 200
    assert res.get_json() == {"days": {today(): {"tabs": {"kitchen": 1}}}}
