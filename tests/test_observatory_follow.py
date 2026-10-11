"""Following a turn from a process that doesn't own it — which is all of them.

A turn runs in its own process now (scripts/turn_host.py), so no watcher has a
privileged view of it: the tab that sent it, the other gunicorn worker and a
phone reconnecting an hour later all do the same thing, which is read the
transcript as it's appended. This file covers that reading.

Every stream closes with two frames, in this order: `done` (the turn ended) and
`follow_end` (the stream ended). They answer different questions — an SSE
reader can't otherwise tell a finished reply from a dropped connection — and
both go to every watcher, because one shape for all of them is worth more than
saving a frame.

The case worth the most care is the torn line. Events are appended while this
is reading, so a read can land mid-write — and handing a client half an event,
or skipping past the rest of it, silently corrupts a reply in a way nothing
downstream can repair.
"""
import json

import pytest
from flask import Flask

import store
from routes import observatory


@pytest.fixture
def follow_client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    observatory.register(app)
    return app.test_client()


def write_log(conv_id, events, partial=None):
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")
        if partial is not None:
            fh.write(partial)          # no trailing newline: a write in flight
    return path


def idle(conv_id):
    """An index entry for a conversation whose turn has finished."""
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {conv_id: {"running": False}})


def events_from(response):
    out = []
    for line in response.get_data(as_text=True).splitlines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out


def test_follow_streams_the_events_already_on_disk(follow_client):
    write_log("c1", [{"type": "user", "text": "hi"},
                     {"type": "assistant", "n": 1}])
    idle("c1")
    got = events_from(follow_client.get("/api/observatory/conversation/c1/follow"))
    assert [e.get("type") for e in got] == ["user", "assistant", "done", "follow_end"]


def test_from_skips_what_the_client_already_has(follow_client):
    """`from` is the length of the events array the conversation route just
    returned — so loading then following has no gap and no duplicate."""
    write_log("c1", [{"type": "user"}, {"type": "assistant", "n": 1},
                     {"type": "assistant", "n": 2}])
    idle("c1")
    got = events_from(follow_client.get(
        "/api/observatory/conversation/c1/follow?from=2"))
    assert [e.get("type") for e in got] == ["assistant", "done", "follow_end"]
    assert got[0]["n"] == 2


def test_a_half_written_event_is_never_handed_over(follow_client):
    """The load-bearing one. A line with no newline yet is a write in progress;
    emitting it would give the client a truncated event, and counting it would
    skip the real one when it lands."""
    write_log("c1", [{"type": "assistant", "n": 1}],
              partial='{"type": "assistant", "n": 2, "text": "half a th')
    idle("c1")
    got = events_from(follow_client.get("/api/observatory/conversation/c1/follow"))
    assert [e.get("type") for e in got] == ["assistant", "done", "follow_end"]
    assert got[0]["n"] == 1
    # ...and the count reported back excludes it, so the client's next `from`
    # picks the completed event up rather than stepping over it.
    assert got[-1]["count"] == 1


def test_follow_end_reports_the_count_to_reconnect_with(follow_client):
    write_log("c1", [{"type": "user"}, {"type": "assistant"}])
    idle("c1")
    got = events_from(follow_client.get("/api/observatory/conversation/c1/follow"))
    assert got[-1] == {"type": "follow_end", "count": 2}


def test_a_torn_historical_line_costs_only_itself(follow_client):
    path = write_log("c1", [{"type": "user"}])
    with path.open("a") as fh:
        fh.write("{not json at all}\n")
        fh.write(json.dumps({"type": "assistant"}) + "\n")
    idle("c1")
    got = events_from(follow_client.get("/api/observatory/conversation/c1/follow"))
    assert [e.get("type") for e in got] == ["user", "assistant", "done", "follow_end"]


def test_a_conversation_with_no_log_yet_ends_cleanly(follow_client):
    idle("c1")
    got = events_from(follow_client.get("/api/observatory/conversation/c1/follow"))
    assert got == [{"type": "done", "conversation_id": "c1"},
                   {"type": "follow_end", "count": 0}]


def test_a_junk_conversation_id_is_refused(follow_client):
    res = follow_client.get("/api/observatory/conversation/..%2Fetc/follow")
    assert res.status_code in (400, 404)


def test_follow_picks_up_events_written_while_it_is_watching(follow_client):
    """The behaviour the whole endpoint exists for: the turn is still going,
    events land after the stream opened, and the watcher gets them without
    re-reading the transcript from the top."""
    import threading
    import time as _t

    path = write_log("c1", [{"type": "user"}])
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"c1": {"running": True,
                                           "last_at": __import__("datetime")
                                           .datetime.now().isoformat()}})

    def keep_writing():
        for n in (1, 2, 3):
            _t.sleep(0.3)
            with path.open("a") as fh:
                fh.write(json.dumps({"type": "assistant", "n": n}) + "\n")
        _t.sleep(0.3)
        store.write("bot_chats/index", {"c1": {"running": False}})

    writer = threading.Thread(target=keep_writing)
    writer.start()
    try:
        got = events_from(follow_client.get(
            "/api/observatory/conversation/c1/follow?from=1"))
    finally:
        writer.join()

    assert [e.get("n") for e in got if e.get("type") == "assistant"] == [1, 2, 3]
    assert got[-1] == {"type": "follow_end", "count": 4}


# --- the typing and the message, in step --------------------------------------
# A reply reaches a watcher through two files: the transcript (finished
# messages) and the `.live` sidecar (the typing). The writer puts the typing on
# disk before the message it built. These hold the watcher to the same order.

def _delta(text):
    return {"type": "stream_event", "event": {
        "type": "content_block_delta",
        "delta": {"type": "text_delta", "text": text}}}


def _spoken(text):
    return {"type": "assistant", "message": {
        "role": "assistant", "content": [{"type": "text", "text": text}]}}


def test_a_message_is_never_sent_ahead_of_its_typing(follow_client, monkeypatch):
    """The duplicated tail. The agent finishes a message in the gap between
    the watcher's two reads: the rest of the typing and the message land
    together. Whichever file the watcher reads second sees the new write; if
    that is the transcript, the message goes out without the typing before it,
    and the typing follows as if it were new words."""
    chats = store.DATA_DIR / "bot_chats"
    log = write_log("c1", [{"type": "user", "text": "hi"}])
    live = chats / "c1.live"
    live.write_text(json.dumps(_delta("The whole ")) + "\n")
    store.write("bot_chats/index", {"c1": {
        "running": True,
        "last_at": __import__("datetime").datetime.now().isoformat()}})

    real_read = observatory._read_whole_lines
    reads = []

    def read_then_the_agent_writes(path, offset):
        got = real_read(path, offset)
        reads.append(path)
        if len(reads) == 1:
            # Between the first read and the second: typing first, then the
            # message — the order _run_turn writes them in.
            with live.open("a") as fh:
                fh.write(json.dumps(_delta("reply.")) + "\n")
            with log.open("a") as fh:
                fh.write(json.dumps(_spoken("The whole reply.")) + "\n")
            store.write("bot_chats/index", {"c1": {"running": False}})
        return got

    monkeypatch.setattr(observatory, "_read_whole_lines", read_then_the_agent_writes)
    monkeypatch.setattr(observatory, "_FOLLOW_POLL_SEC", 0.01)
    got = events_from(follow_client.get(
        "/api/observatory/conversation/c1/follow?from=1"))

    # A watcher that joins late takes the typing from where it joined, so
    # "The whole " is not replayed — what matters is that "reply." comes
    # before the message that already contains it.
    assert [e["type"] for e in got] == [
        "stream_event", "assistant", "done", "follow_end"]
    assert got[0]["event"]["delta"]["text"] == "reply."


def test_a_stream_that_hits_its_time_limit_does_not_say_the_turn_is_done(
        follow_client, monkeypatch):
    """`done` is what the chat closes a reply on. A stream that is closed only
    because it has been open too long, with the agent still working, must not
    send it — that showed a half-hour turn as finished while it was still
    writing. It says the turn is still running instead."""
    write_log("c1", [{"type": "user", "text": "hi"}, _spoken("Starting.")])
    store.write("bot_chats/index", {"c1": {
        "running": True,
        "last_at": __import__("datetime").datetime.now().isoformat()}})
    monkeypatch.setattr(observatory, "_FOLLOW_MAX_SEC", 0)
    monkeypatch.setattr(observatory, "_FOLLOW_POLL_SEC", 0.01)
    got = events_from(follow_client.get("/api/observatory/conversation/c1/follow"))
    assert [e["type"] for e in got] == ["user", "assistant", "follow_end"]
    assert got[-1] == {"type": "follow_end", "count": 2, "running": True}


# --- the reader, directly -----------------------------------------------------

def test_read_whole_lines_resumes_from_its_own_offset(data_dir):
    path = write_log("c1", [{"a": 1}])
    lines, offset = observatory._read_whole_lines(path, 0)
    assert len(lines) == 1
    with path.open("a") as fh:
        fh.write(json.dumps({"a": 2}) + "\n")
    more, offset2 = observatory._read_whole_lines(path, offset)
    assert [json.loads(m)["a"] for m in more] == [2]
    assert offset2 > offset


def test_read_whole_lines_holds_a_partial_line_until_it_is_finished(data_dir):
    path = write_log("c1", [{"a": 1}], partial='{"a": 2')
    lines, offset = observatory._read_whole_lines(path, 0)
    assert len(lines) == 1
    # The rest of the event arrives; now it reads as one whole line.
    with path.open("a") as fh:
        fh.write('}\n')
    more, _ = observatory._read_whole_lines(path, offset)
    assert [json.loads(m)["a"] for m in more] == [2]
