"""Behavioral tests for the Ecosystem API (routes/ecosystem.py).

The ecosystem store is a flat list of food sources, each a point on a map. A
source carries a location (lat/lng) and a `precision` — "point" (a crisp dot) or
"area" (a dot inside a soft circle of `radius_km`). These tests pin down the
CRUD + the field contracts that matter: required name + location, partial
updates, the point/area + radius normalisation, and 404s.

Same shape as test_movement_routes: a minimal app with only this blueprint, an
isolated temp data dir (via the `data_dir` fixture), read back through `store`.
"""
import json

import pytest

import store


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the ecosystem routes."""
    from flask import Flask
    from routes import ecosystem
    app = Flask(__name__)
    app.config.update(TESTING=True)
    ecosystem.register(app)
    return app.test_client()


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


def read_eco():
    return store.read("ecosystem", {"sources": []})


# --- helpers to build state --------------------------------------------------

def _add(client, **fields):
    payload = {"name": fields.pop("name", "Quinoa"), "lat": fields.pop("lat", 30.0),
               "lng": fields.pop("lng", -97.0)}
    payload.update(fields)
    r = _post(client, "/api/ecosystem/source/add", payload)
    assert r.status_code == 200, r.get_json()
    return r.get_json()["id"]


def _source(client):
    return read_eco()["sources"][0]


# --- add ---------------------------------------------------------------------

def test_add_creates_with_id_and_defaults(client, data_dir):
    sid = _add(client, name="HEB chuck roast", lat=31.0, lng=-99.0)
    sources = read_eco()["sources"]
    assert len(sources) == 1
    s = sources[0]
    assert s["id"] == sid
    assert s["name"] == "HEB chuck roast"
    assert s["lat"] == 31.0 and s["lng"] == -99.0
    assert s["layer"] == "food"           # default layer
    assert s["precision"] == "point"      # default precision
    assert s["radius_km"] == 0.0          # a point carries no radius
    assert s["note"] == ""


def test_add_area_keeps_radius(client, data_dir):
    _add(client, name="Quinoa", precision="area", radius_km=300)
    s = _source(client)
    assert s["precision"] == "area"
    assert s["radius_km"] == 300.0


def test_add_point_zeroes_radius_even_if_sent(client, data_dir):
    # A precise dot can't be a fuzzy region — radius is forced to 0.
    _add(client, name="Lundberg rice", precision="point", radius_km=120)
    assert _source(client)["radius_km"] == 0.0


def test_add_requires_name(client, data_dir):
    r = _post(client, "/api/ecosystem/source/add", {"name": "  ", "lat": 30, "lng": -97})
    assert r.status_code == 400
    assert read_eco()["sources"] == []


def test_add_requires_location(client, data_dir):
    r = _post(client, "/api/ecosystem/source/add", {"name": "Kale"})
    assert r.status_code == 400
    assert read_eco()["sources"] == []


def test_add_rejects_unparseable_location(client, data_dir):
    r = _post(client, "/api/ecosystem/source/add",
              {"name": "Kale", "lat": "north", "lng": -97})
    assert r.status_code == 400
    assert read_eco()["sources"] == []


# --- update ------------------------------------------------------------------

def test_update_is_partial(client, data_dir):
    sid = _add(client, name="HEB milk", note="dairy belt", lat=32.2, lng=-98.2)
    _post(client, "/api/ecosystem/source/update", {"id": sid, "note": "Erath County dairies"})
    s = _source(client)
    assert s["note"] == "Erath County dairies"   # changed
    assert s["name"] == "HEB milk"                # untouched
    assert s["lat"] == 32.2                       # untouched


def test_update_can_move_location(client, data_dir):
    sid = _add(client, lat=30.0, lng=-97.0)
    _post(client, "/api/ecosystem/source/update", {"id": sid, "lat": 26.3, "lng": -98.2})
    s = _source(client)
    assert s["lat"] == 26.3 and s["lng"] == -98.2


def test_update_to_point_clears_radius(client, data_dir):
    sid = _add(client, precision="area", radius_km=200)
    _post(client, "/api/ecosystem/source/update", {"id": sid, "precision": "point"})
    s = _source(client)
    assert s["precision"] == "point"
    assert s["radius_km"] == 0.0          # normalised away when it becomes a point


def test_update_to_area_then_set_radius(client, data_dir):
    sid = _add(client)  # starts as a point
    _post(client, "/api/ecosystem/source/update",
          {"id": sid, "precision": "area", "radius_km": 150})
    s = _source(client)
    assert s["precision"] == "area"
    assert s["radius_km"] == 150.0


def test_update_empty_name_rejected(client, data_dir):
    sid = _add(client, name="Keep")
    r = _post(client, "/api/ecosystem/source/update", {"id": sid, "name": "  "})
    assert r.status_code == 400
    assert _source(client)["name"] == "Keep"


def test_update_unknown_404(client, data_dir):
    r = _post(client, "/api/ecosystem/source/update", {"id": "nope", "name": "X"})
    assert r.status_code == 404


# --- remove ------------------------------------------------------------------

def test_remove(client, data_dir):
    sid = _add(client)
    _post(client, "/api/ecosystem/source/remove", {"id": sid})
    assert read_eco()["sources"] == []


def test_remove_leaves_siblings(client, data_dir):
    a = _add(client, name="A")
    _add(client, name="B")
    _post(client, "/api/ecosystem/source/remove", {"id": a})
    names = [s["name"] for s in read_eco()["sources"]]
    assert names == ["B"]
