"""Swarms (swarms.py): who belongs together, and how a swarm keeps its identity.

What these pin: two sessions that exchanged one message are a swarm; a chain
(a↔b, b↔c) is ONE swarm even though a and c never spoke; a continuation stays
in its parent's swarm, but a handoff alone makes no swarm; a swarm keeps its
number as it grows; two swarms that get linked become one, the older
absorbing the younger; a swarm nothing holds together any more is dissolved
and its helper archived, as is the helper of an absorbed swarm.

And placements (the room helper's, swarms.place): a placement overrides the
messages sent before it, so it can split a swarm, release a session or move
it between swarms; a message sent after it links again; unplace restores;
a line of work is found whole; helpers' messages never link anyone.
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


def test_a_handoff_alone_makes_no_swarm(data_dir):
    _seed("a")
    _seed("a2", spawned_from="a", spawned_via="continue")
    _seed("a3", spawned_from="a2", spawned_via="continue")
    assert swarms.sync() == {}
    assert swarms.swarm_of("a2") is None


def test_a_chain_of_handoffs_rides_along_with_its_swarm(data_dir):
    _seed("a", "b")
    _seed("a2", spawned_from="a", spawned_via="continue")
    _seed("a3", spawned_from="a2", spawned_via="continue")
    peermail.send("b", "hi", from_conv="a3")
    live = swarms.sync()
    assert list(live.values()) == [{"a", "a2", "a3", "b"}]


def test_a_stored_handoff_only_swarm_is_dissolved(data_dir):
    import sqlstore
    _seed("a")
    _seed("a2", spawned_from="a", spawned_via="continue")
    _seed("h", role="swarm_helper", swarm_id=1)
    conn = sqlstore.open_db()
    conn.execute("INSERT INTO swarms (id, created_at, updated_at, lane, helper_conv)"
                 " VALUES (1, 'x', 'x', 'coding', 'h')")
    conn.executemany("INSERT INTO swarm_members (swarm_id, conv, joined_at) VALUES (1, ?, 'x')",
                     [("a",), ("a2",)])
    conn.commit()
    conn.close()
    assert swarms.sync() == {}
    assert swarms.swarm_of("a") is None
    assert store.read("bot_chats/index", {})["h"].get("archived")


def test_an_absorbed_swarms_helper_is_archived(data_dir):
    _seed("a", "b", "x", "y")
    peermail.send("b", "hi", from_conv="a")
    [older] = swarms.sync()
    peermail.send("y", "hi", from_conv="x")
    younger = next(sid for sid in swarms.sync() if sid != older)
    _seed("h_old", role="swarm_helper", swarm_id=older)
    _seed("h_young", role="swarm_helper", swarm_id=younger)
    peermail.send("x", "bridge", from_conv="b")
    swarms.sync()
    index = store.read("bot_chats/index", {})
    assert not index["h_old"].get("archived")
    assert index["h_young"].get("archived")


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


def _backdate_pins(conv_ids, at="2000-01-01T00:00:00"):
    """Make placements older than every message, as if they were made long ago."""
    import sqlstore
    conn = sqlstore.open_db()
    conn.executemany("UPDATE swarm_pins SET at = ? WHERE conv = ?", [(at, c) for c in conv_ids])
    conn.commit()
    conn.close()


def _bridged_swarm():
    """a-b and x-y, glued into one swarm by one message b→x."""
    _seed("a", "b", "x", "y")
    peermail.send("b", "hi", from_conv="a")
    peermail.send("y", "hi", from_conv="x")
    peermail.send("x", "bridge", from_conv="b")
    [swarm_id] = swarms.sync()
    return swarm_id


def test_a_placement_overrides_old_messages_and_splits_a_swarm(data_dir):
    old = _bridged_swarm()
    new = swarms.new_swarm("coding")
    swarms.place(["x", "y"], new)
    live = swarms.sync()
    assert live == {old: {"a", "b"}, new: {"x", "y"}}


def test_a_message_after_the_placement_links_again(data_dir):
    old = _bridged_swarm()
    new = swarms.new_swarm("coding")
    swarms.place(["x", "y"], new)
    _backdate_pins(["x", "y"])
    peermail.send("x", "back again", from_conv="a")
    live = swarms.sync()
    assert live == {old: {"a", "b", "x", "y"}}


def test_release_makes_a_session_work_alone(data_dir):
    _seed("a", "b", "c")
    peermail.send("b", "hi", from_conv="a")
    peermail.send("c", "hi", from_conv="b")
    [swarm_id] = swarms.sync()
    swarms.place(["c"], None)
    assert swarms.sync() == {swarm_id: {"a", "b"}}
    assert swarms.swarm_of("c") is None


def test_join_moves_a_session_between_swarms(data_dir):
    _seed("a", "b", "x", "y", "z")
    peermail.send("b", "hi", from_conv="a")
    [first] = swarms.sync()
    peermail.send("y", "hi", from_conv="x")
    peermail.send("z", "hi", from_conv="y")
    second = next(sid for sid in swarms.sync() if sid != first)
    swarms.place(["z"], first)
    assert swarms.sync() == {first: {"a", "b", "z"}, second: {"x", "y"}}


def test_unplace_puts_the_old_links_back(data_dir):
    old = _bridged_swarm()
    new = swarms.new_swarm("coding")
    before = swarms.place(["x", "y"], new)
    assert before == {"x": None, "y": None}
    swarms.unplace(before)
    assert swarms.sync() == {old: {"a", "b", "x", "y"}}


def test_a_line_of_work_is_every_continuation_before_and_after(data_dir):
    _seed("a", "other")
    _seed("a2", spawned_from="a", spawned_via="continue")
    _seed("a3", spawned_from="a2", spawned_via="continue")
    index = store.read("bot_chats/index", {})
    assert swarms.line_of_work("a2", index) == {"a", "a2", "a3"}
    assert swarms.line_of_work("other", index) == {"other"}


def test_a_room_helpers_messages_link_nobody(data_dir):
    _seed("a", "b")
    _seed("room", role="room_helper", room="coding")
    peermail.send("a", "you two should talk", from_conv="room")
    peermail.send("b", "you two should talk", from_conv="room")
    assert swarms.sync() == {}
