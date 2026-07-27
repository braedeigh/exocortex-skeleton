"""Request-for-input door (routes/observatory.py + scripts/request_input.py).

A running session raises a STRUCTURAL "I need you" flag instead of the app
inferring it from prose:

- `request_input(conv_id, question)` sets `awaiting_input` on the index entry
  (the one validated entry point the agent CLI shares) — unknown conv 404s,
  empty question 400s;
- the roster (`bots_list`) surfaces it for free (it rides the meta spread, the
  same way `draft` does), so the Orchestra card can glow orange;
- the owner's next send CLEARS it (her answer is the reply);
- the turn learns its own conversation id from EXOCORTEX_CONV_ID, injected into
  the spawn — that's what lets a session know which conversation to flag.
"""
import json
import os
import stat

import pytest
from flask import Flask

import recap_summary
import store
from routes import observatory as rr, terminal


# --- the validated function: set + validation -------------------------------

def test_request_input_sets_the_flag(data_dir):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"title": "worker", "running": True}
    payload, status = rr.request_input("c1", "  Which db — sqlite or postgres?  ")
    assert status == 200 and payload["ok"] is True
    # stored trimmed
    assert store.read("bot_chats/index", {})["c1"]["awaiting_input"] == "Which db — sqlite or postgres?"


def test_request_input_unknown_conversation_404s(data_dir):
    rr._chats_dir()
    payload, status = rr.request_input("ghost", "anyone there?")
    assert status == 404 and "error" in payload


def test_request_input_empty_question_400s_and_writes_nothing(data_dir):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"title": "worker"}
    payload, status = rr.request_input("c1", "   ")
    assert status == 400
    assert "awaiting_input" not in store.read("bot_chats/index", {})["c1"]


def test_request_input_rejects_a_malformed_conv_id(data_dir):
    payload, status = rr.request_input("../etc/passwd", "q?")
    assert status == 400


def test_request_input_caps_a_runaway_question(data_dir):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"title": "worker"}
    rr.request_input("c1", "x" * 5000)
    assert len(store.read("bot_chats/index", {})["c1"]["awaiting_input"]) == rr._REQUEST_INPUT_MAX


# --- the roster surfaces it, and a send clears it ---------------------------

STUB = """#!/usr/bin/env python3
import sys, json, os
sys.stdin.read()
with open({env_log!r}, "a") as f:
    f.write(json.dumps(os.environ.get("EXOCORTEX_CONV_ID")) + "\\n")
print(json.dumps({{"type": "system", "subtype": "init", "session_id": "sid-1"}}))
print(json.dumps({{"type": "result", "subtype": "success",
    "session_id": "sid-1", "total_cost_usd": 0.0}}))
"""


@pytest.fixture
def bot_client(data_dir, tmp_path, monkeypatch):
    env_log = tmp_path / "env.jsonl"
    stub = tmp_path / "claude-stub"
    stub.write_text(STUB.format(env_log=str(env_log)))
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(rr, "CLAUDE_BIN", str(stub))
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    monkeypatch.setattr(recap_summary, "_spawn", lambda fn: None)
    monkeypatch.setattr(terminal, "_capture_journal",
                        lambda *a, **k: True)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    rr.register(app)
    client = app.test_client()
    client._env_log = env_log
    return client


def _drain(resp):
    # consume the SSE stream so the detached turn finishes
    return resp.get_data(as_text=True)


def test_roster_surfaces_awaiting_input(bot_client):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"bot": "keeper", "title": "asker", "running": True,
                       "last_at": rr._now(), "awaiting_input": "which one?"}
    sessions = bot_client.get("/api/observatory").get_json()["sessions"]
    conv = next(c for c in sessions if c["id"] == "c1")
    assert conv["awaiting_input"] == "which one?"


def test_a_send_clears_awaiting_input(bot_client):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"bot": "keeper", "started": rr._now(), "last_at": rr._now(),
                       "claude_session_id": None, "cost_usd": 0.0, "title": "asker",
                       "journal": False, "cwd": str(store.BUILD_DIR),
                       "allowed_tools": list(rr._BUILDER_TOOLS),
                       "awaiting_input": "which one?"}
    _drain(bot_client.post("/api/observatory/conversation/c1/send",
                           json={"text": "use sqlite"}))
    assert "awaiting_input" not in store.read("bot_chats/index", {})["c1"]


def test_the_turn_gets_its_conv_id_in_the_environment(bot_client):
    # EXOCORTEX_CONV_ID is what lets scripts/request_input.py know which
    # conversation to flag — assert the spawned turn actually receives it.
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"bot": "keeper", "started": rr._now(), "last_at": rr._now(),
                       "claude_session_id": None, "cost_usd": 0.0, "title": "w",
                       "journal": False, "cwd": str(store.BUILD_DIR),
                       "allowed_tools": list(rr._BUILDER_TOOLS)}
    _drain(bot_client.post("/api/observatory/conversation/c1/send",
                           json={"text": "go"}))
    seen = [json.loads(l) for l in bot_client._env_log.read_text().splitlines()]
    assert seen == ["c1"]
