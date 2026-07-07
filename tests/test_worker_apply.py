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


def _seed_distill(topics=None):
    """Write research.json with a distill session: no entry_ids, one topic,
    nothing to look up or flag-flip."""
    import store
    topics = list(topics or ["hair-care"])
    s_id = "2026-07-07.1200"
    store.write("research.json", {
        "topics": [{"id": tid, "name": tid, "status": "active", "created": "2026-07-07 09:00"} for tid in topics],
        "entries": [],
        "sessions": [{
            "id": s_id,
            "entry_ids": [],
            "topics": topics,
            "created": "2026-07-07 12:00",
            "status": "running",
            "report": "",
            "mode": "distill",
            "worker": True,
        }],
    })
    return s_id


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


# ---------------------------------------------------------------------------
# Entry-less (distill) sessions: entry_ids == [], topics come from the
# session itself, no question entry is looked up or flag-flipped.
# ---------------------------------------------------------------------------

def test_apply_result_distill_creates_reply_with_no_reply_to(data_dir):
    """A distill session (entry_ids: []) gets a reply entry with
    reply_to=None and topics copied straight from the session, not from a
    question (there isn't one)."""
    session_id = _seed_distill(topics=["hair-care", "sleep"])

    apply_result(session_id, "digest of what's settled", file="edge/hair-care.md")

    data = _read()
    entries = data["entries"]
    assert len(entries) == 1   # no question entry existed to begin with

    reply = entries[0]
    assert reply["author"] == "llm"
    assert reply["reply_to"] is None
    assert reply["topics"] == ["hair-care", "sleep"]
    assert reply["file"] == "edge/hair-care.md"
    assert reply["reviewed"] is False
    assert reply["session"] == session_id


def test_apply_result_distill_session_report_names_the_file(data_dir):
    session_id = _seed_distill()

    apply_result(session_id, "digest", file="edge/hair-care.md")

    session = _read()["sessions"][0]
    assert session["status"] == "done"
    assert session["report"] == "Distilled → research/edge/hair-care.md"


def test_apply_result_distill_session_report_defaults_without_file(data_dir):
    session_id = _seed_distill()

    apply_result(session_id, "digest")

    session = _read()["sessions"][0]
    assert session["report"] == "Distilled."


def test_apply_result_distill_touches_no_question_entry(data_dir):
    """No entries exist besides the reply itself — nothing gets a spurious
    `processed`/`flagged` flip since there was no question to touch."""
    session_id = _seed_distill()

    apply_result(session_id, "digest", file="edge/hair-care.md")

    entries = _read()["entries"]
    assert len(entries) == 1
    assert "processed" not in entries[0]
    assert "flagged" not in entries[0]


def test_apply_result_deregisters_terminal_tab(data_dir, monkeypatch):
    """A finished worker's tmux name must leave sessions.json — a lingering
    tab invites a tap, and the terminal's attach path used to squat the name
    with a bare shell the dispatcher mistook for a live worker."""
    import store
    question_id, session_id = _seed()
    monkeypatch.setattr(_mod, "_kick_dispatcher", lambda sid: None)
    tab = "rw-" + session_id.replace(".", "-")
    store.write("sessions.json", ["chat", tab])

    apply_result(session_id, "answer text")

    assert store.read("sessions.json", []) == ["chat"]
