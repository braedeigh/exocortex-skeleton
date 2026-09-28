"""Messages reaching agents: mid-turn, between turns, and by interrupting.

These drive the real turn loop (routes/observatory.py _run_turn) against a
stub agent that speaks Claude Code's streaming-input format: it reads its
first message, starts a "tool", and while that tool runs it listens for more
input — echoing each message it reads (as `--replay-user-messages` does) and
answering it in the same turn. That's the behaviour checked against the real
CLI when this was built; the stub pins our side of it.
"""
import json
import stat
import threading
import time

import pytest

import config
import peermail
import store
from routes import observatory
from tests.test_observatory_routes import (  # noqa: F401  (bot_client is a fixture)
    bot_client, _seed_conv, _conv_log)


STREAM_STUB = """#!/usr/bin/env python3
import json, sys, select, time
def say(obj):
    print(json.dumps(obj), flush=True)
first = json.loads(sys.stdin.readline())["message"]["content"]
say({"type": "system", "subtype": "init", "session_id": "sid-s"})
say({"type": "user", "isReplay": True, "message": {"role": "user", "content": first}})
say({"type": "assistant", "message": {"role": "assistant", "content": [
    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "sleep"}}]}})
# The "tool" runs for up to {hold} seconds; any message arriving meanwhile is
# read, echoed and answered before the turn's result.
heard = []
deadline = time.time() + {hold}
while time.time() < deadline:
    ready, _, _ = select.select([sys.stdin], [], [], 0.1)
    if ready:
        line = sys.stdin.readline()
        if not line:
            break
        text = json.loads(line)["message"]["content"]
        say({"type": "user", "isReplay": True, "message": {"role": "user", "content": text}})
        heard.append(text)
        break
say({"type": "user", "message": {"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"}]}})
say({"type": "assistant", "message": {"role": "assistant", "content": [
    {"type": "text", "text": "first: " + first + " | heard: " + " / ".join(heard)}]}})
say({"type": "result", "subtype": "success", "session_id": "sid-s", "total_cost_usd": 0.01})
# A real agent waits for more input until it's closed; so does this one.
sys.stdin.read()
"""


@pytest.fixture
def streaming(bot_client, tmp_path, monkeypatch):
    def make(hold=5):
        stub = tmp_path / "claude-stream"
        stub.write_text(STREAM_STUB.replace("{hold}", str(hold)))
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
        monkeypatch.setattr(observatory, "CLAUDE_BIN", str(stub))
        monkeypatch.setattr(config, "TURN_STREAM_INPUT", True)
        monkeypatch.setattr(observatory.app_config, "TURN_STREAM_INPUT", True)
        monkeypatch.setattr(observatory, "_INBOX_POLL_SEC", 0.1)
        return stub
    return make


def _run(conv_id, text):
    """Start a turn through the real send path and wait for it to finish."""
    result = observatory.begin_turn(conv_id, text)
    assert result["ok"], result
    deadline = time.time() + 20
    while time.time() < deadline:
        if not store.read("bot_chats/index", {})[conv_id].get("running"):
            return
        time.sleep(0.05)
    raise AssertionError("turn never finished")


def _seed_two():
    a = _seed_conv("2026-09-27.100000")
    b = _seed_conv("2026-09-27.110000")
    return a, b


def test_a_message_is_handed_in_mid_turn_and_answered_in_the_same_turn(streaming):
    streaming(hold=5)
    a, b = _seed_two()
    threading.Timer(0.5, lambda: observatory.peer_send(a, b, "store.py changed")).start()
    _run(b, "do the thing")

    log = _conv_log(b)
    peer = [e for e in log if e.get("type") == "peer"]
    assert peer and peer[0]["direction"] == "in" and peer[0]["from_conv"] == a
    reply = json.dumps([e for e in log if e.get("type") == "assistant"],
                       ensure_ascii=False)
    assert "heard: [A · " in reply and "store.py changed" in reply
    # the echo is how the turn knew it was read — it isn't logged a second time
    assert not [e for e in log if e.get("isReplay")]
    assert peermail.waiting(b) == []
    # and the chain depth moved on the recipient
    assert store.read("bot_chats/index", {})[b]["peer_hops"] == 1


def test_the_sender_sees_its_message_as_a_card(streaming):
    streaming(hold=0)
    a, b = _seed_two()
    observatory.peer_send(a, b, "heads up")
    out = [e for e in _conv_log(a) if e.get("type") == "peer"]
    assert out[0]["direction"] == "out" and out[0]["to_conv"] == b


def test_a_message_to_an_idle_session_wakes_it(bot_client, monkeypatch):
    started = []
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, *a: started.append(text) or True)
    a, b = _seed_two()
    row = observatory.peer_send(a, b, "wake up")
    assert row["started"] is True
    assert "wake up" in started[0] and "[A · " in started[0]


def test_everything_waiting_goes_out_together_labelled(bot_client, monkeypatch):
    started = []
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, *a: started.append(text) or True)
    a, b = _seed_two()
    with store.mutate("bot_chats/index", {}) as index:
        index[b]["running"] = True
    monkeypatch.setattr(observatory, "_effective_running",
                        lambda conv_id, entry: bool(entry.get("running")))
    peermail.send(b, "fix the chevron", kind="B")
    observatory.peer_send(a, b, "store.py changed", mode="queue")
    assert started == []                       # busy: both wait
    with store.mutate("bot_chats/index", {}) as index:
        index[b]["running"] = False
    assert observatory.drain_inbox(b) is True
    assert "[B · " in started[0] and "fix the chevron" in started[0]
    assert "store.py changed" in started[0]
    log = _conv_log(b)
    assert [e["type"] for e in log][-2:] == ["user", "peer"]


def test_a_held_message_waits_for_her_release(bot_client, monkeypatch):
    started = []
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, *a: started.append(text) or True)
    # Nothing holds a message any more; an old held one is set up by hand.
    monkeypatch.setattr(observatory, "_effective_running", lambda c, e: True)
    a, b = _seed_two()
    row = observatory.peer_send(a, b, "loop again")
    from tests.test_peermail import _hold
    _hold(row)
    monkeypatch.setattr(observatory, "_effective_running",
                        lambda c, e: bool(e.get("running")))
    assert started == []
    resp = bot_client.post(f"/api/observatory/peer/{row['id']}/release")
    assert resp.status_code == 200
    assert started and "loop again" in started[0]
    assert [e for e in _conv_log(a) if e.get("type") == "peer-status"]


def test_an_interrupt_stops_the_turn_and_restarts_with_the_message(streaming, monkeypatch):
    streaming(hold=15)
    a, b = _seed_two()
    t0 = time.time()
    threading.Timer(0.5, lambda: observatory.peer_send(
        a, b, "stop, the plan changed", mode="interrupt")).start()
    # the restart is a second turn; record it rather than run it
    restarted = []
    real_begin = observatory.begin_turn

    def spy(conv_id, text, *args, **kw):
        if kw.get("batch"):
            restarted.append(observatory.peermail.compose(kw["batch"]))
            return {"ok": True}
        return real_begin(conv_id, text, *args, **kw)

    monkeypatch.setattr(observatory, "begin_turn", spy)
    _run(b, "long job")
    assert time.time() - t0 < 10               # killed, not waited out
    # the end-of-turn drain restarts it (give its thread a moment to get there)
    deadline = time.time() + 5
    while not restarted and time.time() < deadline:
        observatory.drain_inbox(b)
        time.sleep(0.05)
    assert restarted and "stop, the plan changed" in restarted[0]
    # stopped on purpose, so no red card
    assert "last_error" not in store.read("bot_chats/index", {})[b]


def test_queue_only_keeps_messages_out_until_the_turn_ends(streaming, monkeypatch):
    streaming(hold=2)
    # hold the end-of-turn drain, so what's waiting can be looked at
    monkeypatch.setattr(observatory, "drain_inbox", lambda *a, **k: False)
    a, b = _seed_two()
    peermail.set_policy(b, "queue-only")
    threading.Timer(0.3, lambda: peermail.send(b, "later please", from_conv=a)).start()
    _run(b, "work")
    reply = json.dumps([e for e in _conv_log(b) if e.get("type") == "assistant"])
    assert "later please" not in reply
    assert [r["text"] for r in peermail.waiting(b)] == ["later please"]


def test_her_inbox_route_starts_an_idle_session_and_lists_waiting(bot_client, monkeypatch):
    started = []
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, *a: started.append(text) or True)
    a, b = _seed_two()
    resp = bot_client.post(f"/api/observatory/conversation/{b}/inbox", json={"text": "hi"})
    assert resp.get_json()["started"] is True and started == ["hi"]
    # busy now (the fake host never clears it): the next one waits, and can be taken back
    monkeypatch.setattr(observatory, "_effective_running", lambda c, e: True)
    resp = bot_client.post(f"/api/observatory/conversation/{b}/inbox", json={"text": "and this"})
    assert resp.get_json()["started"] is False
    waiting = bot_client.get(f"/api/observatory/conversation/{b}/inbox").get_json()["waiting"]
    assert [w["text"] for w in waiting] == ["and this"]
    mid = waiting[0]["id"]
    assert bot_client.delete(f"/api/observatory/conversation/{b}/inbox/{mid}").status_code == 200
    assert bot_client.delete(f"/api/observatory/conversation/{b}/inbox/{mid}").status_code == 409


def test_a_turn_records_context_size_and_final_output_per_model_call(bot_client, tmp_path):
    """The final output count exists only in the live stream, so the turn loop
    writes it down (docs/swarms.md, stage 1), and keeps the session's current
    context size on its index entry for the self-continuing cap."""
    cid = _seed_conv("2026-09-27.120000")
    log_path = store.DATA_DIR / "bot_chats" / f"{cid}.jsonl"
    open_calls = {}
    with open(log_path, "a") as log:
        observatory._note_model_call({"type": "stream_event", "event": {
            "type": "message_start", "message": {"id": "msg_9", "model": "claude-opus-5-5",
                "usage": {"input_tokens": 2, "cache_creation_input_tokens": 10,
                          "cache_read_input_tokens": 120000}}}}, open_calls, log, cid)
        observatory._note_model_call({"type": "stream_event", "event": {
            "type": "message_delta", "usage": {"output_tokens": 300,
                "output_tokens_details": {"thinking_tokens": 200}}}}, open_calls, log, cid)
    entry = store.read("bot_chats/index", {})[cid]
    assert entry["context_tokens"] == 120012
    assert entry["context_model"] == "claude-opus-5-5"
    [line] = _conv_log(cid)
    assert line["type"] == "call-usage" and line["message_id"] == "msg_9"
    assert (line["output_tokens"], line["thinking_tokens"]) == (300, 200)
