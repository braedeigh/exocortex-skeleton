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


def test_request_input_files_several_questions_as_a_list(data_dir):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"title": "worker"}
    payload, status = rr.request_input("c1", [" Sqlite or postgres? ", "", "Keep the old route?"])
    entry = store.read("bot_chats/index", {})["c1"]
    assert status == 200
    assert entry["awaiting_questions"] == ["Sqlite or postgres?", "Keep the old route?"]
    # the older readers still get one line of text they can show
    assert entry["awaiting_input"] == "Sqlite or postgres?\nKeep the old route?"


def test_filing_again_replaces_the_earlier_questions(data_dir):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"title": "worker"}
    rr.request_input("c1", ["first?", "second?"])
    rr.request_input("c1", ["only this one?"])
    assert store.read("bot_chats/index", {})["c1"]["awaiting_questions"] == ["only this one?"]


def test_request_input_caps_how_many_questions(data_dir):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"title": "worker"}
    rr.request_input("c1", [f"q{i}?" for i in range(40)])
    entry = store.read("bot_chats/index", {})["c1"]
    assert len(entry["awaiting_questions"]) == rr._REQUEST_INPUT_MAX_COUNT


def test_a_list_of_only_blanks_is_refused(data_dir):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"title": "worker"}
    payload, status = rr.request_input("c1", ["  ", ""])
    assert status == 400


def test_every_session_turn_is_told_when_to_stop(data_dir):
    cmd = rr._build_cmd({"conv_id": "c1", "allowed_tools": []}, None)
    prompt = cmd[cmd.index("--append-system-prompt") + 1]
    assert "scripts/request_input.py" in prompt and "Don't stop to ask for approval" in prompt


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


def test_a_send_clears_the_question_list_too(bot_client):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"bot": "keeper", "started": rr._now(), "last_at": rr._now(),
                       "claude_session_id": None, "cost_usd": 0.0, "title": "asker",
                       "journal": False, "cwd": str(store.BUILD_DIR),
                       "allowed_tools": list(rr._BUILDER_TOOLS),
                       "awaiting_input": "a?\nb?", "awaiting_questions": ["a?", "b?"]}
    _drain(bot_client.post("/api/observatory/conversation/c1/send",
                           json={"text": "a: yes, b: no"}))
    assert "awaiting_questions" not in store.read("bot_chats/index", {})["c1"]


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


# --- a cleared question is handed back to the agent ---------------------------
# Her next send clears the card whether or not it answers the questions — she
# may be asking about something else — so the agent is told what was open and
# re-files what's still unanswered. The transcript keeps her words alone.

def _seed_asker(**fields):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c1"] = {"bot": "keeper", "started": rr._now(), "last_at": rr._now(),
                       "claude_session_id": None, "cost_usd": 0.0, "title": "asker",
                       "journal": False, "cwd": str(store.BUILD_DIR),
                       "allowed_tools": list(rr._BUILDER_TOOLS), **fields}


def test_reopen_note_is_empty_when_nothing_was_open():
    assert rr._reopen_note([]) == ""
    assert rr._reopen_note([""]) == ""


def test_reopen_note_lists_the_cleared_questions():
    note = rr._reopen_note(["Public repo?", "Keep the old route?"])
    assert "1. Public repo?" in note and "2. Keep the old route?" in note
    assert "request_input.py" in note


def test_her_send_hands_the_cleared_questions_to_the_agent(bot_client, monkeypatch):
    _seed_asker(awaiting_input="Public repo?", awaiting_questions=["Public repo?"])
    told = []
    monkeypatch.setattr(rr, "_spawn_host", lambda config, text, *a, **k: told.append(text) or True)
    result = rr.begin_turn("c1", "fix the swarm bug")
    assert result["ok"]
    assert told[0].startswith("fix the swarm bug")
    assert "1. Public repo?" in told[0]
    transcript = (store.DATA_DIR / "bot_chats" / "c1.jsonl").read_text()
    assert "Public repo?" not in transcript


def test_a_send_with_nothing_open_reaches_the_agent_unchanged(bot_client, monkeypatch):
    _seed_asker()
    told = []
    monkeypatch.setattr(rr, "_spawn_host", lambda config, text, *a, **k: told.append(text) or True)
    rr.begin_turn("c1", "go")
    assert told == ["go"]


# --- an answer handed into a running turn clears them too ---------------------
# Her answer from the roster's orange card goes through the mailbox. If the
# session is still mid-turn it's handed in between steps (_deliver_midturn),
# never passing begin_turn — and that path has to take the card down too.

import io

import peermail


class _FakeProc:
    def __init__(self):
        self.stdin = io.StringIO()


def _hand_in_waiting(conv_id):
    """Run one mailbox check against a turn that's open for input; return
    what the agent was handed."""
    proc = _FakeProc()
    turn_input = rr._TurnInput(proc)
    log_path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    rr._deliver_midturn(proc, conv_id, log_path, turn_input)
    return [json.loads(l)["message"]["content"]
            for l in proc.stdin.getvalue().splitlines()]


def test_her_answer_handed_in_mid_turn_clears_the_questions(data_dir):
    _seed_asker(running=True, awaiting_input="Public repo?",
                awaiting_questions=["Public repo?"])
    peermail.send("c1", "public", kind="B")
    told = _hand_in_waiting("c1")
    entry = store.read("bot_chats/index", {})["c1"]
    assert "awaiting_questions" not in entry and "awaiting_input" not in entry
    # the agent reads her answer, plus what it cleared
    assert told[0].startswith("public") and "1. Public repo?" in told[0]
    # the transcript keeps her words alone
    transcript = (store.DATA_DIR / "bot_chats" / "c1.jsonl").read_text()
    assert "Public repo?" not in transcript


def test_an_agents_message_handed_in_mid_turn_leaves_the_questions(data_dir):
    _seed_asker(running=True, awaiting_input="Public repo?",
                awaiting_questions=["Public repo?"])
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["c2"] = {"title": "peer"}
    peermail.send("c1", "store.py changed", from_conv="c2")
    told = _hand_in_waiting("c1")
    assert store.read("bot_chats/index", {})["c1"]["awaiting_questions"] == ["Public repo?"]
    assert "Public repo?" not in told[0]


def test_her_mid_turn_message_stops_a_done_countdown(data_dir):
    _seed_asker(running=True, done_at=rr._now(), closes_at=rr._now())
    peermail.send("c1", "one more thing", kind="B")
    told = _hand_in_waiting("c1")
    assert told == ["one more thing"]
    assert "done_at" not in store.read("bot_chats/index", {})["c1"]


def test_a_set_refiled_during_the_hand_in_stays_up(data_dir):
    entry = {"awaiting_questions": ["new?"], "awaiting_input": "new?"}
    cleared = rr._her_message_arrived("c1", entry, expected=["old?"])
    assert cleared == [] and entry["awaiting_questions"] == ["new?"]


# --- the chat keeps every set, above her answer ------------------------------
# The index flag is "what's open now" and comes off when she replies; the
# transcript is the record. Each filing writes a `questions` line where it was
# asked, so reloading the chat after she answered still shows every set, in
# order, above her reply.

def test_filed_questions_stay_in_the_chat_above_her_answer(bot_client):
    _seed_asker()
    rr.request_input("c1", ["Sqlite or postgres?", "Keep the old route?"])
    rr.request_input("c1", ["Only: sqlite or postgres?"])
    _drain(bot_client.post("/api/observatory/conversation/c1/send",
                           json={"text": "sqlite"}))
    events = bot_client.get("/api/observatory/conversation/c1?lean=1").get_json()["events"]
    said = [(e["type"], e.get("questions") or e.get("text")) for e in events
            if e.get("type") in ("questions", "user") and "message" not in e]
    assert said == [
        ("questions", ["Sqlite or postgres?", "Keep the old route?"]),
        ("questions", ["Only: sqlite or postgres?"]),
        ("user", "sqlite"),
    ]
    # ...while the open flag itself is gone, so the card stops glowing
    assert "awaiting_questions" not in store.read("bot_chats/index", {})["c1"]


def test_a_refused_filing_leaves_nothing_in_the_chat(data_dir):
    _seed_asker()
    rr.request_input("c1", ["  "])
    log = store.DATA_DIR / "bot_chats" / "c1.jsonl"
    assert not log.exists() or "questions" not in log.read_text()
