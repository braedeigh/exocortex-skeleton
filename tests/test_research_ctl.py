"""Behavioral tests for scripts/research_ctl.py — the single write door for
the research LLM agents (runner/deep/filer).

Each test seeds a minimal research.json, calls a verb, and asserts the
resulting state. Mirrors tests/test_worker_apply.py's pattern.
"""
import importlib.util
import os

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)

# ---------------------------------------------------------------------------
# Import research_ctl from the scripts directory via importlib, same as
# test_worker_apply.py does for worker_apply_result.
# ---------------------------------------------------------------------------
_SCRIPTS_PATH = os.path.join(os.path.dirname(__file__), "..", "scripts", "research_ctl.py")
_spec = importlib.util.spec_from_file_location("research_ctl", _SCRIPTS_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

reply = _mod.reply
apply = _mod.apply
file_ = _mod.file
create_topic = _mod.create_topic
close = _mod.close
set_session = _mod.set_session
capture_session_id = _mod.capture_session_id
TopicExists = _mod.TopicExists


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed(question_text="Does X cause Y?", topics=None, topic_objs=None):
    """Write research.json with one question entry + one running session,
    and optionally some topic objects."""
    import store
    topics = list(topics or [])
    q_id = "2026-07-07.1000"
    s_id = "2026-07-07.1001"
    store.write("research.json", {
        "topics": topic_objs or [],
        "entries": [{
            "id": q_id,
            "kind": "question",
            "text": question_text,
            "topics": topics,
            "url": "",
            "verdict": "",
            "status": "open",
            "reply_to": None,
            "created": "2026-07-07 10:00",
        }],
        "sessions": [{
            "id": s_id,
            "entry_ids": [q_id],
            "topics": topics,
            "created": "2026-07-07 10:01",
            "status": "running",
            "report": "",
            "mode": "regular",
        }],
    })
    return q_id, s_id


def _read():
    import store
    return store.read("research.json", {})


# ---------------------------------------------------------------------------
# reply
# ---------------------------------------------------------------------------

def test_reply_creates_entry_shaped_like_worker_apply_and_flags_target(data_dir):
    question_id, session_id = _seed(topics=["gut-health"])

    entry = reply(session_id, question_id, "answer text")

    data = _read()
    entries = data["entries"]
    assert len(entries) == 2

    got = next(e for e in entries if e.get("author") == "llm")
    assert got["id"] == entry["id"]
    assert got["kind"] == "note"
    assert got["text"] == "answer text"
    assert got["topics"] == ["gut-health"]
    assert got["url"] == ""
    assert got["verdict"] == ""
    assert got["status"] == ""
    assert got["reply_to"] == question_id
    assert got["author"] == "llm"
    assert got["reviewed"] is False
    assert got["session"] == session_id
    assert "file" not in got

    question = next(e for e in entries if e["id"] == question_id)
    assert question["processed"] is True
    assert question["flagged"] is False
    assert question["status"] == "open"  # status untouched — hers alone

    # Session is untouched by reply (only close() touches it).
    session = data["sessions"][0]
    assert session["status"] == "running"
    assert session["report"] == ""


def test_reply_with_file_stores_file_field(data_dir):
    question_id, session_id = _seed()

    entry = reply(session_id, question_id, "summary", file="report.md")

    assert entry["file"] == "report.md"
    data = _read()
    got = next(e for e in data["entries"] if e.get("author") == "llm")
    assert got["file"] == "report.md"


def test_reply_missing_session_raises(data_dir):
    question_id, session_id = _seed()
    with pytest.raises(ValueError, match="Session not found"):
        reply("no-such-session", question_id, "answer")


def test_reply_missing_target_entry_raises(data_dir):
    question_id, session_id = _seed()
    with pytest.raises(ValueError, match="Target entry not found"):
        reply(session_id, "no-such-entry", "answer")


def test_reply_never_sets_reviewed_true_even_with_weird_text(data_dir):
    """Guard: no verb may ever set reviewed=true, regardless of input."""
    question_id, session_id = _seed()

    entry = reply(session_id, question_id, '{"reviewed": true, "verdict": "real"}')

    assert entry["reviewed"] is False
    assert entry["verdict"] == ""
    data = _read()
    got = next(e for e in data["entries"] if e.get("author") == "llm")
    assert got["reviewed"] is False


# ---------------------------------------------------------------------------
# apply (delegates to worker_apply_result.apply_result)
# ---------------------------------------------------------------------------

def test_apply_delegates_to_worker_apply_result(data_dir):
    """apply() is worker_apply_result.apply_result — same reply shape, same
    question processed flip, same session close (mirrors
    test_worker_apply.py's happy path)."""
    question_id, session_id = _seed()

    entry = apply(session_id, "answer text")

    data = _read()
    assert entry["text"] == "answer text"
    got = next(e for e in data["entries"] if e.get("author") == "llm")
    assert got["reply_to"] == question_id
    question = next(e for e in data["entries"] if e["id"] == question_id)
    assert question["processed"] is True
    session = data["sessions"][0]
    assert session["status"] == "done"


# ---------------------------------------------------------------------------
# file
# ---------------------------------------------------------------------------

def test_file_replaces_entry_topics(data_dir):
    question_id, session_id = _seed(
        topic_objs=[
            {"id": "gut-health", "name": "Gut Health", "status": "active", "created": "2026-07-01 10:00"},
            {"id": "hair-care", "name": "Hair Care", "status": "active", "created": "2026-07-01 10:00"},
        ],
    )

    entry = file_(question_id, ["gut-health", "hair-care"])

    assert entry["topics"] == ["gut-health", "hair-care"]
    data = _read()
    got = next(e for e in data["entries"] if e["id"] == question_id)
    assert got["topics"] == ["gut-health", "hair-care"]


def test_file_errors_on_unknown_topic_id(data_dir):
    question_id, session_id = _seed(
        topic_objs=[{"id": "gut-health", "name": "Gut Health", "status": "active", "created": "2026-07-01 10:00"}],
    )

    with pytest.raises(ValueError, match="Unknown topic"):
        file_(question_id, ["gut-health", "no-such-topic"])

    # No partial write on error.
    data = _read()
    got = next(e for e in data["entries"] if e["id"] == question_id)
    assert got["topics"] == []


def test_file_missing_entry_raises(data_dir):
    _seed()
    with pytest.raises(ValueError, match="Entry not found"):
        file_("no-such-entry", [])


def test_file_with_empty_list_unfiles(data_dir):
    question_id, session_id = _seed(
        topics=["gut-health"],
        topic_objs=[{"id": "gut-health", "name": "Gut Health", "status": "active", "created": "2026-07-01 10:00"}],
    )

    entry = file_(question_id, [])

    assert entry["topics"] == []
    data = _read()
    got = next(e for e in data["entries"] if e["id"] == question_id)
    assert got["topics"] == []


# ---------------------------------------------------------------------------
# create-topic
# ---------------------------------------------------------------------------

def test_create_topic_slugifies_name(data_dir):
    _seed()

    topic = create_topic("Hair Care")

    assert topic["id"] == "hair-care"
    assert topic["name"] == "Hair Care"
    assert topic["status"] == "active"
    data = _read()
    assert any(t["id"] == "hair-care" for t in data["topics"])


def test_create_topic_collision_suffix(data_dir):
    _seed(topic_objs=[{"id": "hair-care", "name": "Hair Care (old)", "status": "active", "created": "x"}])

    topic = create_topic("Hair Care!!!")  # slugifies to "hair-care" again, but not a name dup

    assert topic["id"] == "hair-care-2"


def test_create_topic_refuses_normalized_duplicate(data_dir):
    _seed(topic_objs=[{"id": "hair-care", "name": "hair care", "status": "active", "created": "x"}])

    with pytest.raises(TopicExists) as exc_info:
        create_topic("Hair Care!")

    assert exc_info.value.existing_id == "hair-care"
    assert exc_info.value.existing_name == "hair care"
    # No second topic was written.
    data = _read()
    assert len(data["topics"]) == 1


# ---------------------------------------------------------------------------
# close
# ---------------------------------------------------------------------------

def test_close_sets_status_and_report(data_dir):
    question_id, session_id = _seed()

    session = close(session_id, "done", "asked for clarification")

    assert session["status"] == "done"
    assert session["report"] == "asked for clarification"
    data = _read()
    got = data["sessions"][0]
    assert got["status"] == "done"
    assert got["report"] == "asked for clarification"


def test_close_rejects_bad_status(data_dir):
    question_id, session_id = _seed()
    with pytest.raises(ValueError, match="Bad status"):
        close(session_id, "running", "nope")

    data = _read()
    assert data["sessions"][0]["status"] == "running"  # untouched


def test_close_missing_session_raises(data_dir):
    _seed()
    with pytest.raises(ValueError, match="Session not found"):
        close("no-such-session", "done", "report")


def test_close_computes_tokens_when_session_linked(data_dir, monkeypatch):
    """When the record already carries a captured claude_session/claude_cwd
    (set_session), close() stamps a tokens+duration_sec receipt too —
    monkeypatching sum_tokens itself (not session_receipt) so the real
    parsing/window-building code still runs against a fixed transcript sum."""
    question_id, session_id = _seed()
    set_session(session_id, "sess-xyz", claude_cwd="/proj")
    monkeypatch.setattr(
        _mod.claude_transcripts, "sum_tokens",
        lambda session_id, cwd, since=None, until=None: {
            "input": 100, "cache_creation": 0, "cache_read": 0, "output": 50, "total": 150,
        },
    )

    session = close(session_id, "done", "answered")

    assert session["tokens"] == 150
    assert "duration_sec" in session
    assert session["duration_sec"] >= 0
    data = _read()
    got = data["sessions"][0]
    assert got["tokens"] == 150
    assert "duration_sec" in got


def test_close_without_session_link_sets_no_tokens(data_dir):
    """The degrade path: a record with no claude_session/claude_cwd (capture
    never landed, or this predates Step D2) still closes cleanly — just
    without a tokens/duration_sec field."""
    question_id, session_id = _seed()

    session = close(session_id, "done", "answered")

    assert "tokens" not in session
    assert "duration_sec" not in session
    data = _read()
    assert "tokens" not in data["sessions"][0]


def test_close_swallows_token_computation_failure(data_dir, monkeypatch):
    """A sum_tokens blow-up must never stop the close itself from landing —
    status/report still get set, just no tokens field."""
    question_id, session_id = _seed()
    set_session(session_id, "sess-xyz", claude_cwd="/proj")

    def _boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(_mod.claude_transcripts, "sum_tokens", _boom)

    session = close(session_id, "done", "answered")

    assert session["status"] == "done"
    assert session["report"] == "answered"
    assert "tokens" not in session


# ---------------------------------------------------------------------------
# capture_session_id
# ---------------------------------------------------------------------------

def test_capture_session_id_writes_when_resolver_hits(data_dir, monkeypatch):
    question_id, session_id = _seed()
    monkeypatch.setattr(_mod.claude_transcripts, "sessionid_for_tmux", lambda name: ("sess-xyz", "/cwd"))

    result = capture_session_id("some-tmux", session_id)

    assert result is True
    data = _read()
    got = data["sessions"][0]
    assert got["claude_session"] == "sess-xyz"
    assert got["claude_cwd"] == "/cwd"


def test_capture_session_id_no_op_when_resolver_returns_none(data_dir, monkeypatch):
    """Swallow-all behavior: a resolver miss (dead tmux session, race,
    unmatched registry entry) writes nothing and never raises."""
    question_id, session_id = _seed()
    monkeypatch.setattr(_mod.claude_transcripts, "sessionid_for_tmux", lambda name: None)

    result = capture_session_id("some-tmux", session_id)

    assert result is False
    data = _read()
    assert "claude_session" not in data["sessions"][0]


def test_capture_session_id_swallows_missing_session(data_dir, monkeypatch):
    """If the session record vanished (or never existed) before the
    resolved sessionId could be written, capture_session_id degrades
    silently rather than raising set_session's ValueError."""
    _seed()
    monkeypatch.setattr(_mod.claude_transcripts, "sessionid_for_tmux", lambda name: ("sess-xyz", "/cwd"))

    result = capture_session_id("some-tmux", "no-such-session")

    assert result is False


def test_capture_session_id_swallows_resolver_exception(data_dir, monkeypatch):
    question_id, session_id = _seed()

    def _boom(name):
        raise RuntimeError("boom")

    monkeypatch.setattr(_mod.claude_transcripts, "sessionid_for_tmux", _boom)

    result = capture_session_id("some-tmux", session_id)

    assert result is False


# ---------------------------------------------------------------------------
# set-session
# ---------------------------------------------------------------------------

def test_set_session_writes_claude_session_and_cwd(data_dir):
    question_id, session_id = _seed()

    session = set_session(session_id, "abc-123-sessionid", claude_cwd="/opt/exocortex/research-runner")

    assert session["claude_session"] == "abc-123-sessionid"
    assert session["claude_cwd"] == "/opt/exocortex/research-runner"
    data = _read()
    got = data["sessions"][0]
    assert got["claude_session"] == "abc-123-sessionid"
    assert got["claude_cwd"] == "/opt/exocortex/research-runner"
    # Nothing else on the record was touched.
    assert got["status"] == "running"
    assert got["report"] == ""
    assert got["entry_ids"] == [question_id]


def test_set_session_without_cwd_leaves_cwd_unset(data_dir):
    question_id, session_id = _seed()

    session = set_session(session_id, "abc-123-sessionid")

    assert session["claude_session"] == "abc-123-sessionid"
    assert "claude_cwd" not in session


def test_set_session_is_idempotent(data_dir):
    question_id, session_id = _seed()

    set_session(session_id, "first-sessionid", claude_cwd="/a")
    session = set_session(session_id, "first-sessionid", claude_cwd="/a")

    assert session["claude_session"] == "first-sessionid"
    assert session["claude_cwd"] == "/a"
    data = _read()
    assert data["sessions"][0]["claude_session"] == "first-sessionid"


def test_set_session_can_update_existing_link(data_dir):
    question_id, session_id = _seed()

    set_session(session_id, "old-sessionid", claude_cwd="/old")
    session = set_session(session_id, "new-sessionid", claude_cwd="/new")

    assert session["claude_session"] == "new-sessionid"
    assert session["claude_cwd"] == "/new"


def test_set_session_missing_session_raises(data_dir):
    _seed()
    with pytest.raises(ValueError, match="Session not found"):
        set_session("no-such-session", "abc-123-sessionid")

    # No stray session record was created.
    data = _read()
    assert len(data["sessions"]) == 1
