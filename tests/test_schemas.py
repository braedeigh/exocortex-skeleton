"""Tests for schema validation at the write seam (schemas/ + its two hooks in
store.py: write()'s first line and mutate()'s SQL branch).

Mirrors test_store.py's "isolated data, always" rule: every test here touches
the store (directly or through a route), so every test depends on `data_dir`
(directly or via the `seed`/`client` fixtures from conftest.py).
"""
import json

import pytest

import schemas
import store


# --- per-collection valid / invalid --------------------------------------

VALID = {
    "todos": {"now": {"items": [{"text": "water the plants"}]}},
    "habits_log": {"2026-07-18": {"morning|Water upon waking": True}},
    "expenses": {"items": [{"id": "1", "date": "2026-07-18", "amount": 12.5}]},
    "reminders": {"reminders": [{"label": "Sheets", "shape": "circle",
                                  "mode": "log", "schedule": "interval"}]},
    "dev_notes": {"tabs": {"today": [{"id": "1", "text": "fix the thing"}]}},
    "buy_list": {"items": [{"name": "Shikibuton"}]},
    "profile": {"owner_name": "Rowan", "owner_email": "owner@example.com", "app_name": "Exocortex"},
}

INVALID = {
    "todos": {"now": {"items": [{"done": True}]}},  # missing required "text"
    "habits_log": {"2026-07-18": {"morning|Water upon waking": "yes"}},  # not const true
    "expenses": {"items": [{"id": "1", "date": "2026-07-18"}]},  # missing "amount"
    "reminders": {"reminders": [{"label": "Sheets", "shape": "hexagon"}]},  # bad enum
    "dev_notes": {"tabs": {"today": [{"id": "1"}]}},  # missing required "text"
    "buy_list": {"items": [{"priority": "high"}]},  # missing required "name"
    "profile": {"owner_email": "not-an-email"},  # fails the "^$|^[^@\\s]+@[^@\\s]+$" pattern
}


@pytest.mark.parametrize("name", sorted(VALID))
def test_valid_shape_is_accepted(data_dir, name):
    store.write(name, VALID[name])
    assert store.read(name) == VALID[name]


@pytest.mark.parametrize("name", sorted(INVALID))
def test_invalid_shape_is_rejected(data_dir, name):
    with pytest.raises(schemas.SchemaError):
        store.write(name, INVALID[name])


# --- {} and seeded defaults pass ------------------------------------------

# Notes are rows (notestore.py), not a blob: an empty document reads back as
# the notes document with no pages, which is how "no notes" is spelled there.
EMPTY_READS_BACK_AS = {"dev_notes": {"tabs": {}}}


@pytest.mark.parametrize("name", sorted(VALID))
def test_empty_dict_is_accepted(data_dir, name):
    store.write(name, {})
    assert store.read(name) == EMPTY_READS_BACK_AS.get(name, {})


def test_seeded_todos_default_is_accepted(seed):
    """conftest's seed() fixture writes the default empty-bucket shape used by
    every todos route test — it must never trip the schema."""
    seed()
    assert store.read("todos")["now"]["items"] == []


# --- kill switch -----------------------------------------------------------

def test_kill_switch_lets_invalid_data_through(monkeypatch, data_dir):
    monkeypatch.setenv("EXOCORTEX_SCHEMA_OFF", "1")
    store.write("todos", INVALID["todos"])  # would normally raise
    assert store.read("todos") == INVALID["todos"]


def test_kill_switch_does_not_affect_iter_violations(monkeypatch, data_dir):
    """iter_violations() is for the rollout checker script and must see the
    real state of the data regardless of the runtime kill switch."""
    monkeypatch.setenv("EXOCORTEX_SCHEMA_OFF", "1")
    assert schemas.iter_violations("todos", INVALID["todos"]) != []


# --- unknown-collection passthrough ----------------------------------------

def test_unknown_collection_skips_validation(data_dir):
    """A collection with no schemas/*.json file is not validated at all --
    same "thing"/"log" ad-hoc collections test_store.py already exercises."""
    store.write("something_untracked", ["not", "even", "an", "object"])
    assert store.read("something_untracked") == ["not", "even", "an", "object"]


# --- error message shape ----------------------------------------------------

def test_error_message_contains_json_path(data_dir):
    with pytest.raises(schemas.SchemaError) as exc_info:
        store.write("todos", {"now": {"items": [{"done": True}]}})
    err = exc_info.value
    assert err.collection == "todos"
    assert err.path == "$.now.items[0]"
    assert "$.now.items[0]" in str(err)


# --- mutate() SQL branch: rollback leaves BOTH the DB and the mirror alone --

def test_mutate_sql_rollback_leaves_db_and_mirror_untouched(data_dir):
    import sqlstore

    good = {"items": [{"id": "1", "date": "2026-07-18", "amount": 12.5}]}
    store.write("expenses", good)  # SQL-backed; commits + exports the mirror
    mirror_path = data_dir / "expenses.json"
    mirror_before = mirror_path.read_text()
    db_before = sqlstore.get("expenses")

    with pytest.raises(schemas.SchemaError):
        with store.mutate("expenses", {"items": []}) as data:
            data["items"].append({"id": "2"})  # missing required "date"/"amount"

    assert sqlstore.get("expenses") == db_before
    assert mirror_path.read_text() == mirror_before


# --- reminders route round-trip (catches enum drift) ------------------------

@pytest.fixture
def reminders_client(data_dir):
    """Minimal app exposing only the reminders routes, same pattern as
    conftest.py's `client` fixture for todos/places."""
    from flask import Flask
    from routes import reminders
    app = Flask(__name__)
    app.config.update(TESTING=True)
    reminders.register(app)
    return app.test_client()


def test_reminders_save_round_trip_passes_schema(reminders_client):
    """The route's own sanitizing (VALID_MODES/VALID_SHAPES/VALID_TIMES in
    routes/reminders.py) must keep producing documents our derived enums
    still accept -- this is what would catch enum drift between the two."""
    res = reminders_client.post(
        "/api/reminders/save",
        data=json.dumps({"reminders": [{
            "label": "Sheets", "shape": "triangle", "mode": "countdown",
            "schedule": "weekly", "weekdays": [1, 3], "times": ["morning", "evening"],
        }]}),
        content_type="application/json",
    )
    assert res.status_code == 200
    stored = store.read("reminders.json", {"reminders": []})
    assert schemas.iter_violations("reminders", stored) == []


# --- route-level 400 with install_error_handler -----------------------------

def test_route_returns_400_on_schema_violation(monkeypatch, data_dir):
    """A minimal app with schemas.install_error_handler applied turns a
    SchemaError raised deep in store.mutate()'s write-back into a clean 400,
    same as server.py wires it at startup."""
    from flask import Flask
    from routes import todos

    # Get a malformed item (missing required "text") into the store without
    # going through the route layer -- flip the kill switch just for the seed.
    monkeypatch.setenv("EXOCORTEX_SCHEMA_OFF", "1")
    store.write("todos", {"now": {"items": [{"id": "a", "done": False}]}})
    monkeypatch.delenv("EXOCORTEX_SCHEMA_OFF", raising=False)

    app = Flask(__name__)
    app.config.update(TESTING=True)
    todos.register(app)
    schemas.install_error_handler(app)
    client = app.test_client()

    res = client.post("/api/todos/toggle", data=json.dumps({"id": "a"}),
                       content_type="application/json")
    assert res.status_code == 400
    body = res.get_json()
    assert body["collection"] == "todos"
    assert "text" in body["error"]
