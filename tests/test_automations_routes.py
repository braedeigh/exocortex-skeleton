"""HTTP contract for the automations registry (routes/automations.py).

Isolated per-test via the `data_dir` fixture (store.DATA_DIR -> tmp_path), same
as the other route tests. Seeds scheduled_runs.json, hits the endpoints, asserts
the persisted result.
"""
import pytest
from flask import Flask

import store
from routes import automations


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    automations.register(app)
    return app.test_client()


def _seed(**over):
    run = {"id": "spark_morning", "name": "Morning Spark", "enabled": True,
           "last_run": None, "last_status": None, "last_conv_id": None}
    run.update(over)
    store.write("scheduled_runs.json", {"runs": [run]})


def test_list_empty_when_unseeded(client):
    assert client.get("/api/automations").get_json() == {"runs": []}


def test_list_returns_seeded_runs(client):
    _seed(last_run="2026-07-24T09:14:50", last_status="ok", last_conv_id="c1")
    runs = client.get("/api/automations").get_json()["runs"]
    assert len(runs) == 1
    assert runs[0]["id"] == "spark_morning"
    assert runs[0]["last_conv_id"] == "c1"


def test_list_sorts_newest_last_run_first(client):
    store.write("scheduled_runs.json", {"runs": [
        {"id": "a", "last_run": "2026-07-20T05:00:00"},
        {"id": "b", "last_run": "2026-07-24T05:00:00"},
        {"id": "c", "last_run": None},
    ]})
    ids = [r["id"] for r in client.get("/api/automations").get_json()["runs"]]
    assert ids == ["b", "a", "c"]


def test_toggle_flips_enabled_and_persists(client):
    _seed(enabled=True)
    assert client.post("/api/automations/spark_morning/toggle").get_json()["enabled"] is False
    assert store.read("scheduled_runs.json")["runs"][0]["enabled"] is False
    assert client.post("/api/automations/spark_morning/toggle").get_json()["enabled"] is True
    assert store.read("scheduled_runs.json")["runs"][0]["enabled"] is True


def test_toggle_unknown_run_404_and_writes_nothing(client):
    _seed()
    assert client.post("/api/automations/nope/toggle").status_code == 404
    # the real run is untouched
    assert store.read("scheduled_runs.json")["runs"][0]["enabled"] is True
