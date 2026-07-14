"""Behavioral tests for the Fronts API (routes/fronts.py).

Fronts are a shared life-domain vocabulary (health, appearance, finances,
...) that research topics get tagged with. These pin down: slug id
generation with collision suffixes, rename-keeps-id, GET returns the seeded
list, and that removing a front strips its id from every research topic's
`fronts` list without touching the topics otherwise.
"""
import json

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


@pytest.fixture
def client(data_dir):
    """A minimal app exposing fronts.py + research.py (needed for the
    remove-cleanup test, which strips a deleted front id from topics)."""
    from flask import Flask
    from routes import fronts, research
    app = Flask(__name__)
    app.config.update(TESTING=True)
    fronts.register(app)
    research.register(app)
    return app.test_client()


def _read_fronts():
    import store
    return store.read("fronts.json", {"fronts": []})


def _read_research():
    import store
    return store.read("research.json", {"topics": [], "entries": []})


# --- GET -----------------------------------------------------------------

def test_get_returns_seeded_list(client):
    import store
    store.write("fronts.json", {"fronts": [
        {"id": "health", "name": "Health", "created": "2026-07-13 15:30"},
        {"id": "job", "name": "Job", "created": "2026-07-13 15:30"},
    ]})
    r = client.get("/api/fronts")
    assert r.status_code == 200
    ids = [f["id"] for f in r.get_json()["fronts"]]
    assert ids == ["health", "job"]


def test_get_empty_when_no_file(client):
    r = client.get("/api/fronts")
    assert r.status_code == 200
    assert r.get_json() == {"fronts": []}


# --- add -------------------------------------------------------------------

def test_add_creates_slug_id(client):
    r = _post(client, "/api/fronts/add", {"name": "Living Space"})
    assert r.status_code == 200
    fronts = r.get_json()["fronts"]
    assert len(fronts) == 1
    assert fronts[0]["id"] == "living-space"
    assert fronts[0]["name"] == "Living Space"
    assert "created" in fronts[0]


def test_add_duplicate_name_gets_distinct_slug(client):
    _post(client, "/api/fronts/add", {"name": "Health"})
    r = _post(client, "/api/fronts/add", {"name": "Health"})
    ids = [f["id"] for f in r.get_json()["fronts"]]
    assert ids == ["health", "health-2"]


def test_add_empty_name_400(client):
    r = _post(client, "/api/fronts/add", {"name": "   "})
    assert r.status_code == 400
    assert _read_fronts()["fronts"] == []


# --- edit --------------------------------------------------------------------

def test_edit_renames_keeps_id(client):
    _post(client, "/api/fronts/add", {"name": "Job"})
    fid = _read_fronts()["fronts"][0]["id"]
    r = _post(client, "/api/fronts/edit", {"id": fid, "name": "Career"})
    assert r.status_code == 200
    front = r.get_json()["fronts"][0]
    assert front["id"] == fid
    assert front["name"] == "Career"


def test_edit_not_found_404(client):
    r = _post(client, "/api/fronts/edit", {"id": "missing", "name": "x"})
    assert r.status_code == 404


def test_edit_empty_name_rejected(client):
    _post(client, "/api/fronts/add", {"name": "Job"})
    fid = _read_fronts()["fronts"][0]["id"]
    r = _post(client, "/api/fronts/edit", {"id": fid, "name": "   "})
    assert r.status_code == 400
    assert _read_fronts()["fronts"][0]["name"] == "Job"


# --- remove ------------------------------------------------------------------

def test_remove_strips_id_from_research_topics(client):
    _post(client, "/api/fronts/add", {"name": "Health"})
    fid = _read_fronts()["fronts"][0]["id"]
    _post(client, "/api/research/topic/add", {"name": "Sleep", "fronts": [fid]})
    tid = _read_research()["topics"][0]["id"]

    r = _post(client, "/api/fronts/remove", {"id": fid})
    assert r.status_code == 200
    assert r.get_json()["fronts"] == []

    topics = _read_research()["topics"]
    assert len(topics) == 1
    assert topics[0]["id"] == tid          # the topic itself survives
    assert topics[0]["fronts"] == []       # but loses the removed front id


def test_remove_leaves_other_fronts_on_topic(client):
    _post(client, "/api/fronts/add", {"name": "Health"})
    _post(client, "/api/fronts/add", {"name": "Job"})
    f1, f2 = [f["id"] for f in _read_fronts()["fronts"]]
    _post(client, "/api/research/topic/add", {"name": "Sleep", "fronts": [f1, f2]})

    _post(client, "/api/fronts/remove", {"id": f1})

    topics = _read_research()["topics"]
    assert topics[0]["fronts"] == [f2]


def test_remove_unknown_id_is_a_noop(client):
    _post(client, "/api/fronts/add", {"name": "Health"})
    r = _post(client, "/api/fronts/remove", {"id": "no-such-front"})
    assert r.status_code == 200
    assert len(r.get_json()["fronts"]) == 1


def test_remove_strips_id_from_todo_fronts_lists(client):
    """To-dos carry the same `fronts` list as research topics (2026-07-14);
    deleting a front un-tags them too — items survive, an emptied list is
    dropped entirely (absent = untagged), other fronts stay."""
    import store
    _post(client, "/api/fronts/add", {"name": "Health"})
    _post(client, "/api/fronts/add", {"name": "Connection"})
    f1, f2 = [f["id"] for f in _read_fronts()["fronts"]]
    store.write("todos", {"now": {"items": [
        {"id": "a", "text": "run group", "done": False, "fronts": [f1, f2]},
        {"id": "b", "text": "nap", "done": False, "fronts": [f1]},
    ]}})

    _post(client, "/api/fronts/remove", {"id": f1})

    items = store.read("todos", {})["now"]["items"]
    assert items[0]["fronts"] == [f2]
    assert "fronts" not in items[1] and items[1]["text"] == "nap"


def test_remove_strips_id_from_buy_list_fronts(client):
    """Buy-list items carry `fronts` too (2026-07-14, routes/inventory.py);
    deleting a front un-tags them — items survive, other fronts stay, an
    emptied list stays as [] (the buy list renders [] as untagged)."""
    import store
    _post(client, "/api/fronts/add", {"name": "Health"})
    _post(client, "/api/fronts/add", {"name": "Appearance"})
    f1, f2 = [f["id"] for f in _read_fronts()["fronts"]]
    store.write("buy_list.json", {"items": [
        {"name": "Barefoot shoes", "fronts": [f1, f2]},
        {"name": "MCT oil", "fronts": [f1]},
    ]})

    _post(client, "/api/fronts/remove", {"id": f1})

    items = store.read("buy_list.json", {"items": []})["items"]
    assert items[0]["fronts"] == [f2]
    assert items[1]["fronts"] == [] and items[1]["name"] == "MCT oil"
