"""Server-side journal capture in terminal_send().

Bradie journals by sending Chat-tab messages, which POST /api/terminal/send;
the route types the text into a tmux pane running the Keeper session. A
UserPromptSubmit hook in the vault also mints a journal card from that same
prompt -- but the hook's process-launch snapshot goes stale on a long-lived
tmux pane and silently stops seeing prompts. So the card is minted HERE, at
the server, before anything is typed into tmux: capture can't depend on the
terminal process staying alive.

Same fixture shape as test_terminal_routes.py's term_client (fake `_tmux`
capturing command strings), plus a fake `_run_stream` (terminal.py's
cross-import of routes/cards.py's shell-out helper) recording (args, stdin)
pairs, and a tmp CONTENT_DIR so the `.keeper/` sidecar files land somewhere
throwaway.
"""
import hashlib
import json
from types import SimpleNamespace

import pytest
from flask import Flask

import store
from routes import terminal


class FakeStream:
    """Stand-in for routes.cards._run_stream: records every call and returns
    a controllable CompletedProcess-shaped result."""

    def __init__(self):
        self.calls = []  # [(args_tuple, stdin), ...]
        self.returncode = 0
        self.stdout = "2026-07-14.1200b\n"
        self.stderr = ""

    def __call__(self, *args, stdin=None):
        self.calls.append((args, stdin))
        return SimpleNamespace(returncode=self.returncode, stdout=self.stdout, stderr=self.stderr)


@pytest.fixture
def term_client(data_dir, tmp_path, monkeypatch):
    """Minimal app with terminal routes; tmux calls and stream.py calls are
    captured, not run."""
    calls = []

    def fake_tmux(cmd_str):
        calls.append(cmd_str)
        return SimpleNamespace(stdout="")

    monkeypatch.setattr(terminal, "_tmux", fake_tmux)

    content_dir = tmp_path / "content"
    content_dir.mkdir()
    monkeypatch.setattr(store, "CONTENT_DIR", content_dir)

    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    monkeypatch.setattr(terminal, "UPLOAD_DIR", upload_dir)

    stream = FakeStream()
    monkeypatch.setattr(terminal, "_run_stream", stream)

    app = Flask(__name__)
    app.config.update(TESTING=True)
    terminal.register(app)
    client = app.test_client()
    client._tmux_calls = calls
    client._stream = stream
    client._content_dir = content_dir
    client._upload_dir = upload_dir
    return client


def _send(client, **body):
    return client.post("/api/terminal/send", json=body)


def _ui_captured(client):
    path = client._content_dir / ".keeper" / "ui_captured.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().strip().splitlines()]


def _capture_failures(client):
    path = client._content_dir / ".keeper" / "capture-failures.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().strip().splitlines()]


# --- chat session + enter:true ------------------------------------------------

def test_chat_send_with_enter_mints_one_card_and_notes_ui_capture(term_client):
    resp = _send(term_client, session="chat", text="hello journal", enter=True)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["journaled"] is True

    assert len(term_client._stream.calls) == 1
    args, stdin = term_client._stream.calls[0]
    assert args == ("record", "--who", "B")
    assert stdin == "hello journal"

    captured = _ui_captured(term_client)
    assert len(captured) == 1
    assert captured[0]["sha256"] == hashlib.sha256("hello journal".strip().encode()).hexdigest()

    # tmux still received the literal text and the Enter
    assert any("send-keys -t chat -l 'hello journal'" in c for c in term_client._tmux_calls)
    assert any(c == "send-keys -t chat Enter" for c in term_client._tmux_calls)


# --- non-keeper session ---------------------------------------------------

def test_non_keeper_session_does_not_mint(term_client):
    resp = _send(term_client, session="dev", text="dev tooling chatter", enter=True)
    assert resp.status_code == 200
    assert resp.get_json()["journaled"] is False
    assert term_client._stream.calls == []
    assert _ui_captured(term_client) == []


# --- enter:false accumulation ---------------------------------------------

def test_enter_false_accumulates_then_enter_true_mints_the_concatenation(term_client):
    r1 = _send(term_client, session="chat", text="[uploaded: /tmp/photo.jpg]", enter=False)
    assert r1.status_code == 200
    assert r1.get_json()["journaled"] is False
    assert term_client._stream.calls == []  # nothing minted yet

    r2 = _send(term_client, session="chat", text=" here's the photo", enter=True)
    assert r2.status_code == 200
    assert r2.get_json()["journaled"] is True

    assert len(term_client._stream.calls) == 1
    args, stdin = term_client._stream.calls[0]
    assert stdin == "[uploaded: /tmp/photo.jpg] here's the photo"

    captured = _ui_captured(term_client)
    assert len(captured) == 1
    expected_hash = hashlib.sha256("[uploaded: /tmp/photo.jpg] here's the photo".strip().encode()).hexdigest()
    assert captured[0]["sha256"] == expected_hash

    # pending entry cleared -- a third send with enter:true and no new text
    # sees nothing pending and doesn't re-mint the old content
    pending = store.read("terminal_pending.json", {})
    assert "chat" not in pending


# --- slash commands are operator control, not journal content ------------

def test_slash_command_does_not_mint(term_client):
    resp = _send(term_client, session="chat", text="/endsession", enter=True)
    assert resp.status_code == 200
    assert resp.get_json()["journaled"] is False
    assert term_client._stream.calls == []
    assert _ui_captured(term_client) == []


# --- long paste (>500 chars) ------------------------------------------------

def test_long_paste_journals_full_text_and_hashes_the_uploaded_ref(term_client):
    text = "a" * 600
    resp = _send(term_client, session="chat", text=text, enter=True)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["journaled"] is True
    assert "saved_to" in body

    args, stdin = term_client._stream.calls[0]
    assert stdin == text  # the card carries the FULL text, not the pane ref

    ref = f"[uploaded: {body['saved_to']}]"
    captured = _ui_captured(term_client)
    assert len(captured) == 1
    assert captured[0]["sha256"] == hashlib.sha256(ref.strip().encode()).hexdigest()

    # the pane itself only ever saw the short ref, never the full paste
    assert any(f"send-keys -t chat -l '{ref}'" in c for c in term_client._tmux_calls)
    assert not any(text in c for c in term_client._tmux_calls)


# --- stream.py failure -----------------------------------------------------

def test_stream_failure_still_types_but_does_not_journal_or_dedup(term_client):
    term_client._stream.returncode = 1
    term_client._stream.stderr = "boom: vault locked"

    resp = _send(term_client, session="chat", text="will fail to mint", enter=True)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["journaled"] is False

    # tmux still got the text -- capture failing must never block typing
    assert any("send-keys -t chat -l 'will fail to mint'" in c for c in term_client._tmux_calls)

    # no dedup hash recorded on failure (a later hook mint must not be deduped away)
    assert _ui_captured(term_client) == []

    failures = _capture_failures(term_client)
    assert len(failures) == 1
    assert failures[0]["prompt"] == "will fail to mint"
    assert failures[0]["source"] == "terminal_send"
    assert "boom" in failures[0]["error"]


# --- bare Enter key submits pre-typed pane content -------------------------

def test_bare_enter_key_mints_pending_text(term_client):
    r1 = _send(term_client, session="chat", text="typed before the enter key", enter=False)
    assert r1.get_json()["journaled"] is False
    assert term_client._stream.calls == []

    resp = term_client.post("/api/terminal/send", json={"session": "chat", "key": "Enter"})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["journaled"] is True

    assert len(term_client._stream.calls) == 1
    args, stdin = term_client._stream.calls[0]
    assert args == ("record", "--who", "B")
    assert stdin == "typed before the enter key"

    # the Enter still reaches tmux
    assert any(c == "send-keys -t chat Enter" for c in term_client._tmux_calls)

    # pending cleared
    pending = store.read("terminal_pending.json", {})
    assert "chat" not in pending
