"""Project rooms (project_rooms.py): which Coding sessions gather in a project.

What these pin, the way it's used: a session whose edits are in a git
worktree of a switched-on build lands in that build's room, and so does one
that only `cd`s there in Bash; a placement by hand beats the files; a
continuation stays in its parent's room; the app's own sessions land in
none; and a swarm belongs to the room most of its working members are in.

And the room helper above the rooms: a placement is a recorded, undoable move;
inside a room it proposes and the room's helper approves, declines or lets it
lapse; it opens rooms itself above a floor of working sessions; closing gives
a room's sessions back to it; and a project helper's report up wakes it.
"""
import itertools
import subprocess

import pytest

import project_rooms
import sqlstore
import store

_calls = itertools.count()


def _seed(*conv_ids, **fields):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        for cid in conv_ids:
            index[cid] = {"title": f"title {cid}", "lane": "coding", **fields}


def _call(conv, name, target):
    conn = sqlstore.open_db()
    conn.execute("INSERT INTO tool_calls (tool_use_id, source, conv, at, day, hour, name, target)"
                 " VALUES (?, 'observatory', ?, '2026-10-23T10:00:00', '2026-10-23', 10, ?, ?)",
                 (f"t{next(_calls)}", conv, name, target))
    conn.commit()
    conn.close()


@pytest.fixture
def project(data_dir, tmp_path):
    """A build repo with one worktree beside it, switched on as a project
    room, and a second repo standing in for the app checkout."""
    root = tmp_path / "shop"
    git = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]
    subprocess.run(git + ["init", "-q", str(root)], check=True)
    (root / "a.txt").write_text("a")
    subprocess.run(git + ["-C", str(root), "add", "."], check=True)
    subprocess.run(git + ["-C", str(root), "commit", "-qm", "a"], check=True)
    worktree = tmp_path / "shop-feature"
    subprocess.run(git + ["-C", str(root), "worktree", "add", "-q", str(worktree)], check=True)
    app = tmp_path / "app"
    subprocess.run(git + ["init", "-q", str(app)], check=True)
    store.write("terrain_builds", {"builds": [
        {"id": "shop", "name": "Shop", "root": str(root), "project_room": True}]})
    project_rooms._REPO_CACHE.clear()
    return {"root": root, "worktree": worktree, "app": app}


def test_edits_in_a_worktree_of_the_build_put_a_session_in_its_room(project):
    _seed("s1")
    _call("s1", "Edit", str(project["worktree"] / "a.txt"))
    _call("s1", "Write", str(project["worktree"] / "new" / "b.txt"))
    assert project_rooms.sync() == {"s1": "shop"}


def test_a_session_that_works_through_bash_cd_lands_too(project):
    _seed("s1")
    _call("s1", "Bash", f"cd {project['worktree']} && python3 - <<'EOF'\n...\nEOF")
    _call("s1", "Bash", "git status")
    assert project_rooms.room_of("s1") == "shop"


def test_the_apps_own_sessions_land_in_no_room(project):
    _seed("app1")
    _call("app1", "Edit", str(project["app"] / "server.py"))
    _call("app1", "Edit", str(project["app"] / "routes.py"))
    _call("app1", "Bash", f"cd {project['root']} && git log -1")
    assert project_rooms.sync() == {}


def test_a_placement_by_hand_beats_the_files(project):
    _seed("s1", "s2")
    _call("s1", "Edit", str(project["worktree"] / "a.txt"))
    assert project_rooms.room_of("s1") == "shop"
    assert project_rooms.place(None, ["s1"]) == {"s1": "shop"}
    _call("s1", "Edit", str(project["root"] / "a.txt"))
    assert project_rooms.room_of("s1") is None
    project_rooms.place("shop", ["s2"])
    assert project_rooms.members("shop") == ["s2"]


def test_a_continuation_stays_in_its_parents_room(project):
    """Even once it edits elsewhere; a spinoff from the room comes along only
    while it works nowhere else."""
    _seed("p")
    _seed("p2", spawned_from="p", spawned_via="continue")
    _seed("kid", spawned_from="p", spawned_via="spinoff")
    _seed("kid_elsewhere", spawned_from="p", spawned_via="spinoff")
    _call("p", "Edit", str(project["root"] / "a.txt"))
    _call("p2", "Edit", str(project["app"] / "x.py"))
    _call("kid_elsewhere", "Edit", str(project["app"] / "x.py"))
    assert project_rooms.sync() == {"p": "shop", "p2": "shop", "kid": "shop"}


def test_a_swarm_belongs_to_the_room_most_of_its_working_members_are_in(project):
    _seed("a", "b", "c")
    _seed("done", done_at="2026-10-23T09:00:00")
    for conv in ("a", "b"):
        _call(conv, "Edit", str(project["worktree"] / "a.txt"))
    for conv in ("c", "done"):
        _call(conv, "Edit", str(project["app"] / "x.py"))
    index = store.read("bot_chats/index", {})
    assert project_rooms.swarm_room(["a", "b", "c", "done"], index) == "shop"
    assert project_rooms.swarm_room(["c", "done"], index) is None


def test_no_switched_on_build_means_no_rooms(data_dir):
    _seed("s1")
    store.write("terrain_builds", {"builds": []})
    assert project_rooms.sync() == {}


# --- The helpers above the swarms -----------------------------------------------------

def _talk(one, other):
    import peermail
    peermail.send(other, "hi", from_conv=one)
    peermail.send(one, "ok", from_conv=other)
    peermail.send(other, "thanks", from_conv=one)


@pytest.fixture
def helpers(project, monkeypatch):
    """The project room with a swarm of two inside it (a, b), one session
    working alone in it (c), one Coding session outside it (out), and a room
    helper and project helper whose messages are collected, not sent."""
    import room_helper
    import swarm_helper
    import swarms
    from routes import observatory
    sent = []
    monkeypatch.setattr(observatory, "peer_send",
                        lambda frm, to, text, mode="inject": sent.append((frm, to, text)))
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    _seed("a", "b", "c", "out", last_at="2026-10-23T10:00:00")
    for conv in ("a", "b", "c"):
        _call(conv, "Edit", str(project["worktree"] / f"{conv}.txt"))
    _call("out", "Edit", str(project["app"] / "x.py"))
    _talk("a", "b")
    [swarm_id] = swarms.sync()
    room = room_helper.ensure_room_helper("coding")
    lead = room_helper.ensure_room_helper("coding:shop")
    return {"swarm": swarm_id, "room": room, "lead": lead, "sent": sent}


def test_the_room_helper_sees_a_project_as_one_block(helpers):
    import room_helper
    text = room_helper.room_overview("coding")
    block = text.split("## Project rooms")[1].split("## Swarms")[0]
    assert "### Shop (project room `shop`)" in block and helpers["lead"] in block
    assert "1 open swarm, 3 sessions still working." in block
    # Inside the project is the project helper's, not the room helper's.
    rest = text.split("## Swarms")[1]
    assert f"Swarm {helpers['swarm']}" not in rest and "`c`" not in rest and "`out`" in rest
    inside = room_helper.room_overview("coding:shop")
    assert f"Swarm {helpers['swarm']}" in inside and "`c`" in inside and "`out`" not in inside


def test_each_helper_moves_only_its_own_sessions(helpers):
    import room_helper
    with pytest.raises(room_helper.MoveError, match="project room"):
        room_helper.execute("coding", "join", ["c"], helpers["swarm"], "same work")
    move = room_helper.execute("coding:shop", "join", ["c"], helpers["swarm"], "same work")
    assert move["to_swarm"] == helpers["swarm"]
    with pytest.raises(room_helper.MoveError, match="shop project room"):
        room_helper.execute("coding:shop", "release", ["out"], None, "not ours")
    assert any(to == "c" and text.startswith("(Project helper:") for _, to, text in helpers["sent"])


def test_a_project_swarm_closing_is_told_to_the_project_helper(helpers):
    import swarm_helper
    assert swarm_helper._tell_room(helpers["swarm"], "Swarm", "coding", "h", "Did it.", "now")
    room_chat = store.DATA_DIR / "bot_chats" / f"{helpers['room']}.jsonl"
    lead_chat = (store.DATA_DIR / "bot_chats" / f"{helpers['lead']}.jsonl").read_text()
    assert "Did it." in lead_chat
    assert not room_chat.exists() or "Did it." not in room_chat.read_text()


def test_a_big_swarm_becomes_a_project_room_and_keeps_its_helper(project, monkeypatch):
    """scripts/swarm_to_project_room.py --apply: the swarm's helper becomes the
    project helper with its rules, the swarm is emptied in one undoable move,
    and nothing then archives the helper or writes a closing summary."""
    import importlib.util
    import helper_chat
    import swarm_helper
    import swarms
    from routes import observatory
    monkeypatch.setattr(observatory, "peer_send", lambda *a, **k: None)
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    monkeypatch.setattr(swarm_helper, "_spawn_close",
                        lambda *a: pytest.fail("no closing for an emptied swarm"))
    store.write("terrain_builds", {"builds": [
        {"id": "shop", "name": "Shop", "root": str(project["root"])}]})
    _seed("a", "b")
    for conv in ("a", "b"):
        _call(conv, "Edit", str(project["worktree"] / f"{conv}.txt"))
    _talk("a", "b")
    [swarm_id] = swarms.sync()
    helper = swarm_helper.ensure_helper(swarm_id)
    old_entry = store.read("bot_chats/index", {})[helper]
    helper_chat.add_rule(old_entry, "keep it short")

    # The script points itself at EXOCORTEX_DATA_DIR when it's set; here the
    # test's own data dir must stand.
    monkeypatch.delenv("EXOCORTEX_DATA_DIR", raising=False)
    spec = importlib.util.spec_from_file_location(
        "swarm_to_project_room", store.BUILD_DIR / "scripts" / "swarm_to_project_room.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    script.main(["--swarm", str(swarm_id), "--build", "shop", "--helper", helper, "--apply"])

    index = store.read("bot_chats/index", {})
    entry = index[helper]
    assert entry["role"] == "project_helper" and entry["project_room"] == "shop"
    assert "claude_session_id" not in entry and "keep it short" in helper_chat.rules_text(entry)
    assert swarms.overview_members(swarm_id) == [] and project_rooms.members("shop") == ["a", "b"]
    swarms.sync()
    swarm_helper.tick()
    entry = store.read("bot_chats/index", {})[helper]
    assert not entry.get("archived") and not entry.get("helper_closed_at")
    assert swarms.retired(swarm_id) is False


# --- The room helper above the project rooms ------------------------------------------

@pytest.fixture
def ladder(helpers, monkeypatch):
    """The `helpers` room, with a second switched-on room (Mill), and no
    detached runs: the runs started are collected."""
    import room_helper
    spawned = []
    monkeypatch.setattr(room_helper, "_spawn", lambda scope, trigger: spawned.append(scope) or True)
    root = helpers_root = store.DATA_DIR.parent / "mill"
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    builds = store.read("terrain_builds", {})
    builds["builds"].append({"id": "mill", "name": "Mill", "root": str(helpers_root),
                             "project_room": True})
    store.write("terrain_builds", builds)
    project_rooms._REPO_CACHE.clear()
    return {**helpers, "spawned": spawned, "mill": root}


def _chat(conv):
    path = store.DATA_DIR / "bot_chats" / f"{conv}.jsonl"
    return path.read_text() if path.exists() else ""


def test_a_placement_is_a_real_move_and_undo_puts_it_back(ladder):
    """Moved from one room to another: recorded with its reason, the session
    told once which room it's in and whose it is, every chat involved told, and
    undo brings the session back to the room it was in."""
    import room_helper
    mill = room_helper.ensure_room_helper("coding:mill")
    move = room_helper.place("mill", ["c"], "it works on the mill now", by="owner")
    assert project_rooms.room_of("c") == "mill"
    [stored] = [m for m in room_helper.recent_moves("coding") if m["id"] == move["id"]]
    assert stored["reason"] == "it works on the mill now" and stored["target"] == "Mill"
    notes = [text for _, to, text in ladder["sent"] if to == "c"]
    assert len(notes) == 1 and "Mill project room" in notes[0] and mill in notes[0]
    for chat in (ladder["room"], mill, ladder["lead"]):
        assert f"Move #{move['id']}" in _chat(chat)
    room_helper.undo(move["id"])
    assert project_rooms.room_of("c") == "shop"
    assert room_helper.recent_moves("coding")[0]["undone_at"]


def test_the_room_helpers_own_placement_waits_for_the_answer(ladder):
    """A run's `place` doesn't move anything; approving does, and a proposal
    for out of a room goes to the room the session is leaving."""
    import room_helper
    filed = room_helper.propose("place", ["out"], target="shop", reason="it's shop work",
                                by="room_helper")["proposal"]
    assert project_rooms.room_of("out") is None
    assert any(to == ladder["lead"] and f"approve {filed['id']}" in text
               for _, to, text in ladder["sent"])
    assert "`out`" not in room_helper.room_overview("coding:shop").split("Proposals")[0]
    move = room_helper.approve("coding:shop", filed["id"])
    assert project_rooms.room_of("out") == "shop"
    assert room_helper.proposals("shop", "approved")[0]["move_id"] == move["id"]
    away = room_helper.propose("place", ["c"], target=None, reason="not shop work")["proposal"]
    assert away["project"] == "shop"


def test_a_proposal_inside_a_room_is_approved_made_and_undoable(ladder):
    import room_helper
    import swarms
    filed = room_helper.propose("join", ["c"], ladder["swarm"], reason="same work",
                                message="Work with a and b.", by="room_helper")["proposal"]
    assert swarms.swarm_of("c") is None
    # It's in the project helper's seed and run until answered, and the
    # room helper's block says it's waiting.
    index = store.read("bot_chats/index", {})
    import helper_chat
    assert f"#{filed['id']} join" in helper_chat.seed_text(ladder["lead"], index[ladder["lead"]])
    assert f"#{filed['id']} join" in room_helper.room_overview("coding:shop")
    assert f"#{filed['id']} join" in room_helper.room_overview("coding").split("## Swarms")[0]
    with pytest.raises(room_helper.MoveError):
        room_helper.approve("coding:mill", filed["id"])
    move = room_helper.approve("coding:shop", filed["id"])
    assert swarms.swarm_of("c") == ladder["swarm"] and move["kind"] == "join"
    assert any(to == "c" and text.startswith("Work with a and b.") for _, to, text in ladder["sent"])
    assert f"Proposal #{filed['id']} was approved" in _chat(ladder["room"])
    room_helper.undo(move["id"])
    assert swarms.swarm_of("c") is None
    with pytest.raises(room_helper.MoveError):
        room_helper.approve("coding:shop", filed["id"])


def test_a_declined_proposal_tells_the_reason_and_cant_be_asked_again(ladder):
    import room_helper
    import swarms
    filed = room_helper.propose("join", ["c"], ladder["swarm"], reason="same work")["proposal"]
    with pytest.raises(room_helper.MoveError, match="already waiting"):
        room_helper.propose("join", ["c"], ladder["swarm"], reason="still the same")
    room_helper.decline("coding:shop", filed["id"], "c is on another part of the shop")
    assert swarms.swarm_of("c") is None
    assert any(to == ladder["room"] and "c is on another part of the shop" in text
               for _, to, text in ladder["sent"])
    with pytest.raises(room_helper.MoveError, match="declined"):
        room_helper.propose("join", ["c"], ladder["swarm"], reason="again")
    # ...unless she asks for it herself, which skips the exchange.
    assert "move" in room_helper.propose("join", ["c"], ladder["swarm"], reason="she said", by="owner")
    assert swarms.swarm_of("c") == ladder["swarm"]


def test_a_proposal_nobody_answers_lapses_and_may_be_asked_again(ladder):
    from datetime import datetime, timedelta
    import room_helper
    filed = room_helper.propose("release", ["c"], reason="done with it")["proposal"]
    assert room_helper.lapse_proposals() == 0
    assert room_helper.lapse_proposals(datetime.now() + timedelta(hours=25)) == 1
    assert room_helper.proposals("shop", "lapsed")[0]["id"] == filed["id"]
    assert any(to == ladder["room"] and "lapsed" in text for _, to, text in ladder["sent"])
    with pytest.raises(room_helper.MoveError, match="already lapsed"):
        room_helper.approve("coding:shop", filed["id"])
    assert room_helper.propose("release", ["c"], reason="asking again")["proposal"]["status"] == "open"


def test_a_run_inside_a_project_files_a_proposal_and_opens_rooms_itself(ladder, project, monkeypatch):
    """The room helper's run: a move on a project's sessions becomes a proposal
    rather than a refusal, a close too, and a room below the floor is refused
    and reported."""
    import room_helper
    import swarm_helper
    import swarms
    answer = {"overview": "o", "moves": [
        {"kind": "release", "convs": ["a"], "reason": "r", "message": "m"},
        {"kind": "close", "convs": [], "project": "mill", "reason": "over", "message": ""},
        {"kind": "open", "convs": [], "project": str(ladder["mill"]) + "-nope", "reason": "r",
         "message": ""}]}
    monkeypatch.setattr(room_helper, "_call_model", lambda text, room: (answer, 0.0))
    monkeypatch.setattr(swarm_helper, "_call_session", lambda text: ({"summary": "s"}, 0.0))
    room_helper.run("coding")
    assert swarms.swarm_of("a") == ladder["swarm"]
    assert [p["kind"] for p in room_helper.proposals("shop")] == ["release"]
    assert [p["kind"] for p in room_helper.proposals("mill")] == ["close"]
    chat = _chat(ladder["room"])
    assert "Proposed to the Shop helper" in chat and "not made" in chat


def test_a_project_run_reporting_up_wakes_the_room_helper_and_shows_in_its_block(ladder, monkeypatch):
    import room_helper
    import swarm_helper
    answer = {"overview": "Stuck.", "moves": [], "up": "Blocked on the mill's new API."}
    monkeypatch.setattr(room_helper, "_call_model", lambda text, room: (answer, 0.0))
    monkeypatch.setattr(swarm_helper, "_call_session", lambda text: ({"summary": "s"}, 0.0))
    room_helper.run("coding:shop")
    reports = [text for _, to, text in ladder["sent"]
               if to == ladder["room"] and "Blocked on the mill's new API." in text]
    assert len(reports) == 1
    block = room_helper.room_overview("coding").split("## Swarms")[0]
    assert "reported up" in block and "Blocked on the mill's new API." in block
    # The same words on its next run aren't sent again.
    room_helper.run("coding:shop")
    assert len([t for _, to, t in ladder["sent"] if to == ladder["room"] and "Blocked" in t]) == 1
    assert "Your last report up" in room_helper.room_overview("coding:shop")


def _worktree_sessions(root, *convs):
    for conv in convs:
        _seed(conv, last_at="2026-10-23T10:00:00")
        _call(conv, "Edit", str(root / f"{conv}.txt"))


def test_opening_a_folder_lists_it_lands_its_sessions_and_undo_reverts_all(helpers, tmp_path, monkeypatch):
    """An unlisted repo with three sessions in a worktree of it: opened from
    the worktree's path, the main checkout goes on the list, the sessions land,
    the helper exists and its first run starts. Undo takes all of it back."""
    import buildlist
    import room_helper
    spawned = []
    monkeypatch.setattr(room_helper, "_spawn", lambda scope, trigger: spawned.append(scope) or True)
    git = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]
    root = tmp_path / "barn"
    subprocess.run(git + ["init", "-q", str(root)], check=True)
    (root / "a.txt").write_text("a")
    subprocess.run(git + ["-C", str(root), "add", "."], check=True)
    subprocess.run(git + ["-C", str(root), "commit", "-qm", "a"], check=True)
    worktree = tmp_path / "barn-x"
    subprocess.run(git + ["-C", str(root), "worktree", "add", "-q", str(worktree)], check=True)
    _worktree_sessions(worktree, "w1", "w2", "w3")
    project_rooms._REPO_CACHE.clear()

    move = room_helper.open_room(str(worktree), reason="three sessions on the barn")
    assert buildlist.find("barn")["root"] == root.resolve()
    assert project_rooms.members("barn") == ["w1", "w2", "w3"]
    helper = room_helper.find_helper("coding:barn")
    assert helper and spawned == ["coding:barn"]
    assert move["convs"] == ["w1", "w2", "w3"]
    assert all(any(to == w and "just opened" in text and helper in text
                   for _, to, text in helpers["sent"]) for w in move["convs"])
    assert "shop" in {r["id"] for r in project_rooms.rooms()}

    room_helper.undo(move["id"])
    assert buildlist.find("barn") is None
    assert room_helper.find_helper("coding:barn") is None
    assert project_rooms.sync().get("w1") is None and project_rooms.rows(["w1"])["w1"] is None
    assert project_rooms.members("shop") == ["a", "b", "c"]
    # She undid it, so the room helper doesn't open it again by itself.
    with pytest.raises(room_helper.MoveError, match="undid"):
        room_helper.open_room(str(root), reason="again")


def test_opening_is_refused_below_the_floor_unless_she_asks(helpers, tmp_path, monkeypatch):
    import buildlist
    import room_helper
    monkeypatch.setattr(room_helper, "_spawn", lambda *a: True)
    root = tmp_path / "barn"
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    _worktree_sessions(root, "w1")
    project_rooms._REPO_CACHE.clear()
    with pytest.raises(room_helper.MoveError, match="at least 3"):
        room_helper.open_room(str(root), reason="one session")
    assert buildlist.find("barn") is None
    move = room_helper.open_room(str(root), name="The Barn", reason="she asked", by="owner")
    assert move["convs"] == ["w1"] and buildlist.find("barn")["name"] == "The Barn"


def test_the_apps_own_folder_can_never_be_opened(helpers, monkeypatch):
    import room_helper
    monkeypatch.setattr(room_helper, "_spawn", lambda *a: True)
    with pytest.raises(room_helper.MoveError, match="overlaps the app code"):
        room_helper.open_room(str(store.BUILD_DIR), reason="no", by="owner")


def test_closing_one_of_two_rooms_gives_its_sessions_back_and_undo_restores_it(ladder):
    """The sync bug this pins: a switched-off room's rows hid its sessions from
    every helper while another room was on."""
    import room_helper
    _seed("m1", last_at="2026-10-23T10:00:00")
    _call("m1", "Edit", str(ladder["mill"] / "m.txt"))
    assert project_rooms.room_of("m1") == "mill"
    move = room_helper.close_room("shop", "the work is over", by="owner")
    index = store.read("bot_chats/index", {})
    assert project_rooms.rooms()[0]["id"] == "mill" and len(project_rooms.rooms()) == 1
    assert project_rooms.members("mill") == ["m1"]
    assert {"a", "b", "c"} <= set(room_helper.solo_sessions("coding", index, []))
    assert room_helper.find_helper("coding:shop") is None
    assert "`c`" in room_helper.room_overview("coding")
    assert ladder["swarm"] in {c["id"] for c in room_helper.open_swarms("coding")}
    room_helper.undo(move["id"])
    assert project_rooms.members("shop") == ["a", "b", "c"]
    assert room_helper.find_helper("coding:shop") == ladder["lead"]
    assert ladder["swarm"] in {c["id"] for c in room_helper.open_swarms("coding:shop")}


def test_the_room_helper_asks_to_close_and_its_helper_says_yes(ladder):
    import room_helper
    filed = room_helper.propose("close", target="shop", reason="it's over")["proposal"]
    assert project_rooms.find("shop")
    move = room_helper.approve("coding:shop", filed["id"])
    assert project_rooms.find("shop") is None and move["kind"] == "close"


def test_a_room_switched_off_by_hand_hides_nobody_and_they_can_land_elsewhere(ladder):
    _seed("c2", last_at="2026-10-23T10:00:00")
    project_rooms.switch("shop", False)
    assert "c" not in project_rooms.sync()
    _call("c", "Edit", str(ladder["mill"] / "m.txt"))
    _call("c", "Edit", str(ladder["mill"] / "n.txt"))
    _call("c", "Edit", str(ladder["mill"] / "o.txt"))
    assert project_rooms.room_of("c") == "mill"
    assert project_rooms.room_of("a") is None


def test_the_command_line_files_a_proposal_unless_she_asks(ladder, monkeypatch, capsys):
    import importlib.util
    monkeypatch.delenv("EXOCORTEX_DATA_DIR", raising=False)
    spec = importlib.util.spec_from_file_location(
        "room_moves", store.BUILD_DIR / "scripts" / "room_moves.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    assert script.main(["project-place", "shop", "out", "--reason", "shop work"]) == 0
    assert project_rooms.room_of("out") is None and "proposal #" in capsys.readouterr().out
    assert script.main(["project-place", "mill", "out", "--reason", "she said", "--by-owner"]) == 0
    assert project_rooms.room_of("out") == "mill"
    assert script.main(["--room", "coding:shop", "close", "shop", "--reason", "no"]) == 1
    assert script.main(["--room", "coding:shop", "proposals"]) == 0
    number = script.room_helper.proposals("shop")[0]["id"]
    assert script.main(["--room", "coding:shop", "decline", str(number), "--reason", "not ours"]) == 0
