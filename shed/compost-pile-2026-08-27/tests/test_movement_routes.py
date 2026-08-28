"""Behavioral tests for the Movement API (routes/movement.py).

Movement is a list of routines, each holding an ordered list of moves. Each move
carries a name, an optional demo-video URL, a `dose` (reps/hold, freeform), and a
cue `note`. These tests pin down the CRUD + reorder behavior and the field-level
contracts (partial updates, the dose field, validation, nested 404s).

Same shape as test_todos_routes: a minimal app with only this blueprint, an
isolated temp data dir (via the `data_dir` fixture), read back through `store`.
"""
import json

import pytest

import store


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the movement routes."""
    from flask import Flask
    from routes import movement
    app = Flask(__name__)
    app.config.update(TESTING=True)
    movement.register(app)
    return app.test_client()


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


def read_movement():
    return store.read("movement", {"routines": []})


# --- helpers to build state --------------------------------------------------

def _add_routine(client, name="Evening Neck", note=""):
    r = _post(client, "/api/movement/routine/add", {"name": name, "note": note})
    assert r.status_code == 200
    return r.get_json()["id"]


def _add_move(client, rid, **fields):
    payload = {"routine_id": rid, "name": fields.pop("name", "Move")}
    payload.update(fields)
    r = _post(client, "/api/movement/move/add", payload)
    assert r.status_code == 200
    return r.get_json()["id"]


def _routine(client):
    return read_movement()["routines"][0]


# --- routines ----------------------------------------------------------------

def test_add_routine_creates_with_id_and_empty_moves(client, data_dir):
    rid = _add_routine(client, "Evening Neck", note="wind-down")
    routines = read_movement()["routines"]
    assert len(routines) == 1
    assert routines[0]["id"] == rid
    assert routines[0]["name"] == "Evening Neck"
    assert routines[0]["note"] == "wind-down"
    assert routines[0]["moves"] == []


def test_add_routine_requires_name(client, data_dir):
    r = _post(client, "/api/movement/routine/add", {"name": "   "})
    assert r.status_code == 400
    assert read_movement()["routines"] == []


def test_rename_routine_keeps_id_and_moves(client, data_dir):
    rid = _add_routine(client, "Old")
    _add_move(client, rid, name="Cat-cow")
    _post(client, "/api/movement/routine/update", {"id": rid, "name": "New"})
    r = _routine(client)
    assert r["id"] == rid
    assert r["name"] == "New"
    assert len(r["moves"]) == 1          # moves survive a rename


def test_update_routine_empty_name_rejected(client, data_dir):
    rid = _add_routine(client, "Keep")
    r = _post(client, "/api/movement/routine/update", {"id": rid, "name": "  "})
    assert r.status_code == 400
    assert _routine(client)["name"] == "Keep"


def test_update_unknown_routine_404(client, data_dir):
    r = _post(client, "/api/movement/routine/update", {"id": "nope", "name": "X"})
    assert r.status_code == 404


def test_remove_routine(client, data_dir):
    rid = _add_routine(client)
    _post(client, "/api/movement/routine/remove", {"id": rid})
    assert read_movement()["routines"] == []


# --- moves -------------------------------------------------------------------

def test_add_move_persists_all_fields(client, data_dir):
    rid = _add_routine(client)
    _add_move(client, rid, name="Cat-cow",
              url="https://www.youtube.com/watch?v=vuyUwtHl694",
              dose="8–10 slow rounds", note="warm-up, flow with breath")
    move = _routine(client)["moves"][0]
    assert move["name"] == "Cat-cow"
    assert move["dose"] == "8–10 slow rounds"
    assert move["note"] == "warm-up, flow with breath"
    assert "youtube.com" in move["url"]
    assert move["id"]


def test_add_move_defaults_blank_optional_fields(client, data_dir):
    rid = _add_routine(client)
    _add_move(client, rid, name="Child's pose")   # no url/dose/note
    move = _routine(client)["moves"][0]
    assert move["url"] == ""
    assert move["dose"] == ""
    assert move["note"] == ""


def test_add_move_requires_name(client, data_dir):
    rid = _add_routine(client)
    r = _post(client, "/api/movement/move/add", {"routine_id": rid, "name": ""})
    assert r.status_code == 400
    assert _routine(client)["moves"] == []


def test_add_move_unknown_routine_404(client, data_dir):
    r = _post(client, "/api/movement/move/add", {"routine_id": "nope", "name": "X"})
    assert r.status_code == 404


def test_update_move_is_partial(client, data_dir):
    # Updating one field must leave the others untouched.
    rid = _add_routine(client)
    mid = _add_move(client, rid, name="Upper trap", dose="20s", note="ear to shoulder")
    _post(client, "/api/movement/move/update",
          {"routine_id": rid, "id": mid, "dose": "30s · 2×/side"})
    move = _routine(client)["moves"][0]
    assert move["dose"] == "30s · 2×/side"     # changed
    assert move["name"] == "Upper trap"        # untouched
    assert move["note"] == "ear to shoulder"   # untouched


def test_update_move_can_set_url(client, data_dir):
    rid = _add_routine(client)
    mid = _add_move(client, rid, name="Doorway chest")
    _post(client, "/api/movement/move/update",
          {"routine_id": rid, "id": mid, "url": "https://youtu.be/B9uY01NoqBg"})
    assert _routine(client)["moves"][0]["url"] == "https://youtu.be/B9uY01NoqBg"


def test_update_move_empty_name_rejected(client, data_dir):
    rid = _add_routine(client)
    mid = _add_move(client, rid, name="Thread the needle")
    r = _post(client, "/api/movement/move/update",
              {"routine_id": rid, "id": mid, "name": "  "})
    assert r.status_code == 400
    assert _routine(client)["moves"][0]["name"] == "Thread the needle"


def test_update_move_unknown_ids_404(client, data_dir):
    rid = _add_routine(client)
    assert _post(client, "/api/movement/move/update",
                 {"routine_id": "nope", "id": "x"}).status_code == 404
    assert _post(client, "/api/movement/move/update",
                 {"routine_id": rid, "id": "nope"}).status_code == 404


def test_remove_move_leaves_siblings(client, data_dir):
    rid = _add_routine(client)
    a = _add_move(client, rid, name="A")
    _add_move(client, rid, name="B")
    _post(client, "/api/movement/move/remove", {"routine_id": rid, "id": a})
    names = [m["name"] for m in _routine(client)["moves"]]
    assert names == ["B"]


# --- reorder -----------------------------------------------------------------

def test_reorder_sets_new_order(client, data_dir):
    rid = _add_routine(client)
    a = _add_move(client, rid, name="A")
    b = _add_move(client, rid, name="B")
    c = _add_move(client, rid, name="C")
    _post(client, "/api/movement/move/reorder", {"routine_id": rid, "order": [c, a, b]})
    assert [m["name"] for m in _routine(client)["moves"]] == ["C", "A", "B"]


def test_reorder_with_partial_order_keeps_unnamed_at_end(client, data_dir):
    # Ids not named in `order` keep their place after the named ones (no data loss).
    rid = _add_routine(client)
    a = _add_move(client, rid, name="A")
    b = _add_move(client, rid, name="B")
    c = _add_move(client, rid, name="C")
    _post(client, "/api/movement/move/reorder", {"routine_id": rid, "order": [b]})
    names = [m["name"] for m in _routine(client)["moves"]]
    assert names[0] == "B"
    assert set(names) == {"A", "B", "C"}     # nothing dropped


def test_reorder_unknown_routine_404(client, data_dir):
    r = _post(client, "/api/movement/move/reorder", {"routine_id": "nope", "order": []})
    assert r.status_code == 404
