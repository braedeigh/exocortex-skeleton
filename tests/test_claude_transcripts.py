"""Tests for scripts/claude_transcripts.py — pure transcript-resolution and
token-summing helpers behind the research-runner token-usage receipt.

No Flask app, no store — these are plain functions over the filesystem and
(mocked) subprocess calls, matching the module's own no-Flask-import rule.
"""
import json
import subprocess
from datetime import datetime

import pytest

from scripts import claude_transcripts as ct


# ---------------------------------------------------------------------------
# transcript_path
# ---------------------------------------------------------------------------

def test_transcript_path_flattens_cwd_to_dashes():
    path = ct.transcript_path("abc-123", "/opt/exocortex/research-runner")

    assert path == (
        ct.CLAUDE_HOME / "projects"
        / "-opt-exocortex-research-runner" / "abc-123.jsonl"
    )


def test_transcript_path_handles_none_cwd_without_raising():
    path = ct.transcript_path("abc-123", None)

    assert path.name == "abc-123.jsonl"


# ---------------------------------------------------------------------------
# sum_tokens
# ---------------------------------------------------------------------------

def _usage_line(timestamp, input_tokens=1, cache_creation=0, cache_read=0, output=1):
    return json.dumps({
        "message": {
            "role": "assistant",
            "usage": {
                "input_tokens": input_tokens,
                "cache_creation_input_tokens": cache_creation,
                "cache_read_input_tokens": cache_read,
                "output_tokens": output,
            },
        },
        "timestamp": timestamp,
    })


def _write_transcript(tmp_path, monkeypatch, session_id, cwd, lines):
    monkeypatch.setattr(ct, "CLAUDE_HOME", tmp_path)
    path = ct.transcript_path(session_id, cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
    return path


def test_sum_tokens_adds_up_assistant_usage_lines(tmp_path, monkeypatch):
    _write_transcript(tmp_path, monkeypatch, "sess1", "/proj", [
        _usage_line("2026-07-17T10:00:00.000Z", input_tokens=10, output=5),
        _usage_line("2026-07-17T10:01:00.000Z", input_tokens=20, cache_creation=3, cache_read=7, output=8),
    ])

    totals = ct.sum_tokens("sess1", "/proj")

    assert totals == {
        "input": 30, "cache_creation": 3, "cache_read": 7, "output": 13,
        "total": 30 + 3 + 7 + 13,
    }


def test_sum_tokens_ignores_non_assistant_lines(tmp_path, monkeypatch):
    user_line = json.dumps({"message": {"role": "user", "content": "hi"},
                             "timestamp": "2026-07-17T10:00:00.000Z"})
    _write_transcript(tmp_path, monkeypatch, "sess1", "/proj", [
        user_line,
        _usage_line("2026-07-17T10:01:00.000Z", input_tokens=5, output=2),
    ])

    totals = ct.sum_tokens("sess1", "/proj")

    assert totals["input"] == 5
    assert totals["output"] == 2


def test_sum_tokens_time_slice_includes_lines_in_window(tmp_path, monkeypatch):
    _write_transcript(tmp_path, monkeypatch, "sess1", "/proj", [
        _usage_line("2026-07-17T09:00:00.000Z", input_tokens=100),  # before window
        _usage_line("2026-07-17T10:00:00.000Z", input_tokens=10),   # in window
        _usage_line("2026-07-17T10:30:00.000Z", input_tokens=20),   # in window
        _usage_line("2026-07-17T11:00:00.000Z", input_tokens=200),  # after window
    ])

    totals = ct.sum_tokens(
        "sess1", "/proj",
        since="2026-07-17T09:59:00.000Z",
        until="2026-07-17T10:45:00.000Z",
    )

    assert totals["input"] == 30


def test_sum_tokens_since_only_excludes_earlier_lines(tmp_path, monkeypatch):
    _write_transcript(tmp_path, monkeypatch, "sess1", "/proj", [
        _usage_line("2026-07-17T09:00:00.000Z", input_tokens=1),
        _usage_line("2026-07-17T10:00:00.000Z", input_tokens=2),
    ])

    totals = ct.sum_tokens("sess1", "/proj", since="2026-07-17T09:30:00.000Z")

    assert totals["input"] == 2


def test_sum_tokens_missing_file_returns_zeros(tmp_path, monkeypatch):
    monkeypatch.setattr(ct, "CLAUDE_HOME", tmp_path)

    totals = ct.sum_tokens("no-such-session", "/proj")

    assert totals == {"input": 0, "cache_creation": 0, "cache_read": 0, "output": 0, "total": 0}


def test_sum_tokens_skips_malformed_lines(tmp_path, monkeypatch):
    _write_transcript(tmp_path, monkeypatch, "sess1", "/proj", [
        "not json{",
        json.dumps(["a", "list", "not", "a", "dict"]),
        json.dumps({"message": "not-a-dict"}),
        _usage_line("2026-07-17T10:00:00.000Z", input_tokens=5, output=1),
        "",  # blank line
    ])

    totals = ct.sum_tokens("sess1", "/proj")

    assert totals["input"] == 5
    assert totals["output"] == 1


def test_sum_tokens_line_with_unparseable_timestamp_excluded_from_window(tmp_path, monkeypatch):
    bad_ts_line = json.dumps({
        "message": {"role": "assistant", "usage": {"input_tokens": 99, "output_tokens": 1}},
        "timestamp": "not-a-timestamp",
    })
    _write_transcript(tmp_path, monkeypatch, "sess1", "/proj", [
        bad_ts_line,
        _usage_line("2026-07-17T10:00:00.000Z", input_tokens=5, output=1),
    ])

    totals = ct.sum_tokens("sess1", "/proj", since="2026-07-17T09:00:00.000Z")

    # bad_ts_line can't be placed in the window, so it's excluded rather
    # than raising or being counted by default.
    assert totals["input"] == 5


# ---------------------------------------------------------------------------
# sessionid_for_tmux
# ---------------------------------------------------------------------------

class _FakeCompletedProcess:
    def __init__(self, stdout="", returncode=0):
        self.stdout = stdout
        self.returncode = returncode


def test_sessionid_for_tmux_returns_none_when_tmux_session_missing(monkeypatch):
    monkeypatch.setattr(ct, "_tmux", lambda cmd_str, timeout=5: _FakeCompletedProcess(stdout="", returncode=1))

    assert ct.sessionid_for_tmux("no-such-session") is None


def test_sessionid_for_tmux_returns_none_when_registry_has_no_match(monkeypatch):
    monkeypatch.setattr(ct, "_tmux", lambda cmd_str, timeout=5: _FakeCompletedProcess(stdout="4242\n"))
    monkeypatch.setattr(ct, "_live_claude_sessions", lambda: [])

    assert ct.sessionid_for_tmux("chat") is None


def test_sessionid_for_tmux_returns_none_when_tmux_raises(monkeypatch):
    def _boom(cmd_str, timeout=5):
        raise subprocess.TimeoutExpired(cmd="tmux", timeout=5)
    monkeypatch.setattr(ct, "_tmux", _boom)

    assert ct.sessionid_for_tmux("chat") is None


def test_sessionid_for_tmux_matches_pane_pid_in_registry_ancestry(monkeypatch):
    monkeypatch.setattr(ct, "_tmux", lambda cmd_str, timeout=5: _FakeCompletedProcess(stdout="100\n"))
    monkeypatch.setattr(ct, "_proc_ancestors", lambda pid: {200: [300, 200, 100, 1]}.get(pid, [pid]))
    monkeypatch.setattr(ct, "_live_claude_sessions", lambda: [
        {"pid": 200, "sessionId": "the-session-id", "cwd": "/opt/exocortex", "updatedAt": 5},
    ])

    result = ct.sessionid_for_tmux("chat")

    assert result == ("the-session-id", "/opt/exocortex")


def test_sessionid_for_tmux_prefers_most_recently_updated_match(monkeypatch):
    monkeypatch.setattr(ct, "_tmux", lambda cmd_str, timeout=5: _FakeCompletedProcess(stdout="100\n"))
    monkeypatch.setattr(ct, "_proc_ancestors", lambda pid: [pid, 100, 1])
    monkeypatch.setattr(ct, "_live_claude_sessions", lambda: [
        {"pid": 200, "sessionId": "older", "cwd": "/a", "updatedAt": 1},
        {"pid": 201, "sessionId": "newer", "cwd": "/b", "updatedAt": 9},
    ])

    result = ct.sessionid_for_tmux("chat")

    assert result == ("newer", "/b")


# ---------------------------------------------------------------------------
# session_receipt
# ---------------------------------------------------------------------------

def test_session_receipt_computes_tokens_and_duration(monkeypatch):
    seen = {}

    def _fake_sum_tokens(session_id, cwd, since=None, until=None):
        seen["args"] = (session_id, cwd, since, until)
        return {"input": 1, "cache_creation": 0, "cache_read": 0, "output": 1, "total": 2}

    monkeypatch.setattr(ct, "sum_tokens", _fake_sum_tokens)
    session = {"claude_session": "s1", "claude_cwd": "/proj", "created": "2026-07-17 05:00"}
    now = datetime(2026, 7, 17, 5, 2, 40)

    receipt = ct.session_receipt(session, now=now)

    assert receipt == {"tokens": 2, "duration_sec": 160.0}
    # since/until got converted to real datetimes (not passed through as the
    # local-naive values) — sum_tokens's own window logic expects UTC.
    sess_id, cwd, since, until = seen["args"]
    assert sess_id == "s1"
    assert cwd == "/proj"
    assert since is not None and until is not None


def test_session_receipt_missing_claude_session_returns_empty():
    assert ct.session_receipt({}) == {}
    assert ct.session_receipt({"claude_cwd": "/p", "created": "2026-07-17 05:00"}) == {}


def test_session_receipt_missing_cwd_returns_empty():
    assert ct.session_receipt({"claude_session": "s1", "created": "2026-07-17 05:00"}) == {}


def test_session_receipt_missing_created_returns_empty():
    assert ct.session_receipt({"claude_session": "s1", "claude_cwd": "/p"}) == {}


def test_session_receipt_unparseable_created_returns_empty():
    assert ct.session_receipt({
        "claude_session": "s1", "claude_cwd": "/p", "created": "not-a-date",
    }) == {}


def test_session_receipt_swallows_sum_tokens_exception(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(ct, "sum_tokens", _boom)
    session = {"claude_session": "s1", "claude_cwd": "/proj", "created": "2026-07-17 05:00"}

    assert ct.session_receipt(session) == {}
