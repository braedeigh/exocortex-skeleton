"""Behavioral tests for the Research API (routes/research.py).

Model: entries are a flat pool; topics are tags over them, not containers.
These pin down: slug/time-based id generation (with collision suffixes),
that removing a topic strips the tag but keeps the entry, question default
status, and per-kind verdict/status validation on entry/edit.
"""
import datetime as real_datetime
import json

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the research routes."""
    from flask import Flask
    from routes import research
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research.register(app)
    return app.test_client()


class _FrozenDatetime(real_datetime.datetime):
    """A fixed clock so same-minute id-collision tests aren't flaky."""
    @classmethod
    def now(cls, tz=None):
        return real_datetime.datetime(2026, 7, 6, 21, 51)


@pytest.fixture
def frozen_time(monkeypatch):
    from routes import research
    monkeypatch.setattr(research, "datetime", _FrozenDatetime)


def _read():
    import store
    return store.read("research.json", {"topics": [], "entries": []})


# --- topics ------------------------------------------------------------------

def test_topic_add_creates_slug_id(client):
    r = _post(client, "/api/research/topic/add", {"name": "Wearables signal taxonomy"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    topics = body["topics"]
    assert len(topics) == 1
    assert topics[0]["id"] == "wearables-signal-taxonomy"
    assert topics[0]["status"] == "active"
    assert "created" in topics[0]


def test_topic_add_duplicate_name_gets_distinct_slug(client):
    _post(client, "/api/research/topic/add", {"name": "Sleep"})
    r = _post(client, "/api/research/topic/add", {"name": "Sleep"})
    ids = [t["id"] for t in r.get_json()["topics"]]
    assert ids == ["sleep", "sleep-2"]


def test_topic_add_empty_name_400(client):
    r = _post(client, "/api/research/topic/add", {"name": "   "})
    assert r.status_code == 400
    assert _read()["topics"] == []


def test_topic_remove_strips_tag_but_keeps_entries(client):
    _post(client, "/api/research/topic/add", {"name": "Sleep"})
    _post(client, "/api/research/entry/add", {"text": "melatonin timing", "topics": ["sleep"]})
    r = _post(client, "/api/research/topic/remove", {"id": "sleep"})
    body = r.get_json()
    assert body["topics"] == []
    assert len(body["entries"]) == 1
    assert body["entries"][0]["topics"] == []
    assert body["entries"][0]["text"] == "melatonin timing"


# --- entry add -----------------------------------------------------------------

def test_entry_add_question_gets_status_open(client):
    r = _post(client, "/api/research/entry/add", {"text": "Does X cause Y?", "kind": "question"})
    entry = r.get_json()["entries"][0]
    assert entry["kind"] == "question"
    assert entry["status"] == "open"


def test_entry_add_default_kind_is_note(client):
    r = _post(client, "/api/research/entry/add", {"text": "just a note"})
    entry = r.get_json()["entries"][0]
    assert entry["kind"] == "note"
    assert entry["status"] == ""


def test_entry_add_empty_text_400(client):
    r = _post(client, "/api/research/entry/add", {"text": "   "})
    assert r.status_code == 400
    assert _read()["entries"] == []


def test_entry_add_bad_kind_400(client):
    r = _post(client, "/api/research/entry/add", {"text": "x", "kind": "opinion"})
    assert r.status_code == 400
    assert _read()["entries"] == []


def test_entry_ids_collide_in_same_minute_get_suffix(client, frozen_time):
    r1 = _post(client, "/api/research/entry/add", {"text": "first"})
    r2 = _post(client, "/api/research/entry/add", {"text": "second"})
    id1 = r1.get_json()["entries"][0]["id"]
    id2 = r2.get_json()["entries"][1]["id"]
    assert id1 == "2026-07-06.2151"
    assert id2 == "2026-07-06.2151-2"


# --- entry edit ------------------------------------------------------------------

def test_entry_edit_verdict_validated_per_kind(client):
    r = _post(client, "/api/research/entry/add", {"text": "claim text", "kind": "claim"})
    cid = r.get_json()["entries"][0]["id"]
    ok = _post(client, "/api/research/entry/edit", {"id": cid, "verdict": "real"})
    assert ok.status_code == 200
    assert ok.get_json()["entries"][0]["verdict"] == "real"

    r2 = _post(client, "/api/research/entry/add", {"text": "a source", "kind": "source", "url": "http://x"})
    sid = r2.get_json()["entries"][1]["id"]
    bad = _post(client, "/api/research/entry/edit", {"id": sid, "verdict": "real"})
    assert bad.status_code == 400
    good = _post(client, "/api/research/entry/edit", {"id": sid, "verdict": "verified"})
    assert good.status_code == 200
    entries = {e["id"]: e for e in good.get_json()["entries"]}
    assert entries[sid]["verdict"] == "verified"
    assert entries[cid]["verdict"] == "real"   # untouched by the other edit


def test_entry_edit_status_toggle(client):
    r = _post(client, "/api/research/entry/add", {"text": "q?", "kind": "question"})
    qid = r.get_json()["entries"][0]["id"]
    r2 = _post(client, "/api/research/entry/edit", {"id": qid, "status": "answered"})
    assert r2.status_code == 200
    assert r2.get_json()["entries"][0]["status"] == "answered"
    # bad status for a question is rejected
    bad = _post(client, "/api/research/entry/edit", {"id": qid, "status": "nope"})
    assert bad.status_code == 400


def test_entry_edit_not_found_404(client):
    r = _post(client, "/api/research/entry/edit", {"id": "missing", "text": "x"})
    assert r.status_code == 404


# --- entry remove ------------------------------------------------------------------

def test_entry_remove_removes_exactly_by_id(client):
    _post(client, "/api/research/entry/add", {"text": "same text"})
    _post(client, "/api/research/entry/add", {"text": "same text"})
    data = _read()
    id1, id2 = [e["id"] for e in data["entries"]]
    assert id1 != id2   # two entries, same text, independent ids

    r = _post(client, "/api/research/entry/remove", {"id": id1})
    remaining = r.get_json()["entries"]
    assert len(remaining) == 1
    assert remaining[0]["id"] == id2
    assert remaining[0]["text"] == "same text"


def test_entry_edit_rejected_request_applies_nothing(client):
    """A 400 must not half-apply: good text + bad verdict changes nothing."""
    _post(client, "/api/research/entry/add", {"text": "original", "kind": "claim"})
    eid = _read()["entries"][0]["id"]
    r = _post(client, "/api/research/entry/edit",
              {"id": eid, "text": "edited", "verdict": "bogus"})
    assert r.status_code == 400
    entry = _read()["entries"][0]
    assert entry["text"] == "original"
    assert entry["verdict"] == ""
