"""Behavioral tests for the tab-set API (routes/tabsets.py).

The contract worth pinning: a fresh install gets usable sets without anyone
saving anything, and a bad PUT can never leave her with a workspace that has no
tabs — the route drops what it can't understand and refuses a body that leaves
nothing standing.
"""
import json

import pytest
from flask import Flask

from routes import tabsets


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config["TESTING"] = True
    tabsets.register(app)
    return app.test_client()


def _put(client, payload):
    return client.put("/api/tabsets", data=json.dumps(payload),
                      content_type="application/json")


def test_fresh_install_gets_the_default_sets(client):
    r = client.get("/api/tabsets")
    assert r.status_code == 200
    names = [s["name"] for s in r.get_json()["sets"]]
    assert names == ["Work", "Life", "Spare"]


def test_the_spare_set_starts_empty(client):
    sets = client.get("/api/tabsets").get_json()["sets"]
    assert next(s for s in sets if s["id"] == "spare")["sections"] == []


def test_defaults_are_usable_without_saving_anything(client):
    sets = client.get("/api/tabsets").get_json()["sets"]
    work = next(s for s in sets if s["id"] == "work")
    assert work["sections"] == ["observatory"]


def test_put_round_trips(client):
    payload = {"sets": [{"id": "work", "name": "Work", "sections": ["journal"]}]}
    assert _put(client, payload).status_code == 200
    saved = next(s for s in client.get("/api/tabsets").get_json()["sets"] if s["id"] == "work")
    assert saved["sections"] == ["journal"]


def test_a_built_in_set_added_later_reaches_an_install_that_already_saved(client):
    # The state every real install is in: saved before "spare" existed.
    _put(client, {"sets": [
        {"id": "work", "name": "Work", "sections": ["observatory"]},
        {"id": "life", "name": "Life", "sections": ["journal", "keeper"]},
    ]})
    sets = client.get("/api/tabsets").get_json()["sets"]
    assert [s["id"] for s in sets] == ["work", "life", "spare"]
    # ...and her own edits are untouched by the seeding.
    assert next(s for s in sets if s["id"] == "life")["sections"] == ["journal", "keeper"]


def test_seeding_repairs_a_stale_client_that_saved_without_the_new_set(client):
    # A tab open since before the set existed sends the old list back.
    _put(client, {"sets": [{"id": "work", "name": "Work", "sections": ["observatory"]}]})
    assert [s["id"] for s in client.get("/api/tabsets").get_json()["sets"]] == ["work", "life", "spare"]


def test_put_drops_malformed_sets_but_keeps_good_ones(client):
    r = _put(client, {"sets": [
        {"id": "ok", "name": "Fine", "sections": ["journal"]},
        {"id": "", "name": "No id", "sections": []},
        {"name": "No id at all", "sections": []},
        {"id": "x", "name": "Sections not a list", "sections": "journal"},
        "not even a dict",
    ]})
    assert r.status_code == 200
    assert [s["id"] for s in r.get_json()["sets"]] == ["ok"]


def test_put_drops_duplicate_sections(client):
    # Pinning is a toggle, so a duplicated tab could never be un-pinned.
    r = _put(client, {"sets": [
        {"id": "work", "name": "Work", "sections": ["journal", "journal", "pond"]},
    ]})
    assert r.get_json()["sets"][0]["sections"] == ["journal", "pond"]


def test_put_with_nothing_valid_is_refused_and_changes_nothing(client):
    _put(client, {"sets": [{"id": "work", "name": "Work", "sections": ["journal"]}]})
    r = _put(client, {"sets": [{"nope": True}]})
    assert r.status_code == 400
    # The last good save is still there.
    assert client.get("/api/tabsets").get_json()["sets"][0]["sections"] == ["journal"]


def test_a_set_may_have_no_sections(client):
    # An empty bar is a legitimate thing to want; it just isn't a malformed set.
    r = _put(client, {"sets": [{"id": "bare", "name": "Bare", "sections": []}]})
    assert r.status_code == 200
    assert r.get_json()["sets"][0]["sections"] == []
