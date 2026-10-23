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


def test_every_turn_starts_with_claude_codes_auto_memory_off(data_dir, monkeypatch):
    """No hidden MEMORY.md may load into a session, whether or not the turn
    belongs to a conversation."""
    started = []

    class FakeProc:
        def __init__(self):
            self.stdin = open(os.devnull, "w")

    def fake_popen(command, **kw):
        started.append(kw["env"])
        return FakeProc()
    monkeypatch.setattr(rr.subprocess, "Popen", fake_popen)
    monkeypatch.delenv("EXOCORTEX_CONV_ID", raising=False)
    config = {"cwd": str(store.BUILD_DIR), "allowed_tools": ["Read"]}
    rr._spawn({**config, "conv_id": "c1"}, "hi", None)
    rr._spawn(config, "hi", None)
    assert [env.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY") for env in started] == ["1", "1"]
    assert started[0]["EXOCORTEX_CONV_ID"] == "c1" and "EXOCORTEX_CONV_ID" not in started[1]


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
    """Run one mailbox check against a turn that's open for input, then let
    the agent read what it was handed (its echo); return what it was handed."""
    proc = _FakeProc()
    turn_input = rr._TurnInput(proc)
    log_path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    rr._deliver_midturn(proc, conv_id, log_path, turn_input)
    told = [json.loads(l)["message"]["content"]
            for l in proc.stdin.getvalue().splitlines()]
    for text in told:
        rr._record_read(conv_id, log_path, turn_input, text)
    return told


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


# --- her answer came by another route: the session takes its own set down ----
# She answered in a different session's chat and that session relayed her words.
# Nothing of hers arrives here, and an agent's message clears nothing, so the
# session that filed the questions withdraws them itself through the same door
# (request_input.py --answered), saying where her answer came from.

from scripts import request_input as request_input_script


def _chat_lines(client, conv_id):
    """The question-related lines of a chat, in order, as the page loads them."""
    events = client.get(f"/api/observatory/conversation/{conv_id}?lean=1").get_json()["events"]
    return [e for e in events if e.get("type") in ("questions", "questions-withdrawn", "peer")]


def _roster_entry(client, conv_id):
    sessions = client.get("/api/observatory").get_json()["sessions"]
    return next(c for c in sessions if c["id"] == conv_id)


def test_a_relayed_answer_lets_the_session_take_its_question_down(bot_client, monkeypatch, capsys):
    _seed_asker(running=True)
    with store.mutate("bot_chats/index", {}) as index:
        index["c2"] = {"title": "the session she answered in"}
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "c1")
    assert request_input_script.main(["--about", "Wiring the alert.",
                                      "--question", "Who gets told: (a), (b) or (c)?"]) == 0

    # A peer relays her answer. An agent's message clears nothing: still orange.
    peermail.send("c1", 'She answered in my chat: "A)"', from_conv="c2")
    _hand_in_waiting("c1")
    assert _roster_entry(bot_client, "c1")["awaiting_questions"] == ["Who gets told: (a), (b) or (c)?"]

    # The session withdraws it: the roster stops showing it as waiting...
    assert request_input_script.main(["--answered", ' relayed by c2: she said "A)" ']) == 0
    waiting = _roster_entry(bot_client, "c1")
    assert "awaiting_questions" not in waiting and "awaiting_input" not in waiting
    # ...and the chat keeps the question, the relay, and why it came down.
    lines = _chat_lines(bot_client, "c1")
    assert [l["type"] for l in lines] == ["questions", "peer", "questions-withdrawn"]
    assert lines[2]["questions"] == ["Who gets told: (a), (b) or (c)?"]
    assert lines[2]["source"] == 'relayed by c2: she said "A)"'

    # A question filed afterwards is a new one, and stays up.
    assert request_input_script.main(["--about", "Next step.", "And the next thing?"]) == 0
    assert _roster_entry(bot_client, "c1")["awaiting_questions"] == ["And the next thing?"]
    capsys.readouterr()


def test_withdrawing_leaves_a_done_countdown_and_saved_for_later_alone(data_dir):
    # She hasn't spoken HERE, so only the questions come off — unlike a message
    # of hers, which also stops a done countdown and un-saves the session.
    _seed_asker(saved_at="2026-10-01T00:00:00", done_at="2026-10-01T00:00:00")
    rr.request_input("c1", ["Public repo?"])
    payload, status = rr.withdraw_questions("c1", "she told the helper: public")
    entry = store.read("bot_chats/index", {})["c1"]
    assert status == 200 and payload["withdrawn"] == ["Public repo?"]
    assert entry["saved_at"] and entry["done_at"]


@pytest.mark.parametrize("arguments", [
    ["--answered"],                      # no source at all
    ["--answered", "   "],               # a blank source
    ["--answered", "from c2", "extra"],  # more than one line after the flag
])
def test_a_withdrawal_that_does_not_say_where_is_refused(data_dir, monkeypatch, capsys, arguments):
    _seed_asker()
    rr.request_input("c1", ["Public repo?"])
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "c1")
    assert request_input_script.main(arguments) != 0
    capsys.readouterr()
    # the question is still up, and nothing was filed as a question named "--answered"
    assert store.read("bot_chats/index", {})["c1"]["awaiting_questions"] == ["Public repo?"]
    assert "questions-withdrawn" not in (store.DATA_DIR / "bot_chats" / "c1.jsonl").read_text()


def test_withdrawing_with_nothing_open_is_refused_and_leaves_no_record(data_dir):
    _seed_asker()
    payload, status = rr.withdraw_questions("c1", "she said so")
    assert status == 409
    log = store.DATA_DIR / "bot_chats" / "c1.jsonl"
    assert not log.exists() or "questions-withdrawn" not in log.read_text()
    assert rr.withdraw_questions("ghost", "she said so")[1] == 404


# --- every set carries its context and its choices ---------------------------
# She reads the card away from the chat, so a filing says what the session is
# building (--about) and offers options she can tap, the recommended one first.
# The CLI refuses anything it doesn't understand rather than filing it.

def _file(*arguments):
    """Run the CLI as the session c1 would; return (exit code, printed JSON)."""
    import contextlib
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = request_input_script.main(list(arguments))
    return code, json.loads(out.getvalue())


def test_a_set_with_about_and_options_reaches_the_roster_and_the_chat(bot_client, monkeypatch):
    _seed_asker()
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "c1")
    code, _ = _file("--about", "Moving the lint step. It runs out of memory on big diffs.",
                    "--question", "Where should lint run?",
                    "--option", "In CI only — local commits stay fast, errors show later",
                    "--option", "Pre-commit, capped — catches it early, costs a few seconds",
                    "--question", "Anything else before I ship?")
    assert code == 0
    waiting = _roster_entry(bot_client, "c1")
    assert waiting["awaiting_about"] == "Moving the lint step. It runs out of memory on big diffs."
    assert waiting["awaiting_options"] == [
        [{"label": "In CI only", "detail": "local commits stay fast, errors show later",
          "recommended": True},
         {"label": "Pre-commit, capped", "detail": "catches it early, costs a few seconds",
          "recommended": False}],
        [],
    ]
    # older readers still see the plain list
    assert waiting["awaiting_questions"] == ["Where should lint run?", "Anything else before I ship?"]
    line = _chat_lines(bot_client, "c1")[-1]
    assert line["about"] == waiting["awaiting_about"]
    assert line["options"] == waiting["awaiting_options"]


@pytest.mark.parametrize("arguments, says", [
    (["--question", "Public repo?"], "--about is required"),          # no context
    (["Public repo?"], "--about is required"),                         # the old bare form
    (["--about", "x", "--question", "Q?", "--opton", "typo"], "unknown flag"),
    (["--about", "x", "--option", "A — a", "--question", "Q?"], "comes after the --question"),
    (["--about", "x", "--question", "Q?", "--option", "only one"], "one option isn't a choice"),
    (["--about", "x", "--question"], "needs a value"),
])
def test_a_malformed_filing_is_refused_with_the_right_form_and_files_nothing(
        data_dir, monkeypatch, arguments, says):
    _seed_asker()
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "c1")
    code, printed = _file(*arguments)
    assert code != 0
    assert says in printed["error"] and "--about" in printed["error"] and "--option" in printed["error"]
    assert "awaiting_questions" not in store.read("bot_chats/index", {})["c1"]
    log = store.DATA_DIR / "bot_chats" / "c1.jsonl"
    assert not log.exists() or "questions" not in log.read_text()


def test_her_send_clears_the_about_and_options_with_the_questions(bot_client):
    _seed_asker()
    rr.request_input("c1", ["Where should lint run?"], about="Moving lint.",
                     options=[["CI — fast", "Pre-commit — early"]])
    _drain(bot_client.post("/api/observatory/conversation/c1/send", json={"text": "1. CI"}))
    entry = store.read("bot_chats/index", {})["c1"]
    assert not {"awaiting_questions", "awaiting_input", "awaiting_about",
                "awaiting_options"} & set(entry)


def test_withdrawing_takes_the_about_and_options_down_too(data_dir):
    _seed_asker()
    rr.request_input("c1", ["Q?"], about="ctx", options=[["A — a", "B — b"]])
    rr.withdraw_questions("c1", "relayed by c2: she said A")
    entry = store.read("bot_chats/index", {})["c1"]
    assert "awaiting_about" not in entry and "awaiting_options" not in entry


# --- less churn: the same set is a no-op, one more question is added ---------

def _question_lines():
    log = store.DATA_DIR / "bot_chats" / "c1.jsonl"
    return [json.loads(l) for l in log.read_text().splitlines()
            if json.loads(l).get("type") == "questions"]


def test_filing_the_open_set_again_writes_nothing_new(data_dir):
    _seed_asker()
    first = rr.request_input("c1", ["Q?"], about="ctx", options=[["A — a", "B — b"]])
    again, status = rr.request_input("c1", ["Q?"], about="ctx", options=[["A — a", "B — b"]])
    assert status == 200 and again.get("unchanged") is True and "unchanged" not in first[0]
    assert len(_question_lines()) == 1
    # a real change is filed as usual
    rr.request_input("c1", ["Q?"], about="ctx, now with more", options=[["A — a", "B — b"]])
    assert len(_question_lines()) == 2


def test_add_grows_the_open_set_and_keeps_its_about(data_dir, monkeypatch):
    _seed_asker()
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "c1")
    _file("--about", "Moving lint.", "--question", "Where?", "--option", "CI — a", "--option", "Hook — b")
    code, printed = _file("--add", "--question", "And the old config?")
    entry = store.read("bot_chats/index", {})["c1"]
    assert code == 0
    assert entry["awaiting_questions"] == ["Where?", "And the old config?"]
    assert entry["awaiting_about"] == "Moving lint."
    assert [len(o) for o in entry["awaiting_options"]] == [2, 0]
    # one line for the grown set, after the first
    assert [l["questions"] for l in _question_lines()] == [["Where?"], ["Where?", "And the old config?"]]


def test_add_with_nothing_open_is_refused_without_context(data_dir):
    _seed_asker()
    payload, status = rr.request_input("c1", ["Q?"], add=True)
    assert status == 400 and "--about" in payload["error"]


def test_filing_lists_what_the_rest_of_the_swarm_is_already_asking(data_dir, monkeypatch):
    _seed_asker()
    with store.mutate("bot_chats/index", {}) as index:
        index["c2"] = {"title": "lint fixer", "awaiting_questions": ["Raise the lint memory cap?"],
                       "awaiting_input": "Raise the lint memory cap?"}
        index["c3"] = {"title": "elsewhere", "awaiting_questions": ["Unrelated?"],
                       "awaiting_input": "Unrelated?"}
    import swarms
    monkeypatch.setattr(swarms, "swarm_of", lambda conv: 7 if conv in ("c1", "c2") else None)
    monkeypatch.setattr(swarms, "overview_members", lambda swarm_id: ["c1", "c2"])
    payload, _ = rr.request_input("c1", ["Raise the lint memory cap?"], about="Lint OOM.")
    assert payload["open_nearby"] == [{"conv": "c2", "title": "lint fixer",
                                       "questions": ["Raise the lint memory cap?"]}]
