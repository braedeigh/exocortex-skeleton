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
