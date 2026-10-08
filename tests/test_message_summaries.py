"""Message summaries (message_summaries.py), with the model call stood in for.

What these pin: sending an agent message starts one summary call for it, and
the sheet behind a line of the swarm drawing then shows that message's line
and the thread's summary; the call is handed the earlier messages, its own
earlier note and each session's summary, and never a transcript; a call that
finishes late can't overwrite a newer account of the thread; messages that
sit on no line she can click (to a helper, from the room helper) cost nothing;
a failed call is kept as a failure and the message still lists; the minute
tick picks up a message whose call never started, once.
"""
from datetime import datetime, timedelta

import pytest
from flask import Flask

import message_summaries
import peermail
import sqlstore
import store
import swarms
from routes import observatory
from routes import swarms as swarm_routes


@pytest.fixture
def room(data_dir, monkeypatch):
    """Two sessions and both kinds of helper, with the summary call run in
    line (not detached) and the model stood in for: it records what it was
    handed and answers from the new message's first words."""
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index["a"] = {"title": "Ada", "lane": "coding", "running": True}
        index["b"] = {"title": "Bo", "lane": "coding", "running": True}
        index["rh"] = {"title": "Room helper", "lane": "coding", "role": "room_helper",
                       "room": "coding"}
    handed = []

    def model(text):
        handed.append(text)
        new = text.split("## The NEW message")[1].split("\n\n")[1]
        return {"gist": f"gist of {new[:20]}", "thread": f"thread after {new[:20]}"}, 0.01

    monkeypatch.setattr(message_summaries, "_call", model)
    monkeypatch.setattr(message_summaries, "_detach", message_summaries.summarise)
    monkeypatch.setattr(observatory, "drain_inbox", lambda conv: False)
    return handed


def _line(a="a", b="b"):
    app = Flask(__name__)
    swarm_routes.register(app)
    [swarm_id] = swarms.sync()
    return app.test_client().get(f"/api/swarms/{swarm_id}/line?a={a}&b={b}").get_json()


def test_a_sent_message_gets_its_line_and_the_thread_its_summary(room):
    observatory.peer_send("a", "b", "are you editing x.py?")
    conn = sqlstore.open_db()
    sqlstore.begin_immediate(conn)
    conn.execute("INSERT INTO session_summaries (conv, summary, summary_at)"
                 " VALUES ('b', 'Now: rewriting x.py', '2026-10-07T10:00:00')")
    conn.execute("COMMIT")
    conn.close()
    observatory.peer_send("b", "a", "yes, until noon")

    got = _line()
    assert [(m["text"], m["gist"]) for m in got["messages"]] == [
        ("yes, until noon", "gist of yes, until noon"),
        ("are you editing x.py?", "gist of are you editing x.py"[:28])]
    assert got["thread"]["summary"] == "thread after yes, until noon"
    # The second call read the first message, the note on it and what the
    # helpers say each session is doing.
    assert len(room) == 2
    assert "are you editing x.py?" in room[1] and "gist of are you editing" in room[1]
    assert "Now: rewriting x.py" in room[1] and "Ada (a)" in room[1]


def test_a_call_that_finishes_late_does_not_replace_a_newer_thread_summary(room, monkeypatch):
    monkeypatch.setattr(message_summaries, "_detach", lambda message_id: None)
    first = observatory.peer_send("a", "b", "first")
    second = observatory.peer_send("b", "a", "second")
    message_summaries.summarise(second["id"])
    message_summaries.summarise(first["id"])
    got = _line()
    assert got["thread"]["summary"] == "thread after second"
    assert [m["gist"] for m in got["messages"]] == ["gist of second", "gist of first"]
    # A message already summarised is not paid for twice.
    message_summaries.summarise(first["id"])
    assert len(room) == 2


def test_messages_on_no_line_she_can_click_cost_nothing(room):
    observatory.peer_send("a", "rh", "which swarm am I in?")
    observatory.peer_send("rh", "a", "you are now in a swarm")
    assert room == []


def test_a_failed_call_is_kept_and_the_message_still_lists(room, monkeypatch):
    def broken(text):
        raise RuntimeError("helper call failed: no model")
    monkeypatch.setattr(message_summaries, "_call", broken)
    observatory.peer_send("a", "b", "hello")
    observatory.peer_send("b", "a", "ok")
    got = _line()
    assert [(m["text"], m["gist"]) for m in got["messages"]] == [("ok", None), ("hello", None)]
    assert got["thread"] is None
    conn = sqlstore.open_db()
    assert "no model" in conn.execute("SELECT error FROM message_summaries").fetchone()[0]
    conn.close()


def test_the_tick_starts_a_call_that_never_started_and_only_once(room, monkeypatch):
    monkeypatch.setattr(message_summaries, "_detach", lambda message_id: None)
    sent = observatory.peer_send("a", "b", "missed at send")
    # Just sent: its own call is given time before the tick steps in.
    assert message_summaries.tick() == 0
    old = (datetime.now() - timedelta(minutes=10)).isoformat(timespec="seconds")
    conn = sqlstore.open_db()
    sqlstore.begin_immediate(conn)
    conn.execute("UPDATE agent_messages SET at = ? WHERE id = ?", (old, sent["id"]))
    conn.execute("COMMIT")
    conn.close()
    monkeypatch.setattr(message_summaries, "_detach", message_summaries.summarise)
    assert message_summaries.tick() == 1
    assert message_summaries.gists([sent["id"]]) == {sent["id"]: "gist of missed at send"}
    assert message_summaries.tick() == 0


def test_a_busy_database_does_not_lose_an_answer_already_paid_for(room, monkeypatch):
    import sqlite3
    real, tries = message_summaries._store, []

    def busy_twice(*args):
        tries.append(1)
        if len(tries) < 3:
            raise sqlite3.OperationalError("database is locked")
        return real(*args)

    monkeypatch.setattr(message_summaries, "_store", busy_twice)
    monkeypatch.setattr(message_summaries, "_WRITE_WAIT_SEC", 0)
    sent = observatory.peer_send("a", "b", "hold on")
    assert message_summaries.gists([sent["id"]]) == {sent["id"]: "gist of hold on"}
    assert len(room) == 1
