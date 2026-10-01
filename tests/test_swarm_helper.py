"""The swarm helper (swarm_helper.py), with the model call faked.

What these pin: a helper run is handed the current summaries plus what's new,
its answer REPLACES the summaries, each member's summary comes from a call of
its own (and a member with nothing new gets none), everything it read and
wrote is recorded, its messages go only to members, questions in its mailbox
are answered in the same run, and runs are debounced after member turns.
"""
import json

import pytest

import config
import peermail
import sqlstore
import store
import swarm_helper
import swarms
from routes import observatory


def _seed(*conv_ids, **fields):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        for cid in conv_ids:
            index[cid] = {"title": f"title {cid}", "lane": "coding", **fields}


@pytest.fixture
def swarm(data_dir, monkeypatch):
    """Two sessions that have talked, with the helper's model faked and no
    detached processes."""
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    _seed("2026-09-27.100000", "2026-09-27.110000")
    (store.DATA_DIR / "bot_chats" / "2026-09-27.100000.jsonl").write_text(
        json.dumps({"type": "user", "text": "build the pond page", "ts": "2026-09-27T10:00:00"}) + "\n")
    peermail.send("2026-09-27.110000", "I'm editing pond.py too", from_conv="2026-09-27.100000")
    [swarm_id] = swarms.sync()
    return swarm_id


def _fake_model(monkeypatch, answer, seen=None, sessions=None):
    """Fake both kinds of call: the swarm's own, and the one per member.
    `sessions` collects each member call's input."""
    def call(text):
        if seen is not None:
            seen.append(text)
        return answer, 0.01

    def call_session(text):
        if sessions is not None:
            sessions.append(text)
        conv = text.split()[2]
        return {"summary": f"summary of {conv}"}, 0.001
    monkeypatch.setattr(swarm_helper, "_call_model", call)
    monkeypatch.setattr(swarm_helper, "_call_session", call_session)


def test_a_run_reads_whats_new_and_replaces_the_summaries(swarm, monkeypatch):
    seen, sessions = [], []
    _fake_model(monkeypatch, {
        "name": "Pond page", "summary": "Two agents building the pond page.",
        "differences": ["both edit pond.py"], "messages": []}, seen, sessions)
    swarm_helper.run(swarm)
    assert "build the pond page" in seen[0]            # what's new was handed over
    assert "I'm editing pond.py too" in seen[0]        # and the messages between them
    [card] = swarms.overview()
    assert (card["name"], card["summary"]) == ("Pond page", "Two agents building the pond page.")
    member = next(m for m in card["members"] if m["conv"] == "2026-09-27.100000")
    assert member["summary"] == "summary of 2026-09-27.100000"
    # the next run sees only what's new since that summary
    swarm_helper.run(swarm)
    assert "build the pond page" not in seen[1].split("summary of 2026-09-27.100000")[1]


def test_each_member_is_summarised_by_a_call_of_its_own(swarm, monkeypatch):
    """Her ask: "If these aren't written by parallel individual sonnet
    sessions, make these parallel and individual." One call per member that
    did something, holding that member's activity alone; a member with
    nothing new gets no call and keeps its summary; and one member's call
    failing costs nobody else theirs."""
    (store.DATA_DIR / "bot_chats" / "2026-09-27.110000.jsonl").write_text(
        json.dumps({"type": "user", "text": "refactor the pond", "ts": "2026-09-27T10:05:00"}) + "\n")
    sessions = []
    _fake_model(monkeypatch, {"name": "N", "summary": "S", "messages": []}, sessions=sessions)
    swarm_helper.run(swarm)
    assert len(sessions) == 2
    first = next(t for t in sessions if "2026-09-27.100000" in t)
    assert "build the pond page" in first and "refactor the pond" not in first
    # Nothing new for either: the next run makes no member call at all.
    swarm_helper.run(swarm)
    assert len(sessions) == 2
    # One member's call fails: the other's summary is still replaced.
    for conv, ask in (("2026-09-27.100000", "add a heron"), ("2026-09-27.110000", "add a frog")):
        with open(store.DATA_DIR / "bot_chats" / f"{conv}.jsonl", "a") as f:
            f.write(json.dumps({"type": "user", "text": ask, "ts": swarm_helper._now()}) + "\n")

    def flaky(text):
        if "add a frog" in text:
            raise RuntimeError("model down")
        return {"summary": "now adding a heron"}, 0.001
    monkeypatch.setattr(swarm_helper, "_call_session", flaky)
    swarm_helper.run(swarm)
    by_conv = {m["conv"]: m["summary"] for m in swarms.overview()[0]["members"]}
    assert by_conv == {"2026-09-27.100000": "now adding a heron",
                       "2026-09-27.110000": "summary of 2026-09-27.110000"}


def test_every_run_is_recorded_in_full(swarm, monkeypatch):
    _fake_model(monkeypatch, {"name": "N", "summary": "S", "messages": []})
    swarm_helper.run(swarm, trigger="formed")
    conn = sqlstore.open_db()
    [(trigger, text, output, cost)] = conn.execute(
        "SELECT trigger, input, output, cost_usd FROM swarm_helper_runs").fetchall()
    conn.close()
    assert trigger == "formed" and "# Swarm" in text and json.loads(output)["name"] == "N"
    assert cost == pytest.approx(0.011)                # the swarm's call and one member's
    helper = swarm_helper.ensure_helper(swarm)
    log = [json.loads(l) for l in (store.DATA_DIR / "bot_chats" / f"{helper}.jsonl").read_text().splitlines()]
    assert [e["type"] for e in log] == ["assistant", "result"]


def test_its_messages_go_only_to_members(swarm, monkeypatch):
    sent = []
    monkeypatch.setattr(observatory, "peer_send",
                        lambda frm, to, text, mode="inject": sent.append((to, text)))
    _fake_model(monkeypatch, {"name": "N", "summary": "S", "messages": [
        {"to": "2026-09-27.110000", "text": "pull before you edit pond.py"},
        {"to": "stranger", "text": "hello"}]})
    swarm_helper.run(swarm)
    assert sent == [("2026-09-27.110000", "pull before you edit pond.py")]


def test_a_question_to_the_helper_is_answered_in_its_run(swarm, monkeypatch):
    helper = swarm_helper.ensure_helper(swarm)
    question = peermail.send(helper, "what is everyone doing?", kind="B")
    seen = []
    _fake_model(monkeypatch, {"name": "N", "summary": "S", "messages": [
        {"to": "owner", "text": "two agents on the pond page"}]}, seen)
    swarm_helper.run(swarm, "message", [question["id"]])
    assert "from owner: what is everyone doing?" in seen[0]
    log = (store.DATA_DIR / "bot_chats" / f"{helper}.jsonl").read_text()
    assert "what is everyone doing?" in log and "two agents on the pond page" in log


def test_the_helper_is_not_a_member_of_its_own_swarm(swarm, monkeypatch):
    helper = swarm_helper.ensure_helper(swarm)
    peermail.send("2026-09-27.100000", "note", from_conv=helper)
    assert swarms.sync() == {swarm: {"2026-09-27.100000", "2026-09-27.110000"}}


def test_runs_after_member_turns_are_debounced(swarm, monkeypatch):
    spawned = []
    monkeypatch.setattr(swarm_helper, "_spawn", lambda sid, trig, q=(): spawned.append(trig) or True)
    monkeypatch.setattr(config, "SWARM_HELPER_MIN_SEC", 300)
    assert swarm_helper.poke(swarm, "turn") is True
    helper = swarm_helper.ensure_helper(swarm)
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["helper_last_run"] = swarm_helper._now()
    assert swarm_helper.poke(swarm, "turn") is False       # too soon: noted, not run
    assert store.read("bot_chats/index", {})[helper]["helper_pending"] == "turn"
    assert spawned == ["turn"]
