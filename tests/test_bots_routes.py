"""The bot-surface pipe (routes/bots.py, design doc bot-surface-design).

Contracts pinned here:
- a send relays the claude stream-json events as SSE AND appends them to the
  owner's own conversation log (her record is the record);
- capture-first: a journaling bot mints the B card BEFORE claude is spawned;
- off-the-record (record: false) skips BOTH the journal mint and the log —
  the log gets only an explicit gap marker (Terra's amendment, 07-23);
- the second turn of a conversation resumes claude with the stored session id.

`claude` itself is a stub script (EXOCORTEX_CLAUDE_BIN / bots.CLAUDE_BIN)
that reads the prompt from stdin and prints canned NDJSON — the pipe is what's
under test, not the model.
"""
import json
import stat

import pytest
from flask import Flask

import store
from routes import bots, terminal


STUB = """#!/usr/bin/env python3
import sys, json
text = sys.stdin.read()
with open({argv_log!r}, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
print(json.dumps({{"type": "system", "subtype": "init", "session_id": "sid-1"}}))
print(json.dumps({{"type": "stream_event", "event": {{"type": "content_block_delta",
    "delta": {{"type": "text_delta", "text": "echo"}}}}}}))
print(json.dumps({{"type": "assistant", "message": {{"role": "assistant",
    "content": [{{"type": "text", "text": "echo: " + text}}]}}}}))
print(json.dumps({{"type": "result", "subtype": "success",
    "session_id": "sid-1", "total_cost_usd": 0.01}}))
"""


@pytest.fixture
def bot_client(data_dir, tmp_path, monkeypatch):
    """Minimal app with only bots routes; claude is the stub above; the
    journal mint is recorded, not run."""
    argv_log = tmp_path / "claude_argv.jsonl"
    stub = tmp_path / "claude-stub"
    stub.write_text(STUB.format(argv_log=str(argv_log)))
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(bots, "CLAUDE_BIN", str(stub))
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")

    mints = []
    monkeypatch.setattr(terminal, "_capture_journal",
                        lambda body, typed, tags=None: mints.append(body) or True)

    app = Flask(__name__)
    app.config.update(TESTING=True)
    bots.register(app)
    client = app.test_client()
    client._mints = mints
    client._argv_log = argv_log
    return client


def _send(client, **body):
    body.setdefault("text", "hello")
    return client.post("/api/bots/keeper/send", json=body)


def _sse_events(resp):
    out = []
    for chunk in resp.get_data(as_text=True).split("\n\n"):
        chunk = chunk.strip()
        if chunk.startswith("data: "):
            out.append(json.loads(chunk[len("data: "):]))
    return out


def _conv_log(conv_id):
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines()]


def test_send_streams_events_and_writes_her_own_log(bot_client):
    resp = _send(bot_client, text="hi keeper")
    assert resp.status_code == 200
    events = _sse_events(resp)
    conv_id = events[0]["conversation_id"]
    # relay: conv header, then the stub's four events (deltas included), done
    types = [e["type"] for e in events]
    assert types == ["conv", "system", "stream_event", "assistant", "result", "done"]
    assert "echo: hi keeper" in json.dumps(events[3])
    # her own record: user line + every claude event EXCEPT the token deltas
    # (stream_event is transport; the assistant message carries the text)
    log = _conv_log(conv_id)
    assert log[0]["type"] == "user" and log[0]["text"] == "hi keeper"
    assert [e["type"] for e in log[1:]] == ["system", "assistant", "result"]
    # index: session id + cost captured for the next resume
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["claude_session_id"] == "sid-1"
    assert meta["cost_usd"] == pytest.approx(0.01)


def test_journal_mints_before_claude_is_spawned(bot_client, monkeypatch):
    # If the spawn ran first, the mint recorder would still be empty when it
    # fires — assert the order explicitly by failing the spawn: the card must
    # already be minted even though claude never ran.
    def boom(*a, **k):
        raise OSError("no claude")
    monkeypatch.setattr(bots, "_spawn", boom)
    resp = _send(bot_client, text="a journal line")
    assert resp.status_code == 502
    assert bot_client._mints == ["a journal line"]


def test_off_record_skips_journal_and_log(bot_client):
    resp = _send(bot_client, text="when did i last...", record=False)
    events = _sse_events(resp)
    conv_id = events[0]["conversation_id"]
    # streams to the screen normally...
    assert any(e["type"] == "assistant" for e in events)
    # ...but mints nothing and persists nothing except the deliberate gap
    assert bot_client._mints == []
    log = _conv_log(conv_id)
    assert [e["type"] for e in log] == ["off-record-gap"]


def test_slash_commands_do_not_journal(bot_client):
    _send(bot_client, text="/endsession")
    assert bot_client._mints == []


def test_second_turn_resumes_stored_session(bot_client):
    first = _sse_events(_send(bot_client, text="turn one"))
    conv_id = first[0]["conversation_id"]
    # consume the stream so the turn (and the stub's argv write) completes
    _sse_events(_send(bot_client, text="turn two", conversation_id=conv_id))
    argvs = [json.loads(l) for l in bot_client._argv_log.read_text().splitlines()]
    assert not any("--resume" in a for a in argvs[0])
    assert "--resume" in argvs[1]
    assert argvs[1][argvs[1].index("--resume") + 1] == "sid-1"


def test_unknown_bot_404s_and_empty_text_400s(bot_client):
    assert bot_client.post("/api/bots/nope/send", json={"text": "x"}).status_code == 404
    assert _send(bot_client, text="  ").status_code == 400


def test_conversation_endpoint_round_trips(bot_client):
    events = _sse_events(_send(bot_client, text="hello there"))
    conv_id = events[0]["conversation_id"]
    resp = bot_client.get(f"/api/bots/conversation/{conv_id}")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["events"][0]["text"] == "hello there"
    assert data["meta"]["bot"] == "keeper"
    # roster lists the conversation under the keeper
    roster = bot_client.get("/api/bots").get_json()["bots"]
    keeper = next(b for b in roster if b["id"] == "keeper")
    assert any(c["id"] == conv_id for c in keeper["conversations"])
