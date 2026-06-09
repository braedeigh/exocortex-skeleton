"""Tests for the Places store API (routes_places.py)."""
import json

import store


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


def _places():
    return store.read("places", {}).get("places", [])


def test_add_place_returns_id(client, data_dir):
    r = _post(client, "/api/places/add", {"name": "Avita", "address": "123 Main St"})
    assert r.status_code == 200
    pid = r.get_json()["id"]
    places = _places()
    assert len(places) == 1
    assert places[0]["id"] == pid
    assert places[0]["name"] == "Avita"
    assert places[0]["address"] == "123 Main St"


def test_add_place_requires_name(client, data_dir):
    r = _post(client, "/api/places/add", {"name": "  "})
    assert r.status_code == 400


def test_add_place_rejects_duplicate_name(client, data_dir):
    _post(client, "/api/places/add", {"name": "Walgreens"})
    r = _post(client, "/api/places/add", {"name": "walgreens"})
    assert r.status_code == 400
    assert len(_places()) == 1


def test_update_place(client, data_dir):
    pid = _post(client, "/api/places/add", {"name": "Shop"}).get_json()["id"]
    _post(client, "/api/places/update", {"id": pid, "address": "9 Oak Ave", "category": "car"})
    p = _places()[0]
    assert p["address"] == "9 Oak Ave"
    assert p["category"] == "car"


def test_update_unknown_place_404(client, data_dir):
    r = _post(client, "/api/places/update", {"id": "nope", "name": "x"})
    assert r.status_code == 404


def test_remove_place(client, data_dir):
    pid = _post(client, "/api/places/add", {"name": "Temp"}).get_json()["id"]
    _post(client, "/api/places/remove", {"id": pid})
    assert _places() == []
