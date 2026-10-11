"""The frozen swarm demo (scripts/freeze_swarm.py, routes/swarm_demo.py).

Two promises are pinned here. The freeze shows a swarm as it stood at one
moment and nothing after it: states, summaries, lines and chats all stop
there, and only what a chat page draws is kept. And the public mirror serves
that file to a stranger while the live swarm routes stay shut.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import sqlstore
import store

AT = "2026-01-02T12:00:00"


def _chat(data_dir, conv, events):
    folder = data_dir / "bot_chats"
    folder.mkdir(exist_ok=True)
    (folder / f"{conv}.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")


def _said(text, utc):
    return {"type": "assistant", "timestamp": utc,
            "message": {"content": [{"type": "thinking", "thinking": "private thought"},
                                    {"type": "text", "text": text},
                                    {"type": "tool_use", "name": "Bash", "input": {"command": "cat secret"}}]}}


@pytest.fixture
def frozen(data_dir, monkeypatch):
    """A swarm of three with a helper, frozen at noon: one member mid-turn,
    one with questions open, one that handed on before noon. Everything has
    a later chapter that must not show."""
    monkeypatch.setenv("TZ", "UTC")
    import time
    time.tzset()
    (data_dir / "bot_chats").mkdir(exist_ok=True)
    store.write("bot_chats/index", {
        "busy": {"title": "busy one", "lane": "coding"},
        "asker": {"title": "asker", "lane": "coding"},
        "old": {"title": "old one", "lane": "coding"},
        "new": {"title": "old one (cont.)", "lane": "coding", "spawned_via": "continue",
                "spawned_from": "old", "started": "2026-01-02T11:00:00"},
        "late": {"title": "joined later", "lane": "coding"},
        "helper": {"title": "Swarm helper", "role": "swarm_helper", "swarm_id": 1},
    })
    conn = sqlstore.open_db()
    conn.execute("INSERT INTO swarms (id, name, lane, helper_conv, created_at, updated_at)"
                 " VALUES (1, 'Final name', 'coding', 'helper', '2026-01-02T10:00:00', '2026-01-03T10:00:00')")
    for conv, joined in (("busy", "10:00"), ("asker", "10:00"), ("old", "10:00"), ("new", "11:00")):
        conn.execute("INSERT INTO swarm_members (swarm_id, conv, joined_at) VALUES (1, ?, ?)",
                     (conv, f"2026-01-02T{joined}:00"))
    conn.execute("INSERT INTO swarm_members (swarm_id, conv, joined_at) VALUES (1, 'late', '2026-01-02T13:00:00')")
    for at, name, line in (("11:30", "Noon name", "busy is building"), ("12:30", "Final name", "busy is done")):
        conn.execute("INSERT INTO swarm_helper_runs (swarm_id, at, output) VALUES (1, ?, ?)",
                     (f"2026-01-02T{at}:00", json.dumps({"name": name, "summary": f"summary at {at}",
                                                         "members": [{"conv": "busy", "summary": line}]})))
    for at, a, b, text in (("11:10", "busy", "asker", "before one"), ("11:20", "asker", "busy", "before two"),
                           ("11:40", "helper", "busy", "helper before"), ("12:10", "busy", "asker", "AFTER")):
        conn.execute("INSERT INTO agent_messages (at, kind, from_conv, to_conv, text, mode, status)"
                     " VALUES (?, 'A', ?, ?, ?, 'inject', 'delivered')", (f"2026-01-02T{at}:00", a, b, text))
    conn.commit()
    conn.close()
    _chat(data_dir, "busy", [
        {"type": "user", "text": "build it", "ts": "2026-01-02T11:50:00"},
        {"type": "user", "message": {"content": "tool output: SECRET"}, "timestamp": "2026-01-02T11:51:00Z"},
        _said("on it", "2026-01-02T11:52:00Z"),
        {"type": "context-loaded", "text": "journal cards about a person", "ts": "2026-01-02T11:53:00"},
        _said("LATER WORDS", "2026-01-02T12:05:00Z"),
        {"type": "result", "timestamp": "2026-01-02T12:06:00Z"},
    ])
    _chat(data_dir, "asker", [
        {"type": "user", "text": "look into it", "ts": "2026-01-02T11:00:00"},
        {"type": "questions", "questions": ["which way?"], "ts": "2026-01-02T11:05:00"},
        {"type": "result"},
        {"type": "user", "text": "LATER ANSWER", "ts": "2026-01-02T12:30:00"},
    ])
    import freeze_swarm
    monkeypatch.delenv("EXOCORTEX_DATA_DIR", raising=False)
    freeze_swarm.main(["1", "--at", AT])
    return store.read(freeze_swarm.DRAFT_COLLECTION)


def test_the_freeze_shows_the_swarm_as_it_stood_and_nothing_later(frozen):
    swarm = frozen["swarm"]
    members = {m["conv"]: m for m in swarm["members"]}
    assert set(members) == {"busy", "asker", "old", "new"}          # `late` joined after
    assert members["busy"]["state"] == "working"                     # its turn hadn't ended
    assert members["asker"]["state"] == "needs_input"
    assert members["old"]["retired"] and not members["new"]["retired"]
    assert swarm["name"] == "Noon name" and swarm["summary"] == "summary at 11:30"
    assert members["busy"]["summary"] == "busy is building"
    assert frozen["sessions"]["asker"]["questions"] == ["which way?"]
    # The lines count only what had been sent, and match the messages kept.
    assert sorted((l["from"], l["to"], l["messages"]) for l in swarm["links"]) == \
        [("asker", "busy", 1), ("busy", "asker", 1)]
    assert swarm["helper_links"] == [{"to": "busy", "messages": 1}]
    assert swarm["continues"] == [{"from": "old", "to": "new"}]
    assert [m["text"] for m in frozen["messages"]] == ["before one", "before two", "helper before"]


def test_a_frozen_chat_keeps_only_what_a_chat_page_draws(frozen):
    whole = json.dumps(frozen)
    for kept_out in ("LATER", "AFTER", "SECRET", "private thought", "cat secret", "journal cards"):
        assert kept_out not in whole, kept_out
    assert [e["type"] for e in frozen["sessions"]["busy"]["events"]] == ["user", "assistant"]


def test_the_mirror_serves_the_frozen_swarm_and_keeps_the_live_one_shut(frozen, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_PUBLIC_ONLY", "1")
    monkeypatch.setenv("EXOCORTEX_FRAME_ANCESTORS", "https://example.org")
    import freeze_swarm
    import server
    mirror = server.app.test_client()
    # A draft alone is served to nobody; publishing it is what opens it.
    assert mirror.get("/api/demo/swarm").status_code == 404
    assert mirror.get("/api/demo/swarm/chat/busy").status_code == 404
    freeze_swarm.main(["--publish"])
    card = mirror.get("/api/demo/swarm").get_json()
    assert card["swarm"]["name"] == "Noon name"
    assert all("events" not in session for session in card["sessions"].values())
    chat = mirror.get("/api/demo/swarm/chat/busy").get_json()
    assert [e["type"] for e in chat["events"]] == ["user", "assistant"]
    assert mirror.get("/api/demo/swarm/chat/late").status_code == 404
    assert mirror.get("/demo/swarm?embed=1").headers["Content-Security-Policy"] == \
        "frame-ancestors https://example.org"
    for shut in ("/api/swarms", "/api/swarms/1", "/api/observatory/conversation/busy"):
        assert mirror.get(shut).status_code == 401, shut


def test_no_frozen_file_means_not_found(data_dir, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_PUBLIC_ONLY", "1")
    import server
    assert server.app.test_client().get("/api/demo/swarm").status_code == 404
