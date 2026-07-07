"""Behavioral tests for scripts/worker_apply_result.py.

Each test seeds a minimal research.json with one question entry and one
running session, then calls apply_result() and asserts the resulting state.
"""
import importlib.util
import os
import sys

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)

# ---------------------------------------------------------------------------
# Import apply_result from the scripts directory.  The scripts/ folder sits
# next to tests/ (one level up).  We load it via importlib to avoid needing
# a package __init__, and to keep the import explicit.
# ---------------------------------------------------------------------------
_SCRIPTS_PATH = os.path.join(os.path.dirname(__file__), "..", "scripts", "worker_apply_result.py")
_spec = importlib.util.spec_from_file_location("worker_apply_result", _SCRIPTS_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
apply_result = _mod.apply_result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed(question_text="Does X cause Y?", topics=None):
    """Write research.json with one question entry + one running session."""
    import store
    topics = list(topics or [])
    q_id = "2026-07-07.1000"
    s_id = "2026-07-07.1001"
    store.write("research.json", {
        "topics": [],
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
# Tests
# ---------------------------------------------------------------------------

def test_apply_result_creates_reply_entry_and_closes_session(data_dir):
    """The happy path: a reply entry is created; question is processed; session done."""
    question_id, session_id = _seed()

    apply_result(session_id, "answer text")

    data = _read()
    entries = data["entries"]
    sessions = data["sessions"]

    # Original question + new reply
    assert len(entries) == 2

    reply = next(e for e in entries if e.get("author") == "llm")
    assert reply["kind"] == "note"
    assert reply["text"] == "answer text"
    assert reply["reply_to"] == question_id
    assert reply["session"] == session_id
    assert reply["reviewed"] is False
    assert "file" not in reply

    question = next(e for e in entries if e["id"] == question_id)
    assert question["processed"] is True
    assert question["flagged"] is False
    assert question["status"] == "open"          # status must NOT be changed

    assert len(sessions) == 1
    assert sessions[0]["status"] == "done"
    assert sessions[0]["report"] == "Answered."


def test_apply_result_with_file_stores_file_and_report(data_dir):
    """When --file is given the reply entry gains a .file field and the session
    report references the file path."""
    question_id, session_id = _seed()

    apply_result(session_id, "summary of findings", file="gut.md")

    data = _read()
    reply = next(e for e in data["entries"] if e.get("author") == "llm")
    assert reply["file"] == "gut.md"

    session = data["sessions"][0]
    assert session["status"] == "done"
    assert "gut.md" in session["report"]


def test_apply_result_missing_session_raises(data_dir):
    """Applying to a non-existent session must raise ValueError."""
    _seed()          # seeds a real session but we pass the wrong id
    with pytest.raises(ValueError, match="Session not found"):
        apply_result("no-such-session", "some answer")


def test_apply_result_kicks_dispatcher(data_dir, monkeypatch):
    """A successful apply fires the dispatcher (fire-and-forget) so the next
    queued worker gets admitted right away instead of waiting for cron."""
    question_id, session_id = _seed()
    kicks = []
    monkeypatch.setattr(_mod, "_kick_dispatcher", lambda sid: kicks.append(sid))

    apply_result(session_id, "answer text")

    assert kicks == [session_id]
