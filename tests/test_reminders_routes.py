"""HTTP contract for /api/reminders/save — field sanitizing, esp. `shape`."""
import pytest

import store


@pytest.fixture
def client(data_dir):
    """Minimal app exposing only the reminders routes."""
    from flask import Flask
    from routes import reminders
    app = Flask(__name__)
    app.config.update(TESTING=True)
    reminders.register(app)
    return app.test_client()


def read_reminders():
    return store.read("reminders.json", {"reminders": []})


def _save(client, items):
    return client.post("/api/reminders/save", json={"reminders": items})


def test_valid_shape_is_persisted(client):
    res = _save(client, [{"label": "Estradiol", "shape": "triangle"}])
    assert res.status_code == 200
    saved = read_reminders()["reminders"]
    assert saved[0]["shape"] == "triangle"


def test_unknown_shape_falls_back_to_circle(client):
    _save(client, [{"label": "Sheets", "shape": "hexagon"}])
    assert read_reminders()["reminders"][0]["shape"] == "circle"


def test_missing_shape_defaults_to_circle(client):
    _save(client, [{"label": "Hair wash"}])
    assert read_reminders()["reminders"][0]["shape"] == "circle"


def test_shape_case_is_normalized(client):
    _save(client, [{"label": "TB-500", "shape": "Diamond"}])
    assert read_reminders()["reminders"][0]["shape"] == "diamond"
