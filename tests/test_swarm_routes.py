"""Swarm routes (routes/swarms.py) against a minimal app.

What these pin: the list shows a live swarm with its counts; the detail
carries the helper's runs verbatim and the messages between members;
a closed swarm's page carries what it did, newest closing first;
unknown swarms 404; a card says whether it's closed; refresh starts a helper run; the room view lists the
sessions working alone and the room helper's moves; helper-of links a session's
chat to its swarm's helper, else its room's, and a helper one level up or nowhere;
a helper's context page shows the seed its last turn was handed, in parts, and
saves her standing rules so the next seed carries them — without wiping a rule
the helper added while she was editing.
"""
import json

import pytest
from flask import Flask

import helper_chat
import peermail
import sqlstore
import store
import swarm_helper
import swarms
from routes import swarms as swarm_routes


@pytest.fixture
def client(data_dir, monkeypatch):
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index["a"] = {"title": "A", "lane": "coding", "running": True}
        index["b"] = {"title": "B", "lane": "coding"}
    peermail.send("b", "hello", from_conv="a")
    app = Flask(__name__)
    swarm_routes.register(app)
    return app.test_client()


def test_the_list_shows_a_swarm_with_its_counts(client):
    [card] = client.get("/api/swarms").get_json()["swarms"]
    assert card["counts"] == {"working": 1, "silent": 1, "needs_input": 0}
    assert {m["conv"] for m in card["members"]} == {"a", "b"}
    assert card["closed"] is False


def test_the_detail_shows_what_the_helper_used(client):
    [swarm_id] = swarms.sync()
    conn = sqlstore.open_db()
    sqlstore.begin_immediate(conn)
    conn.execute("INSERT INTO swarm_helper_runs (swarm_id, at, trigger, input, output)"
                 " VALUES (?, '2026-09-27T10:00:00', 'turn', 'the input', ?)",
                 (swarm_id, json.dumps({"differences": ["both edit x.py"]})))
    conn.execute("COMMIT")
    conn.close()
    got = client.get(f"/api/swarms/{swarm_id}").get_json()
    assert got["runs"][0]["input"] == "the input"
    assert got["differences"] == ["both edit x.py"]
    assert [m["text"] for m in got["messages"]] == ["hello"]


def test_the_detail_shows_what_a_closed_swarm_did(client, monkeypatch):
    [swarm_id] = swarms.sync()
    assert client.get(f"/api/swarms/{swarm_id}").get_json()["closings"] == []
    helper = swarm_helper.ensure_helper(swarm_id)
    with store.mutate("bot_chats/index", {}) as index:
        index["a"] = {"title": "A", "lane": "coding", "done_at": "2026-09-27T12:00:00"}
    said = iter(["first time", "second time"])
    monkeypatch.setattr(swarm_helper, "_call_closing",
                        lambda text: ({"headline": "h", "summary": next(said)}, 0.01))
    swarm_helper.close_out(swarm_id, helper)
    swarm_helper.close_out(swarm_id, helper)
    newest, older = client.get(f"/api/swarms/{swarm_id}").get_json()["closings"]
    assert (newest["summary"], older["summary"]) == ("second time", "first time")
    assert "What shipped" in newest["facts"] and newest["error"] is None


def test_unknown_swarm_is_404(client):
    assert client.get("/api/swarms/999").status_code == 404
    assert client.post("/api/swarms/999/refresh").status_code == 404


def test_refresh_starts_a_run(client):
    [swarm_id] = swarms.sync()
    assert client.post(f"/api/swarms/{swarm_id}/refresh").get_json()["started"] is True


def test_the_room_view_lists_who_works_alone(client):
    with store.mutate("bot_chats/index", {}) as index:
        index["c"] = {"title": "C", "lane": "coding"}
        index["h"] = {"title": "Room helper", "lane": "coding", "role": "room_helper",
                      "room": "coding"}
    found = client.get("/api/swarms/room/coding").get_json()
    assert [s["conv"] for s in found["solos"]] == ["c"]
    assert found["helper_conv"] == "h" and found["moves"] == []


def _with_helpers(swarm_helper_conv="sh"):
    """Give the fixture's swarm a helper session, and the room a room helper."""
    [swarm_id] = swarms.sync()
    with store.mutate("bot_chats/index", {}) as index:
        index["sh"] = {"title": "Swarm helper · X", "lane": "coding", "role": "swarm_helper",
                       "swarm_id": swarm_id}
        index["rh"] = {"title": "Room helper · Coding", "lane": "coding", "role": "room_helper",
                       "room": "coding"}
        index["solo"] = {"title": "Solo", "lane": "coding"}
    conn = sqlstore.open_db()
    sqlstore.begin_immediate(conn)
    conn.execute("UPDATE swarms SET helper_conv = ? WHERE id = ?", (swarm_helper_conv, swarm_id))
    conn.execute("COMMIT")
    conn.close()


def _helper_of(client, conv):
    return client.get(f"/api/swarms/helper-of/{conv}").get_json()["helper"]


def test_a_swarm_member_links_to_its_swarm_helper(client):
    _with_helpers()
    assert _helper_of(client, "a") == {"kind": "swarm", "conv": "sh", "title": "Swarm helper · X"}


def test_a_session_working_alone_links_to_its_room_helper(client):
    _with_helpers()
    assert _helper_of(client, "solo")["conv"] == "rh"


def test_a_member_of_a_swarm_with_no_helper_yet_falls_back_to_the_room_helper(client):
    _with_helpers(swarm_helper_conv=None)
    assert _helper_of(client, "a")["kind"] == "room"


def test_a_swarm_helper_links_up_to_the_room_helper_and_the_room_helper_nowhere(client):
    _with_helpers()
    assert _helper_of(client, "sh")["conv"] == "rh"
    assert _helper_of(client, "rh") is None


def test_no_helper_in_the_room_means_no_link(client):
    with store.mutate("bot_chats/index", {}) as index:
        index["p"] = {"title": "P", "lane": "personal"}
    assert _helper_of(client, "p") is None
    assert _helper_of(client, "nope") is None


# --- The helper's context page ----------------------------------------------------

def _context(client, conv, **query):
    return client.get(f"/api/swarms/helper-context/{conv}", query_string=query)


def test_the_context_page_shows_what_the_helper_was_handed_and_saves_her_rules(client):
    _with_helpers()
    entry = store.read("bot_chats/index", {})["sh"]
    # Only a helper has a context; and before its first turn there is no seed.
    assert _context(client, "a").status_code == 404
    assert _helper_of(client, "a") and not client.get(
        "/api/swarms/helper-of/a").get_json()["is_helper"]
    assert client.get("/api/swarms/helper-of/sh").get_json()["is_helper"] is True
    assert _context(client, "sh").get_json()["seed"] is None

    # A turn starts: she had said something with a heading in it.
    with open(store.DATA_DIR / "bot_chats" / "sh.jsonl", "w", encoding="utf-8") as log:
        log.write(json.dumps({"type": "user", "text": "# 3. not a real part\nwho is on x.py?"})
                  + "\n")
    handed = open(helper_chat.write_seed("sh", entry), encoding="utf-8").read()
    got = _context(client, "sh").get_json()
    parts = got["seed"]["parts"]
    assert [p["key"] for p in parts] == ["doc", "rules", "watches", "exchanges", "sessions"]
    assert "\n".join(p["text"] for p in parts) + "\n" == handed    # the parts ARE the seed
    assert "who is on x.py?" in parts[3]["text"] and got["seed"]["now"] is False
    assert got["kind"] == "swarm" and got["rules"]["rules"] == []

    # She writes a rule on the page; the helper adds one before she saves again.
    loaded = got["rules"]["text"]
    saved = client.put("/api/swarms/helper-context/sh/rules",
                       json={"text": loaded + "- keep replies short\n", "loaded": loaded})
    assert saved.get_json()["rules"]["rules"] == ["keep replies short"]
    helper_chat.add_rule(entry, "never move a saved session", day="2026-10-01")
    stale = client.put("/api/swarms/helper-context/sh/rules",
                       json={"text": "- mine only\n", "loaded": saved.get_json()["rules"]["text"]})
    assert stale.status_code == 409 and len(stale.get_json()["rules"]["rules"]) == 2
    assert "never move a saved session" in helper_chat.rules_path(entry).read_text()

    # The last turn's seed doesn't have the rules yet; built now, it does —
    # and looking never counts as the helper having been shown anything.
    seen = helper_chat._seen_path("sh").read_text()
    assert "keep replies short" not in _context(client, "sh").get_json()["seed"]["parts"][1]["text"]
    fresh = _context(client, "sh", now="1").get_json()["seed"]
    assert fresh["now"] is True and "1. keep replies short" in fresh["parts"][1]["text"]
    assert helper_chat._seen_path("sh").read_text() == seen
    assert helper_chat.last_seed("sh")["parts"][1]["text"] == parts[1]["text"]


def test_a_seed_written_before_parts_were_kept_still_opens_whole(client):
    _with_helpers()
    folder = helper_chat._seed_folder()
    (folder / "rh.md").write_text("# 1. This doc\n\nold seed\n", encoding="utf-8")
    [part] = _context(client, "rh").get_json()["seed"]["parts"]
    assert part["key"] == "whole" and "old seed" in part["text"]


def test_her_rule_buttons_add_edit_and_drop_one_rule_and_leave_her_other_lines(client):
    _with_helpers()
    entry = store.read("bot_chats/index", {})["rh"]
    change = lambda **body: client.post("/api/swarms/helper-context/rh/rule", json=body)
    listed = lambda reply: reply.get_json()["rules"]["rules"]

    first = listed(change(action="add", words="never move a saved session"))
    assert len(first) == 1 and first[0].endswith('"never move a saved session"')
    path = helper_chat.rules_path(entry)
    path.write_text(path.read_text() + "\na note of mine, not a rule\n- keep replies short\n")

    edited = listed(change(action="edit", number=2, was="keep replies short",
                           words="keep replies to three lines"))
    assert edited == [first[0], "keep replies to three lines"]
    # The helper drops rule 1 meanwhile: her page still calls the other one rule 2.
    helper_chat.drop_rule(entry, 1)
    stale = change(action="drop", number=2, was="keep replies to three lines")
    assert stale.status_code == 409 and listed(stale) == ["keep replies to three lines"]
    assert listed(change(action="drop", number=1, was="keep replies to three lines")) == []
    assert "a note of mine, not a rule" in path.read_text()
    # An empty rule is refused, and what the helper is handed follows the file.
    assert change(action="add", words="  ").status_code == 400
    change(action="add", words="ask before you split a swarm")
    assert '"ask before you split a swarm"' in helper_chat.seed_text("rh", entry)
