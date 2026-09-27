"""The agents' mailbox rules (peermail.py) — no turns, no processes.

What these pin: a message is stored and delivered exactly once, the owner's
messages are never held, the two brakes hold a runaway agent chain, the
recipient can only ever soften a sender's knock, and what the model reads is
labelled by who sent it.
"""
import pytest

import config
import peermail
import store


def _seed(*conv_ids, **fields):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        for cid in conv_ids:
            index[cid] = {"title": f"title {cid}", "lane": "coding", **fields}


def test_a_message_waits_until_claimed_once(data_dir):
    _seed("a", "b")
    row = peermail.send("b", "hello", from_conv="a")
    assert row["status"] == "waiting" and row["hops"] == 1
    assert [r["id"] for r in peermail.waiting("b")] == [row["id"]]
    assert len(peermail.claim([row], "injected")) == 1
    # a second deliverer racing the first gets nothing
    assert peermail.claim([row], "batched") == []
    assert peermail.waiting("b") == []


def test_unclaim_puts_a_failed_delivery_back(data_dir):
    _seed("a", "b")
    row = peermail.send("b", "hello", from_conv="a")
    won = peermail.claim([row], "batched")
    peermail.unclaim(won)
    assert [r["id"] for r in peermail.waiting("b")] == [row["id"]]


def test_the_hop_brake_holds_a_long_agent_chain(data_dir, monkeypatch):
    monkeypatch.setattr(config, "PEER_MAX_HOPS", 2)
    _seed("a", "b", peer_hops=2)
    row = peermail.send("b", "again", from_conv="a")
    assert row["status"] == "held"
    assert "in a row" in row["held_reason"]
    assert peermail.waiting("b") == []


def test_the_owner_is_never_held_and_resets_the_chain(data_dir, monkeypatch):
    monkeypatch.setattr(config, "PEER_MAX_HOPS", 0)
    _seed("b", peer_hops=9)
    mine = peermail.send("b", "from her", kind="B")
    assert mine["status"] == "waiting"
    peermail.note_delivered("b", [mine])
    assert store.read("bot_chats/index", {})["b"]["peer_hops"] == 0


def test_the_daily_cap_holds_the_rest(data_dir, monkeypatch):
    monkeypatch.setattr(config, "PEER_DAILY_CAP", 1)
    _seed("a", "b")
    assert peermail.send("b", "one", from_conv="a")["status"] == "waiting"
    assert peermail.send("b", "two", from_conv="a")["status"] == "held"


def test_release_lets_a_held_message_through(data_dir, monkeypatch):
    monkeypatch.setattr(config, "PEER_MAX_HOPS", 0)
    _seed("a", "b")
    row = peermail.send("b", "held one", from_conv="a")
    assert peermail.release(row["id"])["status"] == "waiting"
    assert peermail.release(row["id"]) is None      # not held any more


@pytest.mark.parametrize("mode,policy,expected", [
    ("inject", "open", "inject"),
    ("interrupt", "open", "interrupt"),
    ("interrupt", "no-interrupt", "inject"),
    ("inject", "queue-only", "queue"),
    ("interrupt", "queue-only", "queue"),
    ("queue", "open", "queue"),
])
def test_the_recipient_can_only_soften_a_knock(mode, policy, expected):
    assert peermail.effective_mode(mode, policy) == expected


def test_she_can_take_back_only_her_own_waiting_message(data_dir):
    _seed("a", "b")
    hers = peermail.send("b", "mine", kind="B")
    theirs = peermail.send("b", "agent's", from_conv="a")
    assert peermail.cancel(theirs["id"], "b") is False
    assert peermail.cancel(hers["id"], "a") is False     # wrong session
    assert peermail.cancel(hers["id"], "b") is True
    assert [r["id"] for r in peermail.waiting("b")] == [theirs["id"]]


def test_refusals(data_dir):
    _seed("a")
    with pytest.raises(KeyError):
        peermail.send("nope", "hi", from_conv="a")
    with pytest.raises(ValueError):
        peermail.send("a", "hi", from_conv="a")          # itself
    with pytest.raises(ValueError):
        peermail.send("a", "x" * (peermail.TEXT_CAP + 1), kind="B")
    with pytest.raises(ValueError):
        peermail.send("a", "hi", kind="B", mode="shout")


def test_a_lone_owner_message_goes_in_as_typed(data_dir):
    _seed("b")
    row = peermail.send("b", "just me", kind="B")
    assert peermail.compose([row]) == "just me"


def test_a_mixed_batch_is_labelled_by_sender(data_dir):
    _seed("a", "b")
    hers = peermail.send("b", "fix the chevron", kind="B")
    theirs = peermail.send("b", "store.py changed", from_conv="a")
    text = peermail.compose([hers, theirs])
    assert text.index("[B · ") < text.index("fix the chevron")
    assert '[A · "title a" · coding · a]' in text
    assert "not the owner" in text
    assert "peers.py send a" in text
