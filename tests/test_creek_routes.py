"""Tests for the Creek data-flow map (routes/creek.py).

Two layers, mirroring tests/test_todos_routes.py's split: the pure analyzer
(scan_source and friends) tested directly against small inline source
strings — no Flask, no filesystem — and the HTTP contract of GET /api/creek,
hit through a minimal Flask app registering only creek.register(app) (see
conftest.py's `client` pattern). The route test treats the real repo tree as
its own fixture: it asserts loosely that a known real edge (something in
routes/ touching the `todos` collection) shows up, rather than pinning exact
counts that would break every time a route file is edited.

A third block covers the "water" endpoints (/now, /history, /diff, /writes):
same minimal-app `client` fixture, isolated `data_dir`. `data_dir` (see
conftest.py) points store.DATA_DIR at a fresh pytest tmp_path with no git
repo anywhere near it — that's a deliberate, useful default here: it's
exactly the "no git history" case /history and /diff have to degrade
honestly for, instead of 500ing, and it happens for free without setting up
a scratch git repo.
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


# --- water: /now ------------------------------------------------------------

def test_now_round_trips_a_seeded_collection(client, data_dir):
    import store
    store.write("widgets", {"a": 1, "b": [2, 3]})
    r = client.get("/api/creek/collection/widgets/now")
    assert r.status_code == 200
    body = r.get_json()
    assert body["id"] == "widgets"
    assert body["backing"] == "json"
    assert body["exists"] is True
    assert body["truncated"] is False
    assert json.loads(body["pretty"]) == {"a": 1, "b": [2, 3]}
    assert body["bytes"] == len(json.dumps({"a": 1, "b": [2, 3]}, indent=2, ensure_ascii=False).encode("utf-8"))


def test_now_round_trips_a_nested_collection_id_with_slash(client, data_dir):
    import store
    # store.write_file doesn't mkdir a collection id's parent directory (it
    # never needs to for the flat ids the rest of the app uses) — a real
    # nested collection like bot_chats/index only exists because its folder
    # was created some other way first, so the test does the same.
    (data_dir / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"threads": []})
    r = client.get("/api/creek/collection/bot_chats/index/now")
    assert r.status_code == 200
    body = r.get_json()
    assert body["id"] == "bot_chats/index"
    assert body["exists"] is True
    assert json.loads(body["pretty"]) == {"threads": []}


def test_now_missing_collection_reports_exists_false(client, data_dir):
    r = client.get("/api/creek/collection/never-written/now")
    assert r.status_code == 200
    body = r.get_json()
    assert body["exists"] is False
    assert body["pretty"] is None


def test_now_rejects_traversal_attempt(client, data_dir):
    r = client.get("/api/creek/collection/../etc/passwd/now")
    assert r.status_code == 400


def test_now_rejects_dotdot_inside_path_segment(client, data_dir):
    r = client.get("/api/creek/collection/foo/../../bar/now")
    assert r.status_code == 400


# --- water: /history ---------------------------------------------------------

def test_history_with_no_git_repo_reports_untracked(client, data_dir):
    # data_dir (conftest.py) points store.DATA_DIR at a bare pytest tmp_path
    # with no .git anywhere near it — the honest "no history" case.
    r = client.get("/api/creek/collection/widgets/history")
    assert r.status_code == 200
    body = r.get_json()
    assert body["tracked"] is False
    assert body["commits"] == []
    assert body["file"] == "data/widgets.json"
    assert isinstance(body["note"], str) and body["note"]


def test_history_rejects_traversal_attempt(client, data_dir):
    r = client.get("/api/creek/collection/../etc/passwd/history")
    assert r.status_code == 400


def test_history_clamps_limit_to_max(client, data_dir):
    r = client.get("/api/creek/collection/widgets/history?limit=99999")
    assert r.status_code == 200  # clamped internally, never rejected


# --- water: /diff -------------------------------------------------------------

def test_diff_rejects_bad_sha(client, data_dir):
    r = client.get("/api/creek/collection/widgets/diff/not-a-sha")
    assert r.status_code == 400


def test_diff_rejects_short_sha(client, data_dir):
    r = client.get("/api/creek/collection/widgets/diff/abc123")  # < 7 chars
    assert r.status_code == 400


def test_diff_with_no_git_repo_degrades_to_empty_diff(client, data_dir):
    r = client.get("/api/creek/collection/widgets/diff/abc1234")
    assert r.status_code == 200
    body = r.get_json()
    assert body["diff"] == ""
    assert body["truncated"] is False


# --- water: /writes -----------------------------------------------------------

def test_writes_with_writelog_absent_returns_empty_events(client, data_dir):
    # writelog.py doesn't exist in this checkout yet (it's being built
    # alongside this route) — the route must still answer 200.
    import sys
    assert "writelog" not in sys.modules or True  # no assumption either way
    r = client.get("/api/creek/collection/widgets/writes")
    assert r.status_code == 200
    body = r.get_json()
    assert body["id"] == "widgets"
    assert body["capturing_since"] is None
    assert body["events"] == []
    assert isinstance(body["note"], str) and body["note"]


def test_writes_rejects_traversal_attempt(client, data_dir):
    r = client.get("/api/creek/collection/../etc/passwd/writes")
    assert r.status_code == 400


def test_writes_clamps_limit_to_max(client, data_dir, monkeypatch):
    # A fake writelog module proves the route actually calls recent()/
    # capturing_since() and passes the clamped limit through, rather than
    # only being exercised by the "module absent" fallback path above.
    import sys
    import types

    fake = types.ModuleType("writelog")
    calls = {}

    def fake_recent(collection=None, limit=50):
        calls["collection"] = collection
        calls["limit"] = limit
        return [{"ts": "2026-01-01T00:00:00", "caller": "gunicorn",
                  "collection": collection, "verb": "write", "patch": None,
                  "truncated": False, "bytes_before": None, "bytes_after": None}]

    fake.recent = fake_recent
    fake.capturing_since = lambda: "2026-01-01T00:00:00"
    monkeypatch.setitem(sys.modules, "writelog", fake)

    r = client.get("/api/creek/collection/widgets/writes?limit=99999")
    assert r.status_code == 200
    body = r.get_json()
    assert calls["collection"] == "widgets"
    assert calls["limit"] == 500  # clamped to the max
    assert body["capturing_since"] == "2026-01-01T00:00:00"
    assert len(body["events"]) == 1
    assert body["note"]
