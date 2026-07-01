"""Behavioral tests for the Housing-search API (routes/housing.py).

The housing tracker is a list of places on a status ladder
(found→contacted→touring→toured→applied→passed→got_it) plus a free-text
notes box. These pin the HTTP contract: add assigns a stable id and clamps
status, update only touches sent fields and rejects bad ids/statuses, remove
is by id, and the notes box round-trips independently of the entries.

Same shape as the other route tests: minimal app, only this blueprint.
"""
import json

import pytest

import store


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the housing routes."""
    from flask import Flask
    from routes import housing
    app = Flask(__name__)
    app.config.update(TESTING=True)
    housing.register(app)
    return app.test_client()


def _post(client, path, payload=None):
    return client.post(path, data=json.dumps(payload or {}), content_type="application/json")


def read_housing():
    return store.read("housing.json", {"entries": [], "notes": ""})


def test_add_assigns_id_and_defaults(client):
    res = _post(client, "/api/housing/add", {"name": "Peterson"})
    assert res.status_code == 200
    new_id = res.get_json()["id"]
    entries = read_housing()["entries"]
    assert len(entries) == 1
    e = entries[0]
    assert e["id"] == new_id
    assert e["name"] == "Peterson"
    assert e["status"] == "found"  # default when unspecified


def test_add_blank_name_falls_back(client):
    _post(client, "/api/housing/add", {"name": "   "})
    assert read_housing()["entries"][0]["name"] == "Untitled place"


def test_add_clamps_invalid_status(client):
    _post(client, "/api/housing/add", {"name": "X", "status": "bogus"})
    assert read_housing()["entries"][0]["status"] == "found"


def test_add_accepts_valid_status(client):
    _post(client, "/api/housing/add", {"name": "X", "status": "applied"})
    assert read_housing()["entries"][0]["status"] == "applied"


def test_update_only_touches_sent_fields(client):
    new_id = _post(client, "/api/housing/add",
                   {"name": "X", "rent": "$1000", "status": "found"}).get_json()["id"]
    res = _post(client, "/api/housing/update", {"id": new_id, "status": "toured"})
    assert res.status_code == 200
    e = read_housing()["entries"][0]
    assert e["status"] == "toured"
    assert e["rent"] == "$1000"  # untouched
    assert e["name"] == "X"


def test_update_rejects_bad_status(client):
    new_id = _post(client, "/api/housing/add", {"name": "X", "status": "found"}).get_json()["id"]
    _post(client, "/api/housing/update", {"id": new_id, "status": "nope"})
    assert read_housing()["entries"][0]["status"] == "found"  # unchanged


def test_update_missing_id_is_400(client):
    res = _post(client, "/api/housing/update", {"status": "toured"})
    assert res.status_code == 400


def test_update_unknown_id_is_404(client):
    _post(client, "/api/housing/add", {"name": "X"})
    res = _post(client, "/api/housing/update", {"id": "deadbeef", "status": "toured"})
    assert res.status_code == 404


def test_remove_by_id(client):
    id_a = _post(client, "/api/housing/add", {"name": "A"}).get_json()["id"]
    id_b = _post(client, "/api/housing/add", {"name": "B"}).get_json()["id"]
    _post(client, "/api/housing/remove", {"id": id_a})
    remaining = read_housing()["entries"]
    assert [e["id"] for e in remaining] == [id_b]


def test_notes_roundtrip_independent_of_entries(client):
    _post(client, "/api/housing/add", {"name": "A"})
    _post(client, "/api/housing/notes/save", {"text": "near DSHS, live alone"})
    data = read_housing()
    assert data["notes"] == "near DSHS, live alone"
    assert len(data["entries"]) == 1  # entries survive a notes save
