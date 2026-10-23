"""Project rooms (project_rooms.py): which Coding sessions gather in a project.

What these pin, the way it's used: a session whose edits are in a git
worktree of a switched-on build lands in that build's room, and so does one
that only `cd`s there in Bash; a placement by hand beats the files; a
continuation stays in its parent's room; the app's own sessions land in
none; and a swarm belongs to the room most of its working members are in.
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
