"""The room helper (room_helper.py), with the model call and the messages faked.

What these pin: a run reads the room — swarms, clusters, sessions working
alone — and its moves are made: form makes a swarm of solo sessions, split
takes a cluster out into its own swarm, release puts a session back to work
alone, and a continuation always moves with its session. Every move is
recorded and can be undone, and a move she undid isn't made again. The
moved sessions are told once, queued, never interrupted. A move that doesn't
fit is refused and reported. A closed swarm is left out of the room it reads
and can't be joined. A swarm is two sessions still working: one left on its
own — the others finished or released — closes the swarm and works alone,
a handoff doesn't count as a second, and a second session opens it again. Its chat never resumes and is never continued,
and its seed is the room.
"""
import json

import pytest

import continuation
import helper_chat
import peermail
import room_helper
import sqlstore
import store
import swarm_helper
import swarms
from routes import observatory


def _seed(*conv_ids, **fields):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        for cid in conv_ids:
            index[cid] = {"title": f"title {cid}", "lane": "coding",
                          "last_at": "2026-09-27T10:00:00", **fields}


@pytest.fixture
def room(data_dir, monkeypatch):
    """A room with no detached processes, no helper runs, and the messages
    the room helper sends collected instead of delivered."""
    sent = []
    monkeypatch.setattr(room_helper, "_spawn", lambda *a, **k: True)
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    monkeypatch.setattr(observatory, "peer_send",
                        lambda frm, to, text, mode="inject": sent.append((frm, to, text, mode)))
    return sent


def _fake_model(monkeypatch, answer, seen=None, sessions=None):
    """Fake both kinds of call: the room's own, and the one per solo session.
    `sessions` collects each session call's input."""
    def call(text, room):
        if seen is not None:
            seen.append(text)
        return answer, 0.02

    def call_session(text):
        if sessions is not None:
            sessions.append(text)
        return {"summary": "Builds the pond page."}, 0.001
    monkeypatch.setattr(room_helper, "_call_model", call)
    monkeypatch.setattr(swarm_helper, "_call_session", call_session)


def _bridged_swarm():
    """a-b and x-y, glued into one swarm by one message b→x."""
    _seed("a", "b", "x", "y")
    peermail.send("b", "hi", from_conv="a")
    peermail.send("y", "hi", from_conv="x")
    peermail.send("x", "bridge", from_conv="b")
    [swarm_id] = swarms.sync()
    return swarm_id


def test_a_run_reads_the_room_and_forms_a_swarm(room, monkeypatch):
    _seed("s1", "s2", "s3")
    (store.DATA_DIR / "bot_chats" / "s1.jsonl").write_text(
        json.dumps({"type": "user", "text": "build the pond page", "ts": "2026-09-27T10:00:00"}) + "\n")
    seen, sessions = [], []
    _fake_model(monkeypatch, {
        "overview": "Two sessions on the pond page.",
        "moves": [{"kind": "form", "convs": ["s1", "s2"], "reason": "both on the pond page",
                   "message": "You're both building the pond page."}]}, seen, sessions)
    room_helper.run("coding")
    assert "build the pond page" in seen[0]
    # s1's summary came from a call of its own; s2 and s3 did nothing, so no call.
    assert len(sessions) == 1 and "Session s1" in sessions[0]
    [swarm_id] = swarms.sync()
    assert set(swarms.overview_members(swarm_id)) == {"s1", "s2"}
    assert swarms.swarm_of("s3") is None
    assert sorted(to for _, to, _, _ in room) == ["s1", "s2"]
    assert {mode for *_, mode in room} == {"queue"}
    conn = sqlstore.open_db()
    summary = conn.execute("SELECT summary FROM session_summaries WHERE conv = 's1'").fetchone()
    [(kind, convs)] = conn.execute("SELECT kind, convs FROM room_moves").fetchall()
    conn.close()
    assert summary == ("Builds the pond page.",)
    assert (kind, json.loads(convs)) == ("form", ["s1", "s2"])


def test_every_run_is_recorded_and_posted(room, monkeypatch):
    _seed("s1")
    _fake_model(monkeypatch, {"overview": "Quiet.", "moves": []})
    room_helper.run("coding")
    conn = sqlstore.open_db()
    [(text, output, cost)] = conn.execute(
        "SELECT input, output, cost_usd FROM room_helper_runs").fetchall()
    conn.close()
    assert "s1" in text and json.loads(output)["overview"] == "Quiet." and cost == 0.02
    helper = room_helper.find_helper("coding")
    chat = (store.DATA_DIR / "bot_chats" / f"{helper}.jsonl").read_text()
    assert "Quiet." in chat


def test_split_takes_a_cluster_into_its_own_swarm(room):
    old = _bridged_swarm()
    move = room_helper.execute("coding", "split", ["x", "y"], old, "unrelated work")
    assert swarms.sync() == {old: {"a", "b"}, move["to_swarm"]: {"x", "y"}}
    assert move["from_swarm"] == old


def test_a_one_session_split_is_a_release(room):
    old = _bridged_swarm()
    move = room_helper.execute("coding", "split", ["y"], old, "done with it")
    assert move["kind"] == "release"
    assert swarms.swarm_of("y") is None and swarms.swarm_of("x") == old


def test_a_continuation_moves_with_its_session(room):
    _seed("a", "b", "c")
    _seed("c2", spawned_from="c", spawned_via="continue")
    peermail.send("b", "hi", from_conv="a")
    peermail.send("c2", "hi", from_conv="b")
    [swarm_id] = swarms.sync()
    move = room_helper.execute("coding", "release", ["c2"], None, "separate work")
    assert move["convs"] == ["c", "c2"]
    assert swarms.sync() == {swarm_id: {"a", "b"}}


def test_undo_puts_the_sessions_back(room):
    old = _bridged_swarm()
    move = room_helper.execute("coding", "split", ["x", "y"], old, "unrelated work")
    room_helper.undo(move["id"])
    assert swarms.sync() == {old: {"a", "b", "x", "y"}}
    assert room_helper.recent_moves("coding")[0]["undone_at"]


def test_a_move_she_undid_is_not_made_again(room):
    old = _bridged_swarm()
    move = room_helper.execute("coding", "split", ["x", "y"], old, "unrelated work")
    room_helper.undo(move["id"])
    with pytest.raises(room_helper.MoveError):
        room_helper.execute("coding", "split", ["x", "y"], old, "unrelated work",
                            by="room_helper")
    # ...unless she asks for it herself
    room_helper.execute("coding", "split", ["x", "y"], old, "she asked", by="owner")


def test_a_move_that_doesnt_fit_is_refused_and_reported(room, monkeypatch):
    old = _bridged_swarm()
    _fake_model(monkeypatch, {"overview": "o", "moves": [
        {"kind": "form", "convs": ["a", "x"], "reason": "r", "message": "m"},
        {"kind": "join", "convs": ["a"], "swarm": 999, "reason": "r", "message": "m"}]})
    room_helper.run("coding")
    assert swarms.sync() == {old: {"a", "b", "x", "y"}}
    assert room == []
    chat = (store.DATA_DIR / "bot_chats" / f"{room_helper.find_helper('coding')}.jsonl").read_text()
    assert "not made" in chat


def test_the_overview_shows_each_swarms_clusters(room):
    _bridged_swarm()
    text = room_helper.room_overview("coding")
    assert "cluster" in text and "Sessions working alone" in text


def test_it_runs_only_when_the_room_has_moved_on(room):
    _seed("s1", last_at="2026-09-27T10:00:00")
    assert room_helper.due("coding")
    helper = room_helper.ensure_room_helper("coding")
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["helper_last_run"] = "2026-09-27T11:00:00"
    assert not room_helper.due("coding")


def test_its_chat_never_continues_and_seeds_from_the_room(room):
    _seed("s1")
    helper = room_helper.ensure_room_helper("coding")
    entry = store.read("bot_chats/index", {})[helper]
    entry["context_tokens"] = 10 ** 9
    assert not continuation.due(entry)
    seed = helper_chat.seed_text(helper, entry)
    assert "room helper" in seed and "Sessions working alone" in seed and "s1" in seed
    assert entry["allowed_tools"] == swarm_helper.HELPER_TOOLS


def _closed_swarm():
    """a and b talked, and both have finished."""
    _seed("a", "b", done_at="2026-09-28T09:00:00")
    peermail.send("b", "hi", from_conv="a")
    [swarm_id] = swarms.sync()
    return swarm_id


def test_a_closed_swarm_is_left_out_of_the_room(room):
    swarm_id = _closed_swarm()
    text = room_helper.room_overview("coding")
    assert f"Swarm {swarm_id}" not in text and "(no swarms)" in text


def test_nobody_is_joined_into_a_closed_swarm(room):
    swarm_id = _closed_swarm()
    _seed("s1")
    with pytest.raises(room_helper.MoveError):
        room_helper.execute("coding", "join", ["s1"], swarm_id, "same work")


def test_a_session_saved_for_later_is_left_where_it_is(room):
    _seed("s1", "s2")
    _seed("parked", saved_at="2026-09-30T10:00:00")
    assert "parked" not in room_helper.solo_sessions("coding", store.read("bot_chats/index", {}), [])
    with pytest.raises(room_helper.MoveError):
        room_helper.execute("coding", "form", ["s1", "parked"], None, "same work",
                            by="room_helper")
    # ...unless she moves it herself
    room_helper.execute("coding", "form", ["s1", "parked"], None, "she asked", by="owner")


# --- A swarm is at least two sessions still working -------------------------------

def test_a_swarm_down_to_one_working_session_closes_and_it_works_alone(room):
    """Her ask: "a swarm to be a minimum of 2 sessions and a helper." When the
    other member finishes, the swarm closes, its helper posts the closing
    check, and the one still working is back among the sessions working alone.
    A second session messaging it opens the same swarm again."""
    _seed("a", "b")
    peermail.send("b", "hi", from_conv="a")
    [swarm_id] = swarms.sync()
    helper = swarm_helper.ensure_helper(swarm_id)
    with store.mutate("bot_chats/index", {}) as index:
        index["b"]["done_at"] = "2026-09-30T10:00:00"
    index = store.read("bot_chats/index", {})
    assert room_helper.open_swarms("coding") == []
    assert room_helper.solo_sessions("coding", index, []) == ["a"]
    swarm_helper.tick()
    report = (store.DATA_DIR / "bot_chats" / f"{helper}.jsonl").read_text()
    assert "Closing check" in report and "still working, on its own now" in report
    _seed("c")
    peermail.send("a", "can I use your parser?", from_conv="c")
    [card] = room_helper.open_swarms("coding")
    assert card["id"] == swarm_id and {m["conv"] for m in card["members"]} == {"a", "b", "c"}


def test_a_release_that_leaves_one_session_closes_the_swarm(room):
    _seed("a", "b")
    peermail.send("b", "hi", from_conv="a")
    swarms.sync()
    move = room_helper.execute("coding", "release", ["b"], None, "separate work", by="cli")
    assert move["left_alone"] == ["a"]
    assert "closed" in room_helper.closed_line(move)
    assert room_helper.open_swarms("coding") == []
    assert sorted(room_helper.solo_sessions("coding", store.read("bot_chats/index", {}), [])) \
        == ["a", "b"]
    assert "working alone now" in next(text for _, to, text, _ in room if to == "a")
    room_helper.undo(move["id"])
    [card] = room_helper.open_swarms("coding")
    assert {m["conv"] for m in card["members"]} == {"a", "b"}


def test_a_handoff_is_not_a_second_session(room):
    """a hands its work to a2: still two lines of work (a's and b's), so the
    swarm stays open. When b finishes, a and a2 are one line — it closes."""
    _seed("a", "b")
    peermail.send("b", "hi", from_conv="a")
    [swarm_id] = swarms.sync()
    with store.mutate("bot_chats/index", {}) as index:
        index["a"].update(continued_by="a2", archived="2026-09-30T10:00:00")
    _seed("a2", spawned_from="a", spawned_via="continue")
    assert [c["id"] for c in room_helper.open_swarms("coding")] == [swarm_id]
    with store.mutate("bot_chats/index", {}) as index:
        index["b"]["done_at"] = "2026-09-30T11:00:00"
    assert room_helper.open_swarms("coding") == []
    with pytest.raises(room_helper.MoveError):
        room_helper.execute("coding", "form", ["a2", "a"], None, "one line of work")


def test_a_swarm_whose_members_were_all_released_is_gone_from_the_room(room):
    """Releasing every member once left an empty swarm drawn as a bubble of
    0 sessions for good: sync never dissolved a swarm it saw no members of."""
    _seed("a", "b")
    peermail.send("b", "hi", from_conv="a")
    swarms.sync()
    room_helper.execute("coding", "release", ["a", "b"], None, "both done with it", by="cli")
    assert swarms.overview() == []
    assert sorted(room_helper.solo_sessions("coding", store.read("bot_chats/index", {}), [])) \
        == ["a", "b"]
