"""File alerts (file_alerts.py), driven the way the live site drives them:
sessions' tool calls folded into tool_calls by toolcallstore.live_ingest, a
real git checkout, the minute tick, the real mailbox and the real helper seed.

What these pin: two open sessions in one file (or one working from a copy
another has changed, unless it read the file again) are written down once
for the helpers — the room helper's files section and every helper chat's
seed list them — and no session is told anything or woken; never a
continuation, a helper or a finished session; switched off, nothing is
written; and a mailbox made before rung 42 is rebuilt without losing a message.
"""
import json
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta, timezone

import pytest

import edited_files
import file_alerts
import helper_chat
import peermail
import sqlstore
import store
import toolcallstore
from routes import observatory

ANNA, BEN, CARA = "2026-09-30.090000", "2026-09-30.091000", "2026-09-30.092000"
HELPER = "2026-09-30.080000"


@pytest.fixture
def repo(data_dir, tmp_path):
    """A checkout with three committed files, all three then changed."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git = ["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    for name in ("pond.py", "notes.py", "garden.py"):
        (repo / name).write_text("x = 1\n")
    subprocess.run(git + ["add", "."], check=True)
    subprocess.run(git + ["commit", "-qm", "start"], check=True)
    for name in ("pond.py", "notes.py", "garden.py"):
        (repo / name).write_text("x = 2\n")
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    return repo


def _open(conv, **fields):
    with store.mutate("bot_chats/index", {}) as index:
        index[conv] = {"title": f"title {conv[-6:]}", "lane": "coding",
                       "last_at": datetime.now().isoformat(timespec="seconds"), **fields}


def _did(conv, name, tool_input, minutes_ago=0):
    """One tool call in a session's log, folded into tool_calls the way a
    running turn does it."""
    stamp = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    path = store.DATA_DIR / "bot_chats" / f"{conv}.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"type": "assistant", "timestamp": stamp.replace("+00:00", "Z"),
                            "message": {"content": [{
                                "type": "tool_use", "id": f"toolu_{conv}_{time.monotonic_ns()}",
                                "name": name, "input": tool_input}]}}) + "\n")
    toolcallstore.live_ingest(path, conv)


def _edit(conv, file, minutes_ago=0):
    _did(conv, "Edit", {"file_path": str(file), "old_string": "1", "new_string": "2"},
         minutes_ago)


def test_overlaps_are_written_down_once_for_the_room_helper_and_no_session_is_told(repo):
    for conv in (ANNA, BEN, CARA):
        _open(conv)
    # Anna and Ben both change pond.py — Ben through a Bash heredoc. Cara read
    # notes.py and garden.py before Anna changed them, and garden.py again after.
    _did(CARA, "Bash", {"command": "cat notes.py | head -40"}, minutes_ago=30)
    _did(CARA, "Read", {"file_path": str(repo / "garden.py")}, minutes_ago=30)
    _edit(ANNA, repo / "pond.py", minutes_ago=20)
    _edit(ANNA, repo / "notes.py", minutes_ago=10)
    _edit(ANNA, repo / "garden.py", minutes_ago=10)
    _did(CARA, "Read", {"file_path": str(repo / "garden.py")}, minutes_ago=5)
    _did(BEN, "Bash", {"command": "python3 - <<'EOF'\np='pond.py'; s=open(p).read()\n"
                                  "open(p,'w').write(s.replace('1','2'))\nEOF"})
    # Words about a file aren't an edit of it: Cara only says she'll leave it alone.
    _did(CARA, "Bash", {"command": 'scripts/peers.py send x "Noted; I won\'t touch pond.py,'
                                   ' or rm notes.py"'})
    assert "Overlaps the app has noticed" not in edited_files.section("coding", repo=repo)

    assert file_alerts.tick(repo=repo) == 2
    # Nothing reaches any session: nothing in a mailbox, no turn to start, no hook.
    assert [peermail.waiting(conv) for conv in (ANNA, BEN, CARA)] == [[], [], []]
    assert observatory.drain_all_inbox() == 0
    settings = observatory._session_settings(
        {"conv_id": ANNA, "lane": "coding", "act_gate": False, "guard_docs": False},
        ["Read", "Edit", "Bash"])
    assert "file_alert_hook.py" not in json.dumps(settings)

    # The room helper is shown both, each marked as told to nobody.
    noticed = edited_files.section("coding", repo=repo).split(
        "## Overlaps the app has noticed")[1].strip().splitlines()[2:]
    assert len(noticed) == 2 and all("nobody told" in line for line in noticed)
    pond, = [line for line in noticed if "`pond.py`" in line]
    notes, = [line for line in noticed if "`notes.py`" in line]
    assert ANNA in pond and BEN in pond and "both changed it" in pond
    assert f"`{ANNA}` changed it after `{CARA}` read it" in notes

    # A helper's chat is shown the same list, at the end of its seed's sessions part.
    entry = {"role": "room_helper", "room": "coding"}
    found, finished, place = helper_chat.sessions(entry, repo=repo)
    seeded = helper_chat._sessions_section(entry, found, finished, place, repo=repo).split(
        "## Overlaps the app has noticed")[1]
    assert pond in seeded and notes in seeded

    # More edits, more minutes: each pair and file is written down only once.
    _edit(ANNA, repo / "pond.py")
    assert file_alerts.tick(repo=repo) == 0


def test_a_continuation_a_helper_and_a_finished_session_are_never_part_of_an_overlap(repo):
    # Anna handed her work on to Ben: one line of work, not two sessions colliding.
    _open(ANNA, continued_by=BEN, archived=True)
    _open(BEN, spawned_from=ANNA, spawned_via="continue")
    _open(CARA, done_at="2026-09-30T09:30:00")
    _open(HELPER, role="room_helper", room="coding")
    for conv in (ANNA, BEN, CARA, HELPER):
        _edit(conv, repo / "pond.py")

    assert file_alerts.tick(repo=repo) == 0

    # A pair written down once stays so after one of them hands off: an
    # overlap is per line of work, so Ben's successor and Dana aren't new.
    dana, erin = "2026-09-30.093000", "2026-09-30.094000"
    _open(dana)
    _edit(dana, repo / "pond.py")
    assert file_alerts.tick(repo=repo) == 1
    with store.mutate("bot_chats/index", {}) as index:
        index[BEN].update(continued_by=erin, archived=True)
        index[erin] = {"title": "erin", "lane": "coding", "spawned_from": BEN,
                       "spawned_via": "continue"}
    _edit(erin, repo / "pond.py")
    assert file_alerts.tick(repo=repo) == 0


def test_switched_off_nothing_is_written_down(repo, monkeypatch):
    _open(ANNA)
    _open(BEN)
    _edit(ANNA, repo / "pond.py")
    _edit(BEN, repo / "pond.py")
    monkeypatch.setattr(file_alerts.config, "FILE_OVERLAPS", False)
    assert file_alerts.tick(repo=repo) == 0
    assert "Overlaps the app has noticed" not in edited_files.section("coding", repo=repo)


@pytest.mark.fresh_db
def test_a_mailbox_made_before_rung_42_is_rebuilt_with_every_message_kept(data_dir):
    """Rung 42 on a database whose mailbox only allows kinds A and B."""
    conn = sqlite3.connect(data_dir / "exo.db")
    conn.execute(
        "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, at TEXT NOT NULL,"
        " kind TEXT NOT NULL CHECK (kind IN ('A','B')), from_conv TEXT, to_conv TEXT NOT NULL,"
        " text TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'inject', hops INTEGER NOT NULL"
        " DEFAULT 0, status TEXT NOT NULL DEFAULT 'waiting', held_reason TEXT,"
        " delivered_at TEXT, delivered_how TEXT, record INTEGER NOT NULL DEFAULT 1)")
    conn.execute("INSERT INTO agent_messages (id, at, kind, from_conv, to_conv, text)"
                 " VALUES (7, '2026-09-30T09:00:00', 'A', ?, ?, 'kept')", (ANNA, BEN))
    conn.execute("PRAGMA user_version = 41")
    conn.commit()
    conn.close()

    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    _open(BEN)
    assert [(r["id"], r["kind"], r["text"]) for r in peermail.waiting(BEN)] == [(7, "A", "kept")]
    conn = sqlstore.open_db()
    try:
        indexes = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE tbl_name = 'agent_messages'")}
    finally:
        conn.close()
    assert {"agent_messages_waiting", "agent_messages_by_day"} <= indexes
