"""Tests for the Creek data-flow map (routes/creek.py).

Two layers, mirroring tests/test_todos_routes.py's split: the pure analyzer
(scan_source and friends) tested directly against small inline source
strings — no Flask, no filesystem — and the HTTP contract of GET /api/creek,
hit through a minimal Flask app registering only creek.register(app) (see
conftest.py's `client` pattern). The route test treats the real repo tree as
its own fixture: it asserts loosely that a known real edge (something in
routes/ touching the `todos` collection) shows up, rather than pinning exact
counts that would break every time a route file is edited.
"""
import json

import pytest

from routes import creek


# --- the pure analyzer ---------------------------------------------------------

def test_scan_source_finds_literal_call():
    src = 'import store\n\ndef f():\n    store.read("todos", {})\n'
    calls, unresolved = creek.scan_source(src, "routes/example.py")
    assert unresolved == []
    assert calls == [{"line": 4, "verb": "read", "collection": "todos", "snippet": 'store.read("todos", {})'}]


def test_scan_source_normalizes_json_suffix():
    src = 'store.write("todos.json", data)\n'
    calls, _ = creek.scan_source(src, "routes/example.py")
    assert calls[0]["collection"] == "todos"


def test_scan_source_merges_json_and_bare_spellings():
    src = 'store.read("todos.json", {})\nstore.write("todos", {})\n'
    calls, _ = creek.scan_source(src, "routes/example.py")
    assert {c["collection"] for c in calls} == {"todos"}


def test_scan_source_resolves_same_file_uppercase_constant():
    src = (
        'PENDING_FILE = "pending_changes"\n'
        '\n'
        'def f():\n'
        '    store.mutate(PENDING_FILE, {})\n'
    )
    calls, unresolved = creek.scan_source(src, "routes/pending.py")
    assert unresolved == []
    assert calls == [{
        "line": 4, "verb": "mutate", "collection": "pending_changes",
        "snippet": "store.mutate(PENDING_FILE, {})",
    }]


def test_scan_source_emits_unresolved_for_dynamic_arg():
    src = (
        'def f(name):\n'
        '    store.read(name, {})\n'
    )
    calls, unresolved = creek.scan_source(src, "routes/example.py")
    assert calls == []
    assert unresolved == [{"path": "routes/example.py", "line": 2, "expr": "name"}]


def test_scan_source_emits_unresolved_for_unbound_uppercase_constant():
    # The constant is never assigned in THIS file (e.g. imported from
    # elsewhere) — same-file resolution can't reach it, so it's unresolved
    # rather than guessed at.
    src = 'from other import OTHER_FILE\n\nstore.write(OTHER_FILE, {})\n'
    calls, unresolved = creek.scan_source(src, "routes/example.py")
    assert calls == []
    assert unresolved == [{"path": "routes/example.py", "line": 3, "expr": "OTHER_FILE"}]


def test_normalize_collection_matches_store_key_behavior():
    import store
    for name in ("todos", "todos.json", "feature_usage.json"):
        assert creek.normalize_collection(name) == store._key(name)


# --- telemetry aggregation ------------------------------------------------------

def test_aggregate_telemetry_sums_window_and_normalizes_names():
    from datetime import date
    feature_usage = {"days": {
        "2026-08-19": {"store": {"gunicorn": {"todos": {"reads": 3, "writes": 1}}}},
        "2026-08-20": {"store": {"gunicorn": {"todos.json": {"reads": 2, "writes": 0}}}},
        "2026-08-01": {"store": {"gunicorn": {"todos": {"reads": 99, "writes": 99}}}},  # outside window
    }}
    totals = creek.aggregate_telemetry(feature_usage, 2, today=date(2026, 8, 20))
    assert totals["todos"]["reads"] == 5
    assert totals["todos"]["writes"] == 1
    assert totals["todos"]["callers"]["gunicorn"] == {"reads": 5, "writes": 1}


# --- the HTTP contract -----------------------------------------------------------

@pytest.fixture
def client(data_dir):
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    creek.register(app)
    return app.test_client()


def test_creek_returns_200_with_contract_keys(client):
    r = client.get("/api/creek")
    assert r.status_code == 200
    body = r.get_json()
    assert set(body.keys()) == {"generated", "days", "collections", "files", "unresolved"}
    assert body["days"] == 14
    assert isinstance(body["collections"], list)
    assert isinstance(body["files"], list)
    assert isinstance(body["unresolved"], list)


def test_creek_respects_days_query_param(client):
    r = client.get("/api/creek?days=3")
    assert r.get_json()["days"] == 3


def test_creek_rejects_bad_days(client):
    assert client.get("/api/creek?days=0").status_code == 400
    assert client.get("/api/creek?days=nope").status_code == 400


def test_creek_finds_a_known_real_edge_touching_todos(client):
    # The repo is the fixture: routes/pending.py, routes/fronts.py, and
    # others really do call store.mutate("todos", ...) / store.read("todos",
    # ...). Assert loosely — that SOME routes/ file shows up touching the
    # `todos` collection — rather than pinning an exact file or line that
    # would break the moment someone edits an unrelated route.
    body = client.get("/api/creek").get_json()
    todos_collection = next((c for c in body["collections"] if c["id"] == "todos"), None)
    assert todos_collection is not None
    assert todos_collection["backing"] == "json"   # todos is deliberately NOT SQL-backed (see store.py)

    touching_files = [f for f in body["files"]
                       if f["area"] == "routes"
                       and any(c["collection"] == "todos" for c in f["calls"])]
    assert touching_files, "expected at least one routes/*.py file to show a todos call"


def test_creek_collection_ids_are_normalized_no_duplicate_json_variant(client):
    body = client.get("/api/creek").get_json()
    ids = [c["id"] for c in body["collections"]]
    assert len(ids) == len(set(ids))
    assert all(not cid.endswith(".json") for cid in ids)
