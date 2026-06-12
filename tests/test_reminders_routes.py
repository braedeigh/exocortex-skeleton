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


# --- /api/reminders/snooze ("kick the can down the road") ---

def test_snooze_sets_a_future_date(client):
    from datetime import datetime, timedelta
    _save(client, [{"label": "Sheets", "id": "rem_sheets"}])
    res = client.post("/api/reminders/snooze", json={"id": "rem_sheets", "days": 7})
    assert res.status_code == 200
    expect = (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d")
    assert read_reminders()["reminders"][0]["snoozed_until"] == expect


def test_snooze_zero_days_clears_it(client):
    _save(client, [{"label": "Sheets", "id": "rem_sheets", "snoozed_until": "2099-01-01"}])
    client.post("/api/reminders/snooze", json={"id": "rem_sheets", "days": 0})
    assert "snoozed_until" not in read_reminders()["reminders"][0]


def test_snooze_matches_by_type_too(client):
    _save(client, [{"label": "Sheets", "type": "sheets"}])
    res = client.post("/api/reminders/snooze", json={"type": "sheets", "days": 3})
    assert res.status_code == 200
    assert read_reminders()["reminders"][0]["snoozed_until"]


def test_snooze_unknown_reminder_404s(client):
    _save(client, [{"label": "Sheets"}])
    assert client.post("/api/reminders/snooze", json={"id": "nope", "days": 3}).status_code == 404


def test_manage_save_preserves_snoozed_until(client):
    """The manage modal saves the whole list — a snooze must survive that round-trip."""
    _save(client, [{"label": "Sheets", "id": "rem_sheets"}])
    client.post("/api/reminders/snooze", json={"id": "rem_sheets", "days": 7})
    snoozed = read_reminders()["reminders"]
    _save(client, snoozed)   # what the manager does: re-save what it loaded
    assert read_reminders()["reminders"][0].get("snoozed_until")


def test_save_drops_malformed_snoozed_until(client):
    _save(client, [{"label": "Sheets", "snoozed_until": "next tuesday"}])
    assert "snoozed_until" not in read_reminders()["reminders"][0]
