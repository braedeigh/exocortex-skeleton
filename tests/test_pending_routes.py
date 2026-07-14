"""Pending approval gate (routes/pending.py).

Life-todo commits shell out to the add-todo binary; these tests intercept
subprocess.run to assert the command line. The live wire since 2026-07-14:
tags are front ids (fronts.json), and legacy staged payloads that still carry
the pre-fronts theme vocabulary get translated at the gate (move ->
living-space; the life/admin junk-drawer tags -> untagged).
"""
import pytest
from flask import Flask

import store
from routes import pending


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    pending.register(app)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def _approve_life_todo(client, monkeypatch, payload):
    """Stage one life_todo, approve it, and return the binary command line."""
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append([str(c) for c in cmd])

        class Result:
            returncode = 0
            stderr = ""

        return Result()

    monkeypatch.setattr(pending.subprocess, "run", fake_run)
    store.write("pending_changes", {"pending": [
        {"id": "p1", "kind": "life_todo", "payload": payload,
         "summary": "", "created": ""},
    ]})
    res = client.post("/api/pending/approve", json={"id": "p1"})
    assert res.status_code == 200
    assert len(calls) == 1
    return calls[0]


def test_life_todo_passes_front_id_through(client, monkeypatch):
    cmd = _approve_life_todo(client, monkeypatch,
                             {"text": "x", "bucket": "now", "category": "health"})
    assert cmd[cmd.index("--category") + 1] == "health"


def test_life_todo_joins_multiple_fronts_comma_separated(client, monkeypatch):
    cmd = _approve_life_todo(client, monkeypatch,
                             {"text": "x", "fronts": ["connection", "health", "connection"]})
    assert cmd[cmd.index("--category") + 1] == "connection,health"


def test_life_todo_translates_legacy_move_to_living_space(client, monkeypatch):
    cmd = _approve_life_todo(client, monkeypatch,
                             {"text": "x", "category": "move"})
    assert cmd[cmd.index("--category") + 1] == "living-space"


@pytest.mark.parametrize("legacy", ["life", "admin", "", None])
def test_life_todo_junk_drawer_and_missing_tags_go_untagged(client, monkeypatch, legacy):
    payload = {"text": "x"}
    if legacy is not None:
        payload["category"] = legacy
    cmd = _approve_life_todo(client, monkeypatch, payload)
    assert "--category" not in cmd


def test_approved_item_leaves_the_queue(client, monkeypatch):
    _approve_life_todo(client, monkeypatch, {"text": "x", "category": "job"})
    assert store.read("pending_changes", {"pending": []})["pending"] == []
