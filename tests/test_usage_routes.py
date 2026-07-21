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


def test_batch_persists_time_and_clicks_into_a_fresh_day(client):
    res = client.post("/api/usage/batch", json={
        "time": {"journal": 84},
        "clicks": {"journal": {"card-edit": 3, "day-next": 1}},
    })
    assert res.status_code == 200
    assert res.get_json() == {"ok": True}
    assert read_usage()["days"][today()] == {
        "time": {"journal": 84},
        "clicks": {"journal": {"card-edit": 3, "day-next": 1}},
    }


def test_batch_accumulates_across_flushes(client):
    client.post("/api/usage/batch", json={
        "time": {"journal": 84}, "clicks": {"journal": {"card-edit": 3}}})
    client.post("/api/usage/batch", json={
        "time": {"journal": 16}, "clicks": {"journal": {"card-edit": 2}}})
    day = read_usage()["days"][today()]
    assert day["time"] == {"journal": 100}
    assert day["clicks"] == {"journal": {"card-edit": 5}}


def test_batch_leaves_existing_tabs_count_untouched(client):
    client.post("/api/usage/tab", json={"tab": "journal"})
    client.post("/api/usage/batch", json={"time": {"journal": 84}})
    day = read_usage()["days"][today()]
    assert day["tabs"] == {"journal": 1}
    assert day["time"] == {"journal": 84}


def test_batch_invalid_control_name_400s_and_persists_nothing(client):
    res = client.post("/api/usage/batch", json={
        "time": {"journal": 84},                      # valid half...
        "clicks": {"journal": {"Card Edit!": 3}},     # ...bad control name
    })
    assert res.status_code == 400
    assert read_usage() == {"days": {}}               # not even the valid part


def test_batch_out_of_range_values_400_and_persist_nothing(client):
    for body in (
        {"time": {"journal": 0}},
        {"time": {"journal": -5}},
        {"time": {"journal": 86401}},
        {"time": {"journal": "84"}},
        {"clicks": {"journal": {"card-edit": 0}}},
        {"clicks": {"journal": {"card-edit": -1}}},
        {"clicks": {"journal": {"card-edit": 10001}}},
    ):
        res = client.post("/api/usage/batch", json=body)
        assert res.status_code == 400
    assert read_usage() == {"days": {}}


def test_batch_empty_body_is_ok_and_writes_nothing(client):
    res = client.post("/api/usage/batch", json={})
    assert res.status_code == 200
    assert res.get_json() == {"ok": True}
    assert read_usage() == {"days": {}}


# --- GET /api/usage/export ---------------------------------------------------

def seed_days(days):
    store.write("feature_usage.json", {"days": days})


def days_ago(n):
    from datetime import timedelta
    return (datetime.now() - timedelta(days=n)).strftime("%Y-%m-%d")


def test_export_bundle_shape_and_schema_tag(client):
    seed_days({
        days_ago(2): {"tabs": {"journal": 3}},
        days_ago(0): {"time": {"journal": 60}},
    })
    res = client.get("/api/usage/export")
    assert res.status_code == 200
    body = res.get_json()
    assert body["schema"] == "usage-export/1"
    assert body["generated"] == today()
    assert body["range"] == {"from": days_ago(2), "to": days_ago(0)}
    assert body["days"] == {
        days_ago(2): {"tabs": {"journal": 3}},
        days_ago(0): {"time": {"journal": 60}},
    }
    assert "label" not in body


def test_export_sets_download_headers(client):
    res = client.get("/api/usage/export")
    assert res.headers["Content-Type"] == "application/json"
    assert res.headers["Content-Disposition"] == (
        f'attachment; filename="usage-export-{today()}.json"')


def test_export_days_param_keeps_only_the_trailing_window(client):
    seed_days({
        days_ago(10): {"tabs": {"old": 1}},
        days_ago(2): {"tabs": {"recent": 1}},
        days_ago(0): {"tabs": {"today": 1}},
    })
    res = client.get("/api/usage/export?days=3")
    body = res.get_json()
    assert set(body["days"]) == {days_ago(2), days_ago(0)}
    assert body["range"] == {"from": days_ago(2), "to": days_ago(0)}


def test_export_label_is_stored_verbatim(client):
    res = client.get("/api/usage/export?label=fern%20%26%20co")
    assert res.get_json()["label"] == "fern & co"


def test_export_label_absent_omits_the_key(client):
    assert "label" not in client.get("/api/usage/export").get_json()


def test_export_label_truncates_at_80_chars(client):
    res = client.get("/api/usage/export?label=" + "x" * 200)
    assert res.get_json()["label"] == "x" * 80


def test_export_junk_days_param_400s(client):
    for junk in ("abc", "0", "-3", "1.5", ""):
        res = client.get(f"/api/usage/export?days={junk}")
        assert res.status_code == 400, junk


def test_export_empty_collection_has_null_range(client):
    body = client.get("/api/usage/export").get_json()
    assert body["days"] == {}
    assert body["range"] == {"from": None, "to": None}
