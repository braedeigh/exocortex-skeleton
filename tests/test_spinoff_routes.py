"""routes/spinoff.py — the shared spawn door for /spinoff.

Session-first: opening a spinoff mints (or rejoins) a Reading Room
conversation (routes/reading_room.py) rather than a tmux session. A fresh
mint gets a builder-tool config and its kickoff carried on the entry as a
`draft` AND flagged `autostart` — the Reading Room fires that kickoff
automatically the moment she opens the session (no manual send). Re-invoking
against a slug that already has a live (non-archived) conversation is a
rejoin: the entry is returned untouched, not re-minted or re-drafted.
"""
import json

import pytest
from flask import Flask

import store
from routes import spinoff


@pytest.fixture
def spinoff_client(data_dir, monkeypatch):
    # Mirrors conftest's store-isolation style: data_dir points store.DATA_DIR
    # (and UPLOAD_DIR) at a fresh tmp_path; SPINOFF_DIR is resolved once at
    # import time from the (real) DATA_DIR, so it needs its own monkeypatch
    # to land under the same isolated tree.
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    app = Flask(__name__)
    app.config.update(TESTING=True)
    spinoff.register(app)
    return app.test_client()


def _post(client, slug):
    return client.post("/api/spinoff/open", data=json.dumps({"slug": slug}),
                       content_type="application/json")


def _write_brief(spinoff_dir, slug, text="Do the thing.\n"):
    d = spinoff_dir / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "BRIEF.md").write_text(text)
    return d / "BRIEF.md"


def _index():
    return store.read("bot_chats/index", {})


def test_bad_slug_400(spinoff_client):
    r = _post(spinoff_client, "NOT-A-SLUG")
    assert r.status_code == 400
    assert r.get_json() == {"error": "bad slug"}
    assert _index() == {}


def test_missing_brief_400_and_no_index_write(spinoff_client):
    r = _post(spinoff_client, "some-slug")
    assert r.status_code == 400
    brief = store.SPINOFF_DIR / "some-slug" / "BRIEF.md"
    assert r.get_json() == {"error": f"no brief at {brief}"}
    assert _index() == {}


def test_valid_slug_mints_an_autostarting_builder_session(spinoff_client):
    brief = _write_brief(store.SPINOFF_DIR, "cool-idea")
    r = _post(spinoff_client, "cool-idea")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["newly_spawned"] is True
    assert body["staged"] is True
    assert body["autostart"] is True
    assert body["brief"] == str(brief)
    conv_id = body["conversation_id"]

    index = _index()
    entry = index[conv_id]
    assert entry["spinoff_slug"] == "cool-idea"
    assert str(brief) in entry["draft"]
    # The kickoff auto-fires on open (Reading Room reads meta.autostart) rather
    # than sitting in the compose box waiting for a manual send.
    assert entry["autostart"] is True
    assert entry["allowed_tools"] == list(spinoff._BUILDER_TOOLS)
    assert entry["journal"] is False
    assert entry["cwd"]
    assert entry["bot"] == "keeper"
    assert entry["title"] == "spin: cool-idea"


def test_second_call_rejoins_without_touching_the_entry(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "twice")
    first = _post(spinoff_client, "twice").get_json()
    conv_id = first["conversation_id"]
    before = _index()[conv_id]

    r = _post(spinoff_client, "twice")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["newly_spawned"] is False
    assert body["conversation_id"] == conv_id

    after = _index()
    # exactly one entry for this slug, and it's byte-for-byte the same as
    # before — a rejoin must not re-write the draft (or anything else).
    assert list(after.keys()) == [conv_id]
    assert after[conv_id] == before


def test_archived_spinoff_gets_a_fresh_conversation(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "reopen-me")
    first = _post(spinoff_client, "reopen-me").get_json()
    old_id = first["conversation_id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[old_id]["archived"] = "2026-01-01T00:00:00"

    r = _post(spinoff_client, "reopen-me")
    assert r.status_code == 200
    body = r.get_json()
    assert body["newly_spawned"] is True
    new_id = body["conversation_id"]
    assert new_id != old_id

    index = _index()
    assert index[old_id]["archived"]
    assert index[new_id]["spinoff_slug"] == "reopen-me"
    assert not index[new_id].get("archived")
