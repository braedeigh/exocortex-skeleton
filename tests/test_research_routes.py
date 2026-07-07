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


# --- library (read-only view of the research/*.md corpus) --------------------

def test_library_lists_markdown_recursively(client, tmp_path, monkeypatch):
    import store
    monkeypatch.setattr(store, "RESEARCH_DIR", tmp_path)
    (tmp_path / "alpha.md").write_text("# Alpha Title\n\nbody")
    nested = tmp_path / "product-references"
    nested.mkdir()
    (nested / "beta.md").write_text("no heading here")
    (tmp_path / "ignore.txt").write_text("not markdown")

    r = client.get("/api/research/library")
    assert r.status_code == 200
    files = {f["path"]: f for f in r.get_json()["files"]}
    assert set(files) == {"alpha.md", "product-references/beta.md"}
    assert files["alpha.md"]["title"] == "Alpha Title"
    # No leading '# ' heading → title falls back to the file stem.
    assert files["product-references/beta.md"]["title"] == "beta"


def test_library_missing_dir_is_empty_not_error(client, tmp_path, monkeypatch):
    import store
    monkeypatch.setattr(store, "RESEARCH_DIR", tmp_path / "nope")
    r = client.get("/api/research/library")
    assert r.status_code == 200
    assert r.get_json()["files"] == []


def test_library_file_round_trips_content(client, tmp_path, monkeypatch):
    import store
    monkeypatch.setattr(store, "RESEARCH_DIR", tmp_path)
    (tmp_path / "doc.md").write_text("# Doc\n\nhello world")
    r = client.get("/api/research/library/file", query_string={"path": "doc.md"})
    assert r.status_code == 200
    assert r.get_json()["text"] == "# Doc\n\nhello world"


def test_library_file_rejects_traversal(client, tmp_path, monkeypatch):
    import store
    monkeypatch.setattr(store, "RESEARCH_DIR", tmp_path)
    (tmp_path / "doc.md").write_text("# Doc")
    assert client.get("/api/research/library/file",
                      query_string={"path": "../../etc/passwd"}).status_code == 400
    # A real file but not .md is still rejected.
    (tmp_path / "secret.txt").write_text("x")
    assert client.get("/api/research/library/file",
                      query_string={"path": "secret.txt"}).status_code == 400
    assert client.get("/api/research/library/file",
                      query_string={"path": "missing.md"}).status_code == 404


# --- file-unfiled (the filer cricket trigger) --------------------------------

def test_file_unfiled_noop_when_nothing_unfiled(client):
    # An entry that already carries a topic isn't "unfiled".
    _post(client, "/api/research/topic/add", {"name": "T"})
    tid = _read()["topics"][0]["id"]
    _post(client, "/api/research/entry/add", {"text": "filed", "topics": [tid]})
    r = _post(client, "/api/research/file-unfiled", {})
    assert r.status_code == 200
    body = r.get_json()
    assert body["unfiled"] == 0
    assert body["session"] is None


def test_file_unfiled_spawns_session(client, monkeypatch):
    # Stub the tmux session spawn so the test never shells out.
    calls = {}
    from routes.kitchen import shared
    monkeypatch.setattr(shared, "ensure_claude_session",
                        lambda *a, **k: calls.setdefault("spawned", True) or True)
    monkeypatch.setattr(shared, "send_prompt",
                        lambda *a, **k: calls.setdefault("prompted", True))
    _post(client, "/api/research/entry/add", {"text": "unfiled note"})
    r = _post(client, "/api/research/file-unfiled", {})
    assert r.status_code == 200
    body = r.get_json()
    assert body["unfiled"] == 1
    assert body["session"] == "research"
    assert calls.get("spawned") and calls.get("prompted")
