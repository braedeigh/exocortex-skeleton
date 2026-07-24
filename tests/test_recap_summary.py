"""Background Haiku session summaries (recap_summary.py).

get_summary() never blocks on the CLI or the background thread in prod, so
tests monkeypatch _spawn to run the refresh inline (synchronous) and
_run_claude to a fake returning a canned summary -- that lets us assert on
the cache store.py writes without any real subprocess or threading.
"""
import json
import time
from types import SimpleNamespace

import pytest

import recap_summary
import store


@pytest.fixture(autouse=True)
def _reset_module_state(data_dir, monkeypatch):
    """Isolate the module-level in-memory bookkeeping (in-flight set,
    failure backoff) per test, on top of the data_dir isolation for the
    store-backed cache."""
    monkeypatch.setattr(recap_summary, "_in_flight", set())
    monkeypatch.setattr(recap_summary, "_last_failure", {})
    yield


@pytest.fixture
def inline_spawn(monkeypatch):
    """Run background refreshes synchronously instead of on a thread."""
    def spawn(fn):
        fn()
    monkeypatch.setattr(recap_summary, "_spawn", spawn)


class fake_claude:
    """Stand-in for recap_summary._run_claude. `.stdout`/`.returncode` are
    plain mutable attributes read fresh on every call, so a test can change
    the canned response between get_summary() calls."""

    def __init__(self, stdout="Working on the recap summarizer.", returncode=0):
        self.stdout = stdout
        self.returncode = returncode
        self.calls = []

    def __call__(self, prompt):
        self.calls.append(prompt)
        return SimpleNamespace(returncode=self.returncode, stdout=self.stdout, stderr="")


def _assistant(text):
    return json.dumps({"message": {"role": "assistant",
                                    "content": [{"type": "text", "text": text}]}})


def _user(text):
    return json.dumps({"message": {"role": "user", "content": text}})


def _write_transcript(tmp_path, name, lines):
    path = tmp_path / name
    path.write_text("\n".join(lines) + "\n")
    return path


# --- get_summary lifecycle ---------------------------------------------------

def test_first_sight_triggers_refresh_and_caches_summary(tmp_path, monkeypatch, inline_spawn):
    fake = fake_claude("Building the background summarizer feature.")
    monkeypatch.setattr(recap_summary, "_run_claude", fake)
    path = _write_transcript(tmp_path, "t.jsonl", [_user("hi"), _assistant("working on it")])

    # First call: no cache yet, so it returns None even though the (inline)
    # refresh runs synchronously underneath -- get_summary always answers
    # from the cache as it existed *before* triggering the refresh.
    first = recap_summary.get_summary("sess-1", path)
    assert first is None
    assert len(fake.calls) == 1

    # Second call: the cache now has the summary from the refresh above.
    second = recap_summary.get_summary("sess-1", path)
    assert second == "Building the background summarizer feature."
    # Unchanged transcript -> no second CLI call yet.
    assert len(fake.calls) == 1


def test_unchanged_transcript_does_not_retrigger(tmp_path, monkeypatch, inline_spawn):
    fake = fake_claude("Summary one.")
    monkeypatch.setattr(recap_summary, "_run_claude", fake)
    path = _write_transcript(tmp_path, "t.jsonl", [_assistant("hello")])

    recap_summary.get_summary("sess-1", path)  # triggers + caches
    assert len(fake.calls) == 1

    for _ in range(3):
        recap_summary.get_summary("sess-1", path)
    assert len(fake.calls) == 1


def test_grown_transcript_within_min_interval_does_not_refresh(tmp_path, monkeypatch, inline_spawn):
    fake = fake_claude("Summary one.")
    monkeypatch.setattr(recap_summary, "_run_claude", fake)
    path = _write_transcript(tmp_path, "t.jsonl", [_assistant("hello")])

    recap_summary.get_summary("sess-1", path)  # first refresh, caches with at=now
    assert len(fake.calls) == 1

    # Grow the transcript (new mtime/size) but stay within MIN_INTERVAL_SEC.
    path.write_text(path.read_text() + _assistant("more") + "\n")
    recap_summary.get_summary("sess-1", path)
    assert len(fake.calls) == 1  # still no second call -- too soon


def test_grown_transcript_after_min_interval_refreshes(tmp_path, monkeypatch, inline_spawn):
    fake = fake_claude("Summary one.")
    monkeypatch.setattr(recap_summary, "_run_claude", fake)
    path = _write_transcript(tmp_path, "t.jsonl", [_assistant("hello")])

    recap_summary.get_summary("sess-1", path)
    assert len(fake.calls) == 1

    # Force the cached entry's `at` to be old enough.
    with store.mutate(recap_summary.COLLECTION, {}) as cache:
        cache["sess-1"]["at"] -= recap_summary.MIN_INTERVAL_SEC + 1

    path.write_text(path.read_text() + _assistant("more") + "\n")
    fake.stdout = "Summary two."
    # Returns the pre-refresh cached text immediately (even though the
    # inline refresh runs synchronously underneath and updates the cache).
    assert recap_summary.get_summary("sess-1", path) == "Summary one."
    assert len(fake.calls) == 2

    # Next poll sees the refreshed cache.
    assert recap_summary.get_summary("sess-1", path) == "Summary two."


def test_missing_transcript_returns_cached_summary_without_refresh(tmp_path, monkeypatch, inline_spawn):
    fake = fake_claude("Summary one.")
    monkeypatch.setattr(recap_summary, "_run_claude", fake)
    path = _write_transcript(tmp_path, "t.jsonl", [_assistant("hello")])
    recap_summary.get_summary("sess-1", path)
    recap_summary.get_summary("sess-1", path)
    assert len(fake.calls) == 1

    missing = tmp_path / "gone.jsonl"
    result = recap_summary.get_summary("sess-1", missing)
    assert result == "Summary one."
    assert len(fake.calls) == 1  # no refresh attempted against a missing file


# --- failure backoff ---------------------------------------------------------

def test_cli_failure_backs_off_and_keeps_old_summary(tmp_path, monkeypatch, inline_spawn):
    fake = fake_claude("Summary one.")
    monkeypatch.setattr(recap_summary, "_run_claude", fake)
    path = _write_transcript(tmp_path, "t.jsonl", [_assistant("hello")])
    recap_summary.get_summary("sess-1", path)
    assert recap_summary.get_summary("sess-1", path) == "Summary one."

    # Push past MIN_INTERVAL_SEC and grow the transcript so a refresh is due.
    with store.mutate(recap_summary.COLLECTION, {}) as cache:
        cache["sess-1"]["at"] -= recap_summary.MIN_INTERVAL_SEC + 1
    path.write_text(path.read_text() + _assistant("more") + "\n")

    failing = fake_claude(returncode=1, stdout="")
    monkeypatch.setattr(recap_summary, "_run_claude", failing)
    recap_summary.get_summary("sess-1", path)
    assert len(failing.calls) == 1
    # Old summary retained on failure.
    assert recap_summary.get_summary("sess-1", path) == "Summary one."

    # Backoff: further polls (even though transcript is still "stale" and
    # MIN_INTERVAL_SEC has passed) don't retrigger within FAILURE_BACKOFF_SEC.
    recap_summary.get_summary("sess-1", path)
    assert len(failing.calls) == 1

    # After the backoff window, it retries.
    recap_summary._last_failure["sess-1"] -= recap_summary.FAILURE_BACKOFF_SEC + 1
    ok = fake_claude("Summary two.")
    monkeypatch.setattr(recap_summary, "_run_claude", ok)
    recap_summary.get_summary("sess-1", path)
    assert len(ok.calls) == 1
    assert recap_summary.get_summary("sess-1", path) == "Summary two."


# --- _build_dialogue -----------------------------------------------------

def test_build_dialogue_skips_sidechains_and_compaction_blobs():
    compact = json.dumps({"message": {"role": "user",
                           "content": "This session is being continued from a previous conversation blah"}})
    sidechain = json.dumps({"message": {"role": "assistant", "content": [{"type": "text", "text": "subagent chatter"}]},
                             "isSidechain": True})
    lines = [compact, sidechain, _user("real question"), _assistant("real answer")]
    dialogue = recap_summary._build_dialogue(lines)
    assert "subagent chatter" not in dialogue
    assert "continued from a previous conversation" not in dialogue
    assert "User: real question" in dialogue
    assert "Assistant: real answer" in dialogue


def test_build_dialogue_truncates_long_messages():
    lines = [_user("x" * 1000)]
    dialogue = recap_summary._build_dialogue(lines)
    # "User: " prefix + 500 chars (499 + ellipsis)
    body = dialogue[len("User: "):]
    assert len(body) == 500
    assert body.endswith("…")


def test_build_dialogue_keeps_only_last_30_messages():
    lines = [_user(f"msg {i}") for i in range(40)]
    dialogue = recap_summary._build_dialogue(lines)
    turns = dialogue.splitlines()
    assert len(turns) == 30
    assert turns[0] == "User: msg 10"
    assert turns[-1] == "User: msg 39"


def test_build_dialogue_empty_for_no_recognisable_turns():
    lines = ["not json{", json.dumps({"type": "file-history-snapshot"})]
    assert recap_summary._build_dialogue(lines) == ""


def test_build_bot_dialogue_reads_the_bot_chat_log_format():
    # The reading room's own record (bot_chats/<conv>.jsonl, routes/reading_room.py):
    # bare user lines, API-shaped assistant events, plumbing in between.
    lines = [
        json.dumps({"type": "user", "text": "hi keeper", "ts": "x", "journaled": True}),
        json.dumps({"type": "assistant", "message": {"role": "assistant",
                    "content": [{"type": "text", "text": "hello there"}]}}),
        json.dumps({"type": "result", "subtype": "success", "total_cost_usd": 0.01}),
        json.dumps({"type": "off-record-gap", "ts": "x"}),
    ]
    dialogue = recap_summary.build_bot_dialogue(lines)
    assert dialogue == "User: hi keeper\nAssistant: hello there"


def test_bot_dialogue_flows_through_get_summary(tmp_path, monkeypatch, inline_spawn):
    fake = fake_claude("Chatting with the keeper.")
    monkeypatch.setattr(recap_summary, "_run_claude", fake)
    path = tmp_path / "conv.jsonl"
    path.write_text(json.dumps({"type": "user", "text": "hi"}) + "\n")
    recap_summary.get_summary("bot:conv-1", path,
                              builder=recap_summary.build_bot_dialogue)
    assert len(fake.calls) == 1
    assert "User: hi" in fake.calls[0]
    assert recap_summary.get_summary("bot:conv-1", path) == "Chatting with the keeper."


# --- integration with routes/terminal.py's _session_recap -------------------

def test_session_recap_prefers_summary_over_last_output(monkeypatch, data_dir):
    from types import SimpleNamespace as NS
    from routes import terminal

    def fake_tmux(cmd_str):
        if cmd_str.startswith("list-panes"):
            return NS(stdout="123")
        if cmd_str.startswith("capture-pane"):
            return NS(stdout="")
        return NS(stdout="")

    monkeypatch.setattr(terminal, "_tmux", fake_tmux)
    monkeypatch.setattr(terminal, "_proc_ancestors", lambda pid: [pid])

    live = [{"pid": 123, "sessionId": "sess-1", "cwd": "/tmp/proj", "status": "idle", "updatedAt": 1}]

    transcript = data_dir / "t.jsonl"
    transcript.write_text(_assistant("last output text") + "\n")
    monkeypatch.setattr(terminal, "_transcript_path", lambda cwd, sid: transcript)
    monkeypatch.setattr(terminal, "_recap_cache", {})

    monkeypatch.setattr(recap_summary, "get_summary", lambda sid, path: "A concise Haiku summary.")

    entry = terminal._session_recap("chat", live)
    assert entry["recap"] == "A concise Haiku summary."
    assert entry["source"] == "summary"
    assert entry["updatedAt"] is not None


def test_session_recap_falls_back_to_last_output_without_summary(monkeypatch, data_dir):
    from types import SimpleNamespace as NS
    from routes import terminal

    def fake_tmux(cmd_str):
        if cmd_str.startswith("list-panes"):
            return NS(stdout="123")
        if cmd_str.startswith("capture-pane"):
            return NS(stdout="")
        return NS(stdout="")

    monkeypatch.setattr(terminal, "_tmux", fake_tmux)
    monkeypatch.setattr(terminal, "_proc_ancestors", lambda pid: [pid])

    live = [{"pid": 123, "sessionId": "sess-1", "cwd": "/tmp/proj", "status": "idle", "updatedAt": 1}]

    transcript = data_dir / "t.jsonl"
    transcript.write_text(_assistant("last output text") + "\n")
    monkeypatch.setattr(terminal, "_transcript_path", lambda cwd, sid: transcript)
    monkeypatch.setattr(terminal, "_recap_cache", {})

    monkeypatch.setattr(recap_summary, "get_summary", lambda sid, path: None)

    entry = terminal._session_recap("chat", live)
    assert entry["recap"] == "last output text"
    assert entry["source"] == "assistant"
