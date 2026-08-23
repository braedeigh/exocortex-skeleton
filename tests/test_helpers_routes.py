"""routes/helpers.py — the shared door for button-fired Claude jobs and the
GET /api/helpers history behind the Observatory's Helpers room."""
import pytest
from flask import Flask

import store
from routes import helpers, spinoff


@pytest.fixture
def helper_client(data_dir, monkeypatch):
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    launches = []
    monkeypatch.setattr(spinoff.subprocess, "Popen",
                        lambda argv, **kw: launches.append(argv) or object())
    monkeypatch.delenv("EXOCORTEX_CONV_ID", raising=False)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    helpers.register(app)
    client = app.test_client()
    client._launches = launches
    return client


BRIEF = "# Job\n\n## Protocol\n\n1. Do the thing.\n"


def test_mint_helper_stamps_origin_kind_and_title(helper_client):
    payload, status = helpers.mint_helper("recipe", "recipe-1", BRIEF, "Recipe: soup")
    assert status == 200 and payload["kind"] == "recipe"
    entry = store.read("bot_chats/index", {})[payload["conversation_id"]]
    assert entry["origin"] == "helper"
    assert entry["helper"] == "recipe"
    assert entry["title"] == "Recipe: soup"
    assert entry["lane"] == "personal"
    assert (store.SPINOFF_DIR / "recipe-1" / "BRIEF.md").read_text() == BRIEF


def test_rejoin_keeps_the_original_title(helper_client):
    first, _ = helpers.mint_helper("triage", "triage", BRIEF, "Triage")
    again, _ = helpers.mint_helper("triage", "triage", BRIEF, "Triage (again)")
    assert again["conversation_id"] == first["conversation_id"]
    entry = store.read("bot_chats/index", {})[first["conversation_id"]]
    assert entry["title"] == "Triage"


def test_history_lists_helpers_only_archived_included_newest_first(helper_client):
    a, _ = helpers.mint_helper("recipe", "recipe-a", BRIEF, "A")
    b, _ = helpers.mint_helper("receipt", "receipt-b", BRIEF, "B")
    with store.mutate("bot_chats/index", {}) as index:
        index[a["conversation_id"]]["archived"] = "2026-08-22T10:00:00"
        index[a["conversation_id"]]["started"] = "2026-08-01T00:00:00"
        index[b["conversation_id"]]["started"] = "2026-08-02T00:00:00"
        index[b["conversation_id"]]["last_error"] = "claude exited 1"
        index["plain"] = {"title": "her own chat", "last_at": "2026-08-03T00:00:00"}
    body = helper_client.get("/api/helpers").get_json()
    ids = [r["id"] for r in body["runs"]]
    assert ids == [b["conversation_id"], a["conversation_id"]]
    assert body["runs"][0]["label"] == "Receipt parse"
    assert body["runs"][0]["last_error"] == "claude exited 1"
    assert body["runs"][1]["archived"]
    assert body["failed"] == 1 and body["running"] == 0
