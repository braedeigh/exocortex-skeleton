"""Swarms (swarms.py): who belongs together, and how a swarm keeps its identity.

What these pin: two sessions that exchanged one message are a swarm; a chain
(a↔b, b↔c) is ONE swarm even though a and c never spoke; a continuation stays
in its parent's swarm; a swarm keeps its number as it grows; two swarms that
get linked become one, the older absorbing the younger.
"""
import peermail
import store
import swarms


def _seed(*conv_ids, **fields):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        for cid in conv_ids:
            index[cid] = {"title": f"title {cid}", "lane": "coding", **fields}


def test_groups_are_connected_not_complete():
    found = swarms.groups([("a", "b"), ("b", "c"), ("x", "y"), ("solo", "solo")])
    assert sorted(sorted(g) for g in found) == [["a", "b", "c"], ["x", "y"]]


def test_one_message_makes_a_swarm(data_dir):
    _seed("a", "b", "c")
    peermail.send("b", "hi", from_conv="a")
    live = swarms.sync()
    assert list(live.values()) == [{"a", "b"}]
    assert swarms.swarm_of("c") is None


def test_a_swarm_keeps_its_number_as_it_grows(data_dir):
    _seed("a", "b", "c")
    peermail.send("b", "hi", from_conv="a")
    [first] = swarms.sync()
    peermail.send("c", "you too", from_conv="b")
    live = swarms.sync()
    assert live == {first: {"a", "b", "c"}}


def test_linking_two_swarms_merges_them_into_the_older(data_dir):
    _seed("a", "b", "x", "y")
    peermail.send("b", "hi", from_conv="a")
    [older] = swarms.sync()
    peermail.send("y", "hi", from_conv="x")
    swarms.sync()
    peermail.send("x", "bridge", from_conv="b")
    live = swarms.sync()
    assert live == {older: {"a", "b", "x", "y"}}
    assert swarms.swarm_of("y") == older


def test_a_continuation_stays_in_its_parents_swarm(data_dir):
    _seed("a", "b")
    _seed("a2", spawned_from="a", spawned_via="continue")
    peermail.send("b", "hi", from_conv="a")
    live = swarms.sync()
    assert list(live.values()) == [{"a", "b", "a2"}]


def test_overview_counts_members_by_state(data_dir):
    _seed("a", running=True)
    _seed("b", awaiting_input="which one?")
    _seed("c")
    peermail.send("b", "hi", from_conv="a")
    peermail.send("c", "hi", from_conv="b")
    [card] = swarms.overview()
    assert card["counts"] == {"working": 1, "silent": 1, "needs_input": 1}
    assert card["lane"] == "coding"
    assert {(link["from"], link["to"]) for link in card["links"]} == {("a", "b"), ("b", "c")}


def test_overview_names_which_member_continued_which(data_dir):
    _seed("a", "b")
    _seed("a2", spawned_from="a", spawned_via="continue")
    peermail.send("b", "hi", from_conv="a")
    [card] = swarms.overview()
    assert card["continues"] == [{"from": "a", "to": "a2"}]


def test_overview_marks_handed_off_and_archived_members_retired(data_dir):
    _seed("a", "b")
    _seed("c", archived="2026-09-27T19:00:00")
    _seed("a2", spawned_from="a", spawned_via="continue")
    peermail.send("b", "hi", from_conv="a")
    peermail.send("c", "hi", from_conv="b")
    [card] = swarms.overview()
    retired = {m["conv"] for m in card["members"] if m["retired"]}
    assert retired == {"a", "c"}
