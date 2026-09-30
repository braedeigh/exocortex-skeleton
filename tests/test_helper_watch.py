"""A helper's watches (watches.py), driven the way a helper uses them.

What these pin: a watch set from the helper's chat fires when the watched
session does what it waits for — AFTER the watch was set, never before —
and wakes the helper's chat exactly once, as a System turn that starts from
the helper's seed. Watches of one helper firing in the same minute share one
message. A watch follows its session into a continuation. A session that
goes silent counts as stalled only when nothing is waiting on her. And the
helper's seed lists what it has open.
"""
import json
import os
import time
from datetime import datetime, timedelta

import pytest

import store
import watches
from routes import observatory

HELPER = "2026-09-30.090000"
WORKER = "2026-09-30.091500"
OTHER = "2026-09-30.092000"


def _seed(conv, **fields):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index[conv] = {"title": f"title {conv}", "lane": "coding",
                       "last_at": datetime.now().isoformat(timespec="seconds"), **fields}


def _log(conv, *lines):
    with open(store.DATA_DIR / "bot_chats" / f"{conv}.jsonl", "a", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


def _commit(tool_id, output):
    """A Bash `git commit` call and its result, as a transcript records them."""
    return (
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": tool_id, "name": "Bash",
             "input": {"command": "git add x.py && git commit -q -m 'Ship it'"
                                  " && git log --oneline -1"}}]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": output}]}})


@pytest.fixture
def turns(data_dir, monkeypatch):
    """Turn launches recorded instead of run: (conv, text, config) each."""
    started = []
    monkeypatch.setattr(observatory, "_mem_available_mb", lambda: None)
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, resume_sid, conv_id, log_path:
                        started.append((conv_id, text, config)) or True)
    _seed(HELPER, role="room_helper", room="coding", bot="helper")
    _seed(WORKER)
    return started


def test_a_watch_fires_once_on_new_news_and_wakes_the_helpers_chat(turns):
    # A commit made before the watch is old news.
    _log(WORKER, *_commit("t1", "1111111 An older commit"))
    watch = watches.add(HELPER, WORKER, ["committed", "done"], "tell her when the board ships")
    assert watches.tick() == 0 and turns == []

    _log(WORKER, *_commit("t2", "a15f1a7 Linear room: live board"))
    assert watches.tick() == 1
    [(conv, text, config)] = turns
    assert conv == HELPER
    assert "tell her when the board ships" in text and "committed a15f1a7 Linear room" in text
    assert "An older commit" not in text
    # It's a System turn in the helper's chat, started from its seed.
    seed = open(config["system_prompt_file"], encoding="utf-8").read()
    assert "# Your open watches" in seed
    log = (store.DATA_DIR / "bot_chats" / f"{HELPER}.jsonl").read_text().splitlines()
    assert json.loads(log[-1])["type"] == "reminder"
    assert watches.get(watch["id"])["status"] == "fired"

    # Fired once: more news, another minute, the helper free again — no second wake.
    with store.mutate("bot_chats/index", {}) as index:
        index[HELPER]["running"] = False
    _log(WORKER, *_commit("t3", "b26e2b8 Another"))
    assert watches.tick() == 0 and len(turns) == 1


def test_watches_firing_together_share_one_message(turns):
    _seed(OTHER)
    first = watches.add(HELPER, WORKER, ["asked"], "tell her when it needs her key")
    second = watches.add(HELPER, OTHER, ["done"], "tell her when the docs are done")
    _log(WORKER, {"type": "questions", "questions": ["Paste your Linear API key?"]})
    observatory.mark_done(OTHER, "Docs written and committed")
    assert watches.tick() == 1
    [(_, text, _)] = turns
    assert f"Watch #{first['id']}" in text and f"Watch #{second['id']}" in text
    assert "asked her: Paste your Linear API key?" in text
    assert "marked itself done: Docs written and committed" in text


def test_a_watch_follows_its_session_into_a_continuation(turns):
    watch = watches.add(HELPER, WORKER, ["error"], "tell her if it breaks")
    _seed(OTHER, spawned_from=WORKER, spawned_via="continue")
    with store.mutate("bot_chats/index", {}) as index:
        index[WORKER].update(continued_by=OTHER, archived=True)
    # A handoff alone isn't news, and isn't a close.
    assert watches.tick() == 0
    assert watches.get(watch["id"])["conv"] == OTHER
    _log(OTHER, {"type": "error", "error": "claude exited 1"})
    assert watches.tick() == 1
    assert "hit an error: claude exited 1" in turns[0][1]


def test_stalled_means_silent_with_nothing_waiting_on_her(turns):
    long_ago = (datetime.now() - timedelta(hours=3)).isoformat(timespec="seconds")
    with store.mutate("bot_chats/index", {}) as index:
        index[WORKER].update(last_at=long_ago, awaiting_input="Which colour?")
    _log(WORKER, {"type": "user", "text": "build it"})
    old = time.time() - 3 * 3600
    os.utime(store.DATA_DIR / "bot_chats" / f"{WORKER}.jsonl", (old, old))
    watch = watches.add(HELPER, WORKER, ["stalled"], "tell her if it gets stuck",
                        now=long_ago)
    # Quiet, but waiting on her answer: not stalled.
    assert watches.tick() == 0
    with store.mutate("bot_chats/index", {}) as index:
        index[WORKER].pop("awaiting_input")
    assert watches.tick() == 1
    assert "has written nothing for" in turns[0][1] and "not done" in turns[0][1]
    assert watches.get(watch["id"])["status"] == "fired"


def test_the_door_refuses_what_cant_be_watched(turns):
    with pytest.raises(watches.WatchError):
        watches.add(HELPER, WORKER, ["shipped"], "a kind that doesn't exist")
    with pytest.raises(watches.WatchError):
        watches.add(HELPER, WORKER, ["done"], "   ")
    with pytest.raises(watches.WatchError):
        watches.add(HELPER, HELPER, ["done"], "watching itself")
    # Setting the same watch again rewrites its promise rather than doubling it.
    first = watches.add(HELPER, WORKER, [], "tell her when it's done")
    again = watches.add(HELPER, WORKER, [], "tell her when it's done, with the hash")
    assert again["id"] == first["id"] and again["updated"]
    assert first["kinds"] == list(watches.DEFAULT_KINDS)
    assert [w["note"] for w in watches.listing(HELPER)] == ["tell her when it's done, with the hash"]
