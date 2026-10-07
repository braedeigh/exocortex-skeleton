"""The chat search box and the recently-opened list (routes/chat_search.py,
chatsearch.py), exercised the way the Observatory uses them: real conversation
logs on disk, searched through the HTTP door.
"""
import json

import pytest
from flask import Flask

import store
import toolcallstore
from routes import chat_search


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    chat_search.register(app)
    return app.test_client()


def _said(who, text):
    """One spoken log line: 'B' is her typed message, 'K' the agent's reply."""
    if who == "B":
        return json.dumps({"type": "user", "text": text, "ts": "2026-08-01T09:00:00"}) + "\n"
    return json.dumps({"type": "assistant", "timestamp": "2026-08-01T14:00:05.000Z",
                       "message": {"role": "assistant",
                                   "content": [{"type": "text", "text": text}]}}) + "\n"


def _log(conv_id):
    chats = store.DATA_DIR / "bot_chats"
    chats.mkdir(parents=True, exist_ok=True)
    return chats / f"{conv_id}.jsonl"


def _seed(conv_id, lines, **meta):
    """A conversation with a real log behind it. `lines` is (who, text)."""
    _log(conv_id).write_text("".join(_said(who, text) for who, text in lines))
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = dict({"title": conv_id, "last_at": "2026-08-01T00:00:00"}, **meta)


def _search(client, q, where="said"):
    return client.get("/api/observatory/search", query_string={"q": q, "in": where}).get_json()


def _marked(hit):
    return [piece["text"].lower() for piece in hit["pieces"] if piece["hit"]]


def test_search_finds_what_was_said_in_every_kind_of_session(client):
    _seed("conv-open", [("B", "what should I do about the balcony door"),
                        ("K", "Seal the balcony before winter.")],
          last_at="2026-08-03T00:00:00")
    _seed("conv-closed", [("B", "the balcony railing is loose")],
          archived="2026-07-01T00:00:00", last_at="2026-08-02T00:00:00")
    _seed("conv-diary", [("B", "sat on the balcony all morning")], journal=True)
    _seed("conv-other", [("B", "nothing relevant here")])

    data = _search(client, "balcony")
    found = {r["id"]: r for r in data["results"]}
    # Newest first, closed and journalled sessions included and flagged.
    assert [r["id"] for r in data["results"]] == ["conv-open", "conv-closed", "conv-diary"]
    assert found["conv-closed"]["archived"] is True
    assert found["conv-diary"]["journal"] is True
    # Both speakers' lines are found, in the order they were said, each
    # saying who spoke and with the matched word marked.
    hits = found["conv-open"]["hits"]
    assert [h["who"] for h in hits] == ["B", "K"]
    assert found["conv-open"]["count"] == 2
    assert all(_marked(h) == ["balcony"] for h in hits)


def test_search_matches_word_beginnings_endings_and_several_words(client):
    _seed("conv-a", [("B", "I was bartending downtown on friday")])
    _seed("conv-b", [("B", "downtown is loud")])
    # A half-typed word finds the whole one; a different ending still matches.
    assert [r["id"] for r in _search(client, "barten")["results"]] == ["conv-a"]
    assert [r["id"] for r in _search(client, "bartender")["results"]] == ["conv-a"]
    # Every word must be there, in any order.
    assert [r["id"] for r in _search(client, "friday downtown")["results"]] == ["conv-a"]
    # A quoted phrase must be side by side; -word leaves a line out.
    assert _search(client, '"downtown bartending"')["results"] == []
    assert [r["id"] for r in _search(client, "downtown -loud")["results"]] == ["conv-a"]


def test_search_reads_only_speech_not_tool_machinery(client):
    # A user event carrying `message` is the agent echoing a tool result to
    # itself, and an agent line with a parent tool call is a subagent talking
    # to its launcher. Matching either would bury what she actually said.
    _log("conv-tool").write_text(
        json.dumps({"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "content": "balcony.py"}]}}) + "\n"
        + json.dumps({"type": "assistant", "parent_tool_use_id": "toolu_9",
                      "message": {"content": [{"type": "text", "text": "balcony found"}]}}) + "\n"
        + json.dumps({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "toolu_1", "name": "Read",
             "input": {"file_path": "balcony.py"}}]}}) + "\n")
    with store.mutate("bot_chats/index", {}) as index:
        index["conv-tool"] = {"title": "tooling", "last_at": "2026-08-01T00:00:00"}
    assert _search(client, "balcony")["results"] == []


def test_search_matches_a_session_by_name_alone(client):
    # "the housing one" is a real way to look for a conversation, and it may
    # never say the word inside.
    _seed("conv-h", [("B", "ok")], title="Housing search")
    result = _search(client, "housing")["results"][0]
    assert result["title_hit"] is True and result["hits"] == []


def test_a_line_said_after_one_search_is_found_by_the_next_exactly_once(client):
    _seed("conv-a", [("B", "the mattress arrives thursday")])
    assert _search(client, "mattress")["results"][0]["count"] == 1
    assert _search(client, "pillow")["results"] == []
    # The conversation goes on: one whole new line, and one still being written.
    with open(_log("conv-a"), "a") as log:
        log.write(_said("K", "Order a pillow with the mattress."))
        log.write(_said("B", "and a duvet")[:-12])
    assert _search(client, "pillow")["results"][0]["count"] == 1
    # The earlier line wasn't indexed a second time, and the torn line isn't in yet.
    assert _search(client, "mattress")["results"][0]["count"] == 2
    assert _search(client, "duvet")["results"] == []
    # Once the torn line is finished it is found, not lost.
    _log("conv-a").write_text(
        _said("B", "the mattress arrives thursday")
        + _said("K", "Order a pillow with the mattress.") + _said("B", "and a duvet"))
    assert _search(client, "duvet")["results"][0]["count"] == 1
    assert _search(client, "mattress")["results"][0]["count"] == 2


def test_a_rewritten_log_drops_the_lines_that_are_gone(client):
    _seed("conv-a", [("B", "first draft about the garden"), ("K", "Noted, the garden.")])
    assert _search(client, "garden")["results"][0]["count"] == 2
    # Restoring a conversation to an earlier point rewrites its log shorter.
    _log("conv-a").write_text(_said("B", "start over"))
    assert _search(client, "garden")["results"] == []
    assert _search(client, "start")["results"][0]["count"] == 1


@pytest.mark.parametrize("q", ['(', 'a:b', 'AND', '"unclosed', 'what?!', '-only', "it's", "*", "a"])
def test_search_never_errors_on_odd_typing(client, q):
    _seed("conv-a", [("B", "anything at all")])
    response = client.get("/api/observatory/search", query_string={"q": q})
    assert response.status_code == 200
    assert isinstance(response.get_json()["results"], list)


def test_searching_what_was_done_finds_a_session_by_a_file_it_touched(client, tmp_path):
    _seed("conv-edit", [("B", "fix the drawing")])
    with open(_log("conv-edit"), "a") as log:
        for number in (1, 2):
            log.write(json.dumps({
                "type": "assistant", "timestamp": "2026-08-01T14:00:0%dZ" % number,
                "message": {"content": [{
                    "type": "tool_use", "id": "toolu_%d" % number, "name": "Edit",
                    "input": {"file_path": "/app/frontend/SwarmNetwork.tsx"}}]}}) + "\n")
    _seed("conv-talk", [("B", "should we rename SwarmNetwork.tsx")])
    empty = tmp_path / "no-harness-logs"
    empty.mkdir()
    toolcallstore.ingest(projects=empty)

    did = _search(client, "swarmnet", where="did")["results"]
    # Only the session that touched the file, not the one that talked about it;
    # two edits of one file are two calls but one thing to show.
    assert [r["id"] for r in did] == ["conv-edit"]
    assert did[0]["count"] == 2 and len(did[0]["hits"]) == 1
    assert did[0]["hits"][0]["who"] == "Edit"
    assert _marked(did[0]["hits"][0]) == ["swarmnet"]
    # And the spoken search finds the other one.
    assert [r["id"] for r in _search(client, "swarmnetwork")["results"]] == ["conv-talk"]


def test_recently_opened_lists_sessions_newest_first_closed_ones_included(client):
    _seed("conv-a", [("B", "a")], title="First")
    _seed("conv-b", [("B", "b")], title="Second", archived="2026-08-02T00:00:00")
    _seed("conv-c", [("B", "c")], title="Third")
    # Opens recorded by a browser before the list existed are handed over once.
    client.post("/api/observatory/opened", json={"opened": {
        "conv-a": "2026-08-01T10:00:00.000Z", "conv-b": "2026-08-02T10:00:00.000Z",
        "conv-gone": "2026-08-03T10:00:00.000Z", "conv-c": "not a time"}})
    recent = client.get("/api/observatory/recent").get_json()["sessions"]
    # A session that no longer exists is left out; a closed one is kept and flagged.
    assert [(s["id"], s["archived"]) for s in recent] == [("conv-b", True), ("conv-a", False)]

    # Opening a session now moves it to the top.
    assert client.post("/api/observatory/opened", json={"conv": "conv-a"}).status_code == 200
    recent = client.get("/api/observatory/recent").get_json()["sessions"]
    assert [s["id"] for s in recent] == ["conv-a", "conv-b"]
    assert recent[0]["title"] == "First"
    # Handing the old map over again doesn't pull it back down.
    client.post("/api/observatory/opened", json={"opened": {"conv-a": "2026-08-01T10:00:00.000Z"}})
    assert [s["id"] for s in client.get("/api/observatory/recent").get_json()["sessions"]] \
        == ["conv-a", "conv-b"]
    assert client.get("/api/observatory/recent?limit=1").get_json()["sessions"][0]["id"] == "conv-a"
    assert client.post("/api/observatory/opened", json={}).status_code == 400
