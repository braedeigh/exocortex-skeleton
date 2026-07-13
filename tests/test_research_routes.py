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


def test_topic_add_with_fronts_persists(client):
    r = _post(client, "/api/research/topic/add", {"name": "Sleep", "fronts": ["health"]})
    assert r.status_code == 200
    topics = r.get_json()["topics"]
    assert topics[0]["fronts"] == ["health"]


def test_topic_add_without_fronts_defaults_empty_list(client):
    r = _post(client, "/api/research/topic/add", {"name": "Sleep"})
    assert r.status_code == 200
    assert r.get_json()["topics"][0]["fronts"] == []


def test_topic_edit_fronts_persists(client):
    _post(client, "/api/research/topic/add", {"name": "Sleep"})
    tid = _read()["topics"][0]["id"]
    r = _post(client, "/api/research/topic/edit", {"id": tid, "fronts": ["health", "hobbies"]})
    assert r.status_code == 200
    topic = r.get_json()["topics"][0]
    assert topic["fronts"] == ["health", "hobbies"]
    assert _read()["topics"][0]["fronts"] == ["health", "hobbies"]


def test_topic_edit_fronts_must_be_a_list(client):
    _post(client, "/api/research/topic/add", {"name": "Sleep"})
    tid = _read()["topics"][0]["id"]
    r = _post(client, "/api/research/topic/edit", {"id": tid, "fronts": "health"})
    assert r.status_code == 400
    assert _read()["topics"][0]["fronts"] == []


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


def test_library_excludes_edge_dir_and_lists_it_separately(client, tmp_path, monkeypatch):
    """edge/<topic-id>.md notes (the distiller's output) don't show up in the
    main `files` list — they're returned separately under `edge` so the UI
    can pin them per topic thread instead."""
    import store
    monkeypatch.setattr(store, "RESEARCH_DIR", tmp_path)
    (tmp_path / "alpha.md").write_text("# Alpha Title\n\nbody")
    edge_dir = tmp_path / "edge"
    edge_dir.mkdir()
    (edge_dir / "hair-care.md").write_text("# Hair Care — edge of knowledge\n\n*As of 2026-07-07*")

    r = client.get("/api/research/library")
    assert r.status_code == 200
    body = r.get_json()
    files = {f["path"]: f for f in body["files"]}
    assert set(files) == {"alpha.md"}   # the edge note is NOT in the main list

    edge = body["edge"]
    assert len(edge) == 1
    assert edge[0]["file"] == "edge/hair-care.md"
    assert edge[0]["title"] == "Hair Care — edge of knowledge"
    assert "mtime" in edge[0]


def test_library_missing_dir_is_empty_not_error(client, tmp_path, monkeypatch):
    import store
    monkeypatch.setattr(store, "RESEARCH_DIR", tmp_path / "nope")
    r = client.get("/api/research/library")
    assert r.status_code == 200
    assert r.get_json()["files"] == []
    assert r.get_json()["edge"] == []


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


# --- entry flag / review (LLM-reply lifecycle) --------------------------------

def test_flag_sets_and_clears(client):
    r = _post(client, "/api/research/entry/add", {"text": "note"})
    eid = r.get_json()["entries"][0]["id"]

    on = _post(client, "/api/research/entry/flag", {"id": eid, "flagged": True})
    assert on.status_code == 200
    assert on.get_json()["entries"][0]["flagged"] is True

    off = _post(client, "/api/research/entry/flag", {"id": eid, "flagged": False})
    assert off.status_code == 200
    assert off.get_json()["entries"][0]["flagged"] is False


def test_flag_not_found_404(client):
    r = _post(client, "/api/research/entry/flag", {"id": "missing", "flagged": True})
    assert r.status_code == 404


def test_flag_llm_entry_rejected(client):
    with_llm = {"topics": [], "entries": [
        {"id": "2026-07-01.0900", "kind": "note", "text": "reply", "topics": [],
         "url": "", "verdict": "", "status": "", "reply_to": None,
         "created": "2026-07-01 09:00", "author": "llm", "reviewed": False},
    ]}
    import store
    store.write("research.json", with_llm)
    r = _post(client, "/api/research/entry/flag", {"id": "2026-07-01.0900", "flagged": True})
    assert r.status_code == 400
    assert r.get_json()["error"] == "can't flag an LLM output"
    assert "flagged" not in _read()["entries"][0]


def test_review_flips_on_llm_entry(client):
    with_llm = {"topics": [], "entries": [
        {"id": "2026-07-01.0900", "kind": "note", "text": "reply", "topics": [],
         "url": "", "verdict": "", "status": "", "reply_to": None,
         "created": "2026-07-01 09:00", "author": "llm", "reviewed": False},
    ]}
    import store
    store.write("research.json", with_llm)
    r = _post(client, "/api/research/entry/review", {"id": "2026-07-01.0900", "reviewed": True})
    assert r.status_code == 200
    assert r.get_json()["entries"][0]["reviewed"] is True


def test_review_on_human_entry_rejected(client):
    r = _post(client, "/api/research/entry/add", {"text": "her own note"})
    eid = r.get_json()["entries"][0]["id"]
    bad = _post(client, "/api/research/entry/review", {"id": eid, "reviewed": True})
    assert bad.status_code == 400
    assert bad.get_json()["error"] == "only LLM outputs carry review"


def test_blob_includes_sessions_key(client):
    r = _post(client, "/api/research/entry/add", {"text": "x"})
    assert "sessions" in r.get_json()
    assert r.get_json()["sessions"] == []


# --- send (the research-runner cricket trigger) -------------------------------

@pytest.fixture
def stub_runner(monkeypatch):
    """Stub the tmux session spawn so tests never shell out; records prompts."""
    calls = {"prompts": []}
    from routes.kitchen import shared
    monkeypatch.setattr(shared, "ensure_claude_session",
                        lambda *a, **k: calls.setdefault("spawned", True) or True)
    monkeypatch.setattr(shared, "send_prompt",
                        lambda session, text, *a, **k: calls["prompts"].append((session, text)))
    return calls


def test_send_with_explicit_ids_flags_and_creates_running_session(client, stub_runner):
    r1 = _post(client, "/api/research/entry/add", {"text": "one"})
    r2 = _post(client, "/api/research/entry/add", {"text": "two"})
    id1 = r1.get_json()["entries"][0]["id"]
    id2 = r2.get_json()["entries"][1]["id"]

    r = _post(client, "/api/research/send", {"ids": [id1, id2]})
    assert r.status_code == 200
    body = r.get_json()
    assert body["sent"] == 2
    sid = body["session"]
    assert sid

    data = _read()
    entries = {e["id"]: e for e in data["entries"]}
    assert entries[id1]["flagged"] is True
    assert entries[id2]["flagged"] is True

    sessions = data["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["id"] == sid
    assert set(sessions[0]["entry_ids"]) == {id1, id2}
    assert sessions[0]["status"] == "running"
    assert sessions[0]["report"] == ""

    assert stub_runner.get("spawned")
    assert len(stub_runner["prompts"]) == 1
    session_name, prompt = stub_runner["prompts"][0]
    assert session_name == "research-runner"
    assert sid in prompt


def test_send_explicit_ids_missing_entry_404_no_mutation(client, stub_runner):
    _post(client, "/api/research/entry/add", {"text": "one"})
    r = _post(client, "/api/research/send", {"ids": ["missing"]})
    assert r.status_code == 404
    assert _read().get("sessions", []) == []
    assert not stub_runner.get("spawned")


def test_send_explicit_ids_rejects_llm_entry(client, stub_runner):
    with_llm = {"topics": [], "entries": [
        {"id": "2026-07-01.0900", "kind": "note", "text": "reply", "topics": [],
         "url": "", "verdict": "", "status": "", "reply_to": None,
         "created": "2026-07-01 09:00", "author": "llm", "reviewed": False},
    ]}
    import store
    store.write("research.json", with_llm)
    r = _post(client, "/api/research/send", {"ids": ["2026-07-01.0900"]})
    assert r.status_code == 400
    assert _read().get("sessions", []) == []
    assert not stub_runner.get("spawned")


def test_send_with_no_body_picks_up_all_flagged(client, stub_runner):
    r1 = _post(client, "/api/research/entry/add", {"text": "flagged one"})
    r2 = _post(client, "/api/research/entry/add", {"text": "not flagged"})
    id1 = r1.get_json()["entries"][0]["id"]
    id2 = r2.get_json()["entries"][1]["id"]
    _post(client, "/api/research/entry/flag", {"id": id1, "flagged": True})

    r = _post(client, "/api/research/send", {})
    assert r.status_code == 200
    body = r.get_json()
    assert body["sent"] == 1
    assert body["session"]

    sessions = _read()["sessions"]
    assert sessions[0]["entry_ids"] == [id1]
    assert id2 not in sessions[0]["entry_ids"]


def test_send_with_nothing_flagged_sends_zero_and_no_session(client, stub_runner):
    _post(client, "/api/research/entry/add", {"text": "unflagged"})
    r = _post(client, "/api/research/send", {})
    assert r.status_code == 200
    body = r.get_json()
    assert body == {"ok": True, "sent": 0, "session": None}
    assert _read().get("sessions", []) == []
    assert not stub_runner.get("spawned")


# --- question/deep (the single-question deep-research trigger) ---------------

@pytest.fixture
def stub_deep(monkeypatch):
    """Stub the tmux session spawn so tests never shell out; records prompts."""
    calls = {"prompts": []}
    from routes.kitchen import shared
    monkeypatch.setattr(shared, "ensure_claude_session",
                        lambda *a, **k: calls.setdefault("spawned", True) or True)
    monkeypatch.setattr(shared, "send_prompt",
                        lambda session, text, *a, **k: calls["prompts"].append((session, text)))
    return calls


def test_deep_research_open_question_flags_and_creates_running_session(client, stub_deep):
    r = _post(client, "/api/research/entry/add", {"text": "Does X cause Y?", "kind": "question"})
    qid = r.get_json()["entries"][0]["id"]

    resp = _post(client, "/api/research/question/deep", {"id": qid})
    assert resp.status_code == 200
    body = resp.get_json()
    sid = body["session"]
    assert sid

    data = _read()
    entry = data["entries"][0]
    assert entry["id"] == qid
    assert entry["flagged"] is True

    sessions = data["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["id"] == sid
    assert sessions[0]["entry_ids"] == [qid]
    assert sessions[0]["status"] == "running"
    assert sessions[0]["mode"] == "deep"

    assert stub_deep.get("spawned")
    session_name, prompt = stub_deep["prompts"][0]
    assert session_name == "research-deep"
    assert sid in prompt


def test_deep_research_rejects_non_question(client, stub_deep):
    r = _post(client, "/api/research/entry/add", {"text": "just a note"})
    nid = r.get_json()["entries"][0]["id"]
    resp = _post(client, "/api/research/question/deep", {"id": nid})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "only questions can be deep-researched"


def test_deep_research_rejects_llm_entry(client, stub_deep):
    with_llm = {"topics": [], "entries": [
        {"id": "2026-07-01.0900", "kind": "question", "text": "reply", "topics": [],
         "url": "", "verdict": "", "status": "open", "reply_to": None,
         "created": "2026-07-01 09:00", "author": "llm", "reviewed": False},
    ]}
    import store
    store.write("research.json", with_llm)
    resp = _post(client, "/api/research/question/deep", {"id": "2026-07-01.0900"})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "can't research an LLM output"


def test_deep_research_rejects_answered_question(client, stub_deep):
    r = _post(client, "/api/research/entry/add", {"text": "Does X cause Y?", "kind": "question"})
    qid = r.get_json()["entries"][0]["id"]
    _post(client, "/api/research/entry/edit", {"id": qid, "status": "answered"})
    resp = _post(client, "/api/research/question/deep", {"id": qid})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "question is not open"


def test_deep_research_missing_id_404(client, stub_deep):
    resp = _post(client, "/api/research/question/deep", {"id": "missing"})
    assert resp.status_code == 404
    assert not stub_deep.get("spawned")


def test_deep_research_rejected_request_leaves_store_unmutated(client, stub_deep):
    """A 400 must not half-apply: the entry stays unflagged and no session appears."""
    r = _post(client, "/api/research/entry/add", {"text": "just a note"})
    nid = r.get_json()["entries"][0]["id"]
    resp = _post(client, "/api/research/question/deep", {"id": nid})
    assert resp.status_code == 400

    data = _read()
    entry = data["entries"][0]
    assert entry["id"] == nid
    assert "flagged" not in entry
    assert data.get("sessions", []) == []
    assert not stub_deep.get("spawned")


# --- topic/distill (per-topic edge-of-knowledge note trigger) ----------------

@pytest.fixture
def stub_kick(monkeypatch):
    """Stub _kick_dispatcher so distill tests never shell out; records calls."""
    from routes import research as research_mod
    calls = []
    monkeypatch.setattr(research_mod, "_kick_dispatcher", lambda: calls.append(True))
    return calls


def test_distill_unknown_topic_404(client, stub_kick):
    r = _post(client, "/api/research/topic/distill", {"topic": "no-such-topic"})
    assert r.status_code == 404
    assert _read().get("sessions", []) == []
    assert not stub_kick


def test_distill_queues_worker_session_and_kicks_dispatcher(client, stub_kick):
    _post(client, "/api/research/topic/add", {"name": "Hair Care"})
    tid = _read()["topics"][0]["id"]

    r = _post(client, "/api/research/topic/distill", {"topic": tid})
    assert r.status_code == 200
    body = r.get_json()
    session = body["session"]
    assert session["entry_ids"] == []
    assert session["topics"] == [tid]
    assert session["status"] == "queued"
    assert session["mode"] == "distill"
    assert session["worker"] is True
    assert "id" in session and session["id"]

    data = _read()
    sessions = data["sessions"]
    assert len(sessions) == 1
    assert sessions[0] == session

    # the dispatcher is kicked so the queue drains without waiting for cron
    assert stub_kick == [True]


def test_distill_rejects_second_session_for_same_topic_while_active(client, stub_kick):
    _post(client, "/api/research/topic/add", {"name": "Hair Care"})
    tid = _read()["topics"][0]["id"]
    first = _post(client, "/api/research/topic/distill", {"topic": tid})
    assert first.status_code == 200

    r = _post(client, "/api/research/topic/distill", {"topic": tid})
    assert r.status_code == 409
    assert "already" in r.get_json()["error"]

    # still only the one session — the 409 didn't create a second
    assert len(_read()["sessions"]) == 1


def test_distill_allows_new_session_once_prior_one_is_done(client, stub_kick):
    _post(client, "/api/research/topic/add", {"name": "Hair Care"})
    tid = _read()["topics"][0]["id"]
    first = _post(client, "/api/research/topic/distill", {"topic": tid})
    sid = first.get_json()["session"]["id"]

    import store
    with store.mutate("research.json", {"topics": [], "entries": [], "sessions": []}) as data:
        session = next(s for s in data["sessions"] if s["id"] == sid)
        session["status"] = "done"

    r = _post(client, "/api/research/topic/distill", {"topic": tid})
    assert r.status_code == 200
    assert len(_read()["sessions"]) == 2


def test_distill_allows_concurrent_sessions_for_different_topics(client, stub_kick):
    _post(client, "/api/research/topic/add", {"name": "Hair Care"})
    _post(client, "/api/research/topic/add", {"name": "Sleep"})
    t1, t2 = [t["id"] for t in _read()["topics"]]

    r1 = _post(client, "/api/research/topic/distill", {"topic": t1})
    r2 = _post(client, "/api/research/topic/distill", {"topic": t2})
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert len(_read()["sessions"]) == 2


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


# --- re_quote field + id in add response ------------------------------------

def test_entry_add_re_quote_persists_and_id_returned(client):
    """re_quote is stored on the entry and the response includes the new id."""
    r = _post(client, "/api/research/entry/add", {
        "text": "Does X affect Y specifically?",
        "kind": "question",
        "re_quote": "Point one: X has a notable effect on Y under certain conditions.",
    })
    assert r.status_code == 200
    body = r.get_json()
    # Response must include the new entry's id.
    assert "id" in body
    eid = body["id"]
    assert eid

    data = _read()
    entry = next(e for e in data["entries"] if e["id"] == eid)
    assert entry["re_quote"] == "Point one: X has a notable effect on Y under certain conditions."


def test_entry_add_without_re_quote_omits_key(client):
    """Omitting re_quote must not add the key at all (backward-compat)."""
    r = _post(client, "/api/research/entry/add", {"text": "just a note"})
    assert r.status_code == 200
    body = r.get_json()
    assert "id" in body
    eid = body["id"]

    data = _read()
    entry = next(e for e in data["entries"] if e["id"] == eid)
    assert "re_quote" not in entry


def test_entry_add_empty_re_quote_omits_key(client):
    """An empty/whitespace re_quote string is treated the same as absent."""
    r = _post(client, "/api/research/entry/add", {"text": "a note", "re_quote": "   "})
    assert r.status_code == 200
    body = r.get_json()
    eid = body["id"]

    data = _read()
    entry = next(e for e in data["entries"] if e["id"] == eid)
    assert "re_quote" not in entry


# --- context_ids field on add -----------------------------------------------

def test_entry_add_context_ids_persists(client):
    """context_ids list is stored on the entry when provided."""
    r = _post(client, "/api/research/entry/add", {
        "text": "Does X cause Y via pathway Z?",
        "kind": "question",
        "context_ids": ["entry-a", "entry-b"],
    })
    assert r.status_code == 200
    body = r.get_json()
    assert "id" in body
    eid = body["id"]

    data = _read()
    entry = next(e for e in data["entries"] if e["id"] == eid)
    assert entry.get("context_ids") == ["entry-a", "entry-b"]


def test_entry_add_context_ids_coerced_to_strings(client):
    """context_ids values are coerced to strings."""
    r = _post(client, "/api/research/entry/add", {
        "text": "test question",
        "kind": "question",
        "context_ids": [42, "abc"],
    })
    assert r.status_code == 200
    eid = r.get_json()["id"]
    data = _read()
    entry = next(e for e in data["entries"] if e["id"] == eid)
    assert entry["context_ids"] == ["42", "abc"]


def test_entry_add_without_context_ids_omits_key(client):
    """Omitting context_ids must not add the key (backward-compat)."""
    r = _post(client, "/api/research/entry/add", {"text": "plain note"})
    assert r.status_code == 200
    eid = r.get_json()["id"]
    data = _read()
    entry = next(e for e in data["entries"] if e["id"] == eid)
    assert "context_ids" not in entry


def test_entry_add_empty_context_ids_omits_key(client):
    """An empty context_ids list must not add the key."""
    r = _post(client, "/api/research/entry/add", {"text": "plain note", "context_ids": []})
    assert r.status_code == 200
    eid = r.get_json()["id"]
    data = _read()
    entry = next(e for e in data["entries"] if e["id"] == eid)
    assert "context_ids" not in entry


# --- annotation-batch -------------------------------------------------------

def test_annotation_batch_creates_questions_sessions_and_kicks_dispatcher(client, monkeypatch):
    """POST /api/research/annotation-batch: creates 2 question entries + 2 QUEUED
    (not spawned) sessions (one deep, one regular), and kicks the dispatcher once
    rather than spawning a worker per item directly."""
    from routes import research as research_mod
    kicks = []
    monkeypatch.setattr(research_mod, "_kick_dispatcher", lambda: kicks.append(True))

    # Seed two entries as reply_to targets
    r1 = _post(client, "/api/research/entry/add", {"text": "Entry A", "kind": "note"})
    id1 = r1.get_json()["entries"][0]["id"]
    r2 = _post(client, "/api/research/entry/add", {"text": "Entry B", "kind": "note"})
    id2 = r2.get_json()["entries"][1]["id"]

    r = _post(client, "/api/research/annotation-batch", {
        "items": [
            {"reply_to": id1, "question": "Q1", "re_quote": "passage", "context_ids": [], "mode": "deep"},
            {"reply_to": id2, "question": "Q2", "re_quote": "", "context_ids": [id1], "mode": "regular"},
        ]
    })
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["count"] == 2
    assert len(body["session_ids"]) == 2
    assert len(body["question_ids"]) == 2

    data = _read()
    all_entries = data["entries"]
    all_sessions = data.get("sessions", [])

    # 2 original + 2 new question entries
    assert len(all_entries) == 4

    q_entries = [e for e in all_entries if e["kind"] == "question"]
    assert len(q_entries) == 2

    q1 = next(e for e in q_entries if e["text"] == "Q1")
    assert q1["reply_to"] == id1
    assert q1["re_quote"] == "passage"
    assert "context_ids" not in q1        # empty list → key omitted
    assert q1["status"] == "open"

    q2 = next(e for e in q_entries if e["text"] == "Q2")
    assert q2["reply_to"] == id2
    assert "re_quote" not in q2           # empty string → key omitted
    assert q2["context_ids"] == [str(id1)]

    assert len(all_sessions) == 2
    s_by_qid = {s["entry_ids"][0]: s for s in all_sessions}
    assert s_by_qid[q1["id"]]["mode"] == "deep"
    assert s_by_qid[q1["id"]]["status"] == "queued"
    assert s_by_qid[q1["id"]]["worker"] is True
    assert s_by_qid[q2["id"]]["mode"] == "regular"
    assert s_by_qid[q2["id"]]["status"] == "queued"
    assert s_by_qid[q2["id"]]["worker"] is True

    # the dispatcher is kicked exactly once for the whole batch, not per item
    assert kicks == [True]


def test_annotation_batch_empty_items_400(client, monkeypatch):
    """Empty items list must return 400 without touching the store."""
    from routes import research as research_mod
    monkeypatch.setattr(research_mod, "_kick_dispatcher", lambda: None)
    r = _post(client, "/api/research/annotation-batch", {"items": []})
    assert r.status_code == 400
    assert _read().get("sessions", []) == []


def test_annotation_batch_skips_blank_questions(client, monkeypatch):
    """Items with empty question text are silently skipped; others proceed."""
    from routes import research as research_mod
    kicks = []
    monkeypatch.setattr(research_mod, "_kick_dispatcher", lambda: kicks.append(True))

    r_base = _post(client, "/api/research/entry/add", {"text": "Base"})
    base_id = r_base.get_json()["entries"][0]["id"]

    r = _post(client, "/api/research/annotation-batch", {
        "items": [
            {"reply_to": base_id, "question": "", "re_quote": "", "context_ids": [], "mode": "regular"},
            {"reply_to": base_id, "question": "Real Q", "re_quote": "", "context_ids": [], "mode": "regular"},
        ]
    })
    assert r.status_code == 200
    body = r.get_json()
    assert body["count"] == 1
    assert kicks == [True]
