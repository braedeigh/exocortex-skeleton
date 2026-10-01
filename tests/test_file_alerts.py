"""File alerts (file_alerts.py), driven the way the live site drives them:
sessions' tool calls folded into tool_calls by toolcallstore.live_ingest, a
real git checkout, the minute tick, the real mailbox and the real turn loop.

What these pin, as the app runs by default: two open sessions in one file (or
one working from a copy another has changed) are written down once for the
room helper, whose files section lists them — and no session is told
anything, by notice or by hook; never a continuation, a helper or a finished
session.

And with the switch that tells the sessions turned on (the `telling`
fixture): each is told once; the reader of a stale copy is told and the one
that changed it is not, unless the reader read the file again; an idle
session isn't woken by an alert but gets it with its next turn, and a working
one reads it between its steps; the pre-edit hook warns the session making
the edit and tells the other, once; and a mailbox made before notices existed
is rebuilt without losing a message.
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import edited_files
import file_alerts
import peermail
import sqlstore
import store
import toolcallstore
from routes import observatory
from tests.test_observatory_routes import bot_client  # noqa: F401  (a fixture)
from tests.test_peer_turns import streaming, _run  # noqa: F401  (streaming is a fixture)

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


@pytest.fixture
def telling(monkeypatch):
    """Turn on the switch that tells the sessions themselves (off by default)."""
    monkeypatch.setattr(file_alerts.config, "FILE_ALERTS", True)


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


def _notices(conv):
    """The alerts sitting in a session's mailbox, as their texts."""
    return [r["text"] for r in peermail.waiting(conv) if r["kind"] == peermail.NOTICE]


def test_overlaps_are_written_down_once_for_the_room_helper_and_no_session_is_told(repo):
    for conv in (ANNA, BEN, CARA):
        _open(conv)
    # Anna and Ben both change pond.py; Cara read notes.py before Anna changed it.
    _did(CARA, "Bash", {"command": "cat notes.py | head -40"}, minutes_ago=30)
    _edit(ANNA, repo / "pond.py", minutes_ago=20)
    _edit(ANNA, repo / "notes.py", minutes_ago=10)
    _edit(BEN, repo / "pond.py")
    assert "Overlaps the app has noticed" not in edited_files.section("coding", repo=repo)

    assert file_alerts.tick(repo=repo) == 2
    # Nothing reaches any session: no notice waiting, no turn to start, no hook.
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

    # More edits, more minutes: each pair and file is written down only once.
    _edit(ANNA, repo / "pond.py")
    assert file_alerts.tick(repo=repo) == 0


def test_two_sessions_in_one_file_are_each_told_once_and_only_those_two(repo, telling):
    for conv in (ANNA, BEN, CARA):
        _open(conv)
    # Anna edits with the Edit tool, Ben through a Bash heredoc; Cara is elsewhere.
    _edit(ANNA, repo / "pond.py", minutes_ago=20)
    _did(BEN, "Bash", {"command": "python3 - <<'EOF'\np='pond.py'; s=open(p).read()\n"
                                  "open(p,'w').write(s.replace('1','2'))\nEOF"})
    _edit(CARA, repo / "garden.py")
    # Words about a file aren't an edit of it: Cara only says she'll leave it alone.
    _did(CARA, "Bash", {"command": 'scripts/peers.py send x "Noted; I won\'t touch pond.py,'
                                   ' or rm notes.py"'})

    assert file_alerts.tick(repo=repo) == 1
    (to_anna,), (to_ben,) = _notices(ANNA), _notices(BEN)
    # Each is told the file, the other session by id and title, and what to do.
    assert "`pond.py`" in to_anna and BEN in to_anna and "title 091000" in to_anna
    assert "`pond.py`" in to_ben and ANNA in to_ben and f"peers.py send {ANNA}" in to_ben
    assert _notices(CARA) == []

    # More edits, more minutes: the pair is never told about that file again.
    _edit(ANNA, repo / "pond.py")
    assert file_alerts.tick(repo=repo) == 0
    assert len(_notices(ANNA)) == len(_notices(BEN)) == 1


def test_a_continuation_a_helper_and_a_finished_session_are_never_alerted(repo, telling):
    # Anna handed her work on to Ben: one line of work, not two sessions colliding.
    _open(ANNA, continued_by=BEN, archived=True)
    _open(BEN, spawned_from=ANNA, spawned_via="continue")
    _open(CARA, done_at="2026-09-30T09:30:00")
    _open(HELPER, role="room_helper", room="coding")
    for conv in (ANNA, BEN, CARA, HELPER):
        _edit(conv, repo / "pond.py")

    assert file_alerts.tick(repo=repo) == 0
    assert [_notices(conv) for conv in (ANNA, BEN, CARA, HELPER)] == [[], [], [], []]

    # A pair told once stays told after one of them hands off: the alert is
    # per line of work, so Ben's successor isn't alerted about Dana again.
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


def test_a_session_that_read_a_file_before_another_changed_it_is_told_its_copy_is_stale(
        repo, telling):
    for conv in (ANNA, BEN, CARA):
        _open(conv)
    # Ben reads pond.py with the Read tool, Cara reads notes.py with `cat`;
    # then Anna changes both. Ben reads pond.py again afterwards; Cara doesn't.
    _did(BEN, "Read", {"file_path": str(repo / "pond.py")}, minutes_ago=30)
    _did(CARA, "Bash", {"command": "cat notes.py | head -40"}, minutes_ago=30)
    _edit(ANNA, repo / "pond.py", minutes_ago=10)
    _edit(ANNA, repo / "notes.py", minutes_ago=10)
    _did(BEN, "Read", {"file_path": str(repo / "pond.py")}, minutes_ago=5)

    assert file_alerts.tick(repo=repo) == 1
    assert _notices(BEN) == []                        # read it again: nothing stale
    (to_cara,) = _notices(CARA)
    assert "`notes.py`" in to_cara and "after you last read it" in to_cara and ANNA in to_cara
    assert _notices(ANNA) == []                       # she made the change: nothing to do


def test_an_idle_session_isnt_woken_and_gets_the_alert_with_its_next_turn(
        repo, monkeypatch, telling):
    started = []
    monkeypatch.setattr(observatory, "_mem_available_mb", lambda: None)
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, resume_sid, conv_id, log_path:
                        started.append((conv_id, text)) or True)
    _open(ANNA)
    _open(BEN)
    _edit(ANNA, repo / "pond.py")
    _edit(BEN, repo / "pond.py")
    file_alerts.tick(repo=repo)

    # The minute safety net finds the notices waiting and starts nothing.
    assert observatory.drain_all_inbox() == 0 and started == []
    assert len(_notices(ANNA)) == 1

    # Another agent's message does start a turn, and the alert rides along.
    observatory.peer_send(BEN, ANNA, "are you in pond.py?")
    (conv, text), = started
    assert conv == ANNA and "File alert" in text and "are you in pond.py?" in text
    assert _notices(ANNA) == []


def test_a_working_session_reads_the_alert_between_its_steps(repo, streaming, telling):
    streaming(hold=5)
    _open(ANNA)
    _open(BEN)
    _edit(BEN, repo / "pond.py")
    # Anna is mid-turn when the minute check finds her edit colliding with Ben's.
    result = observatory.begin_turn(ANNA, "carry on")
    assert result["ok"], result
    _edit(ANNA, repo / "pond.py")
    file_alerts.tick(repo=repo)
    deadline = time.time() + 20
    while time.time() < deadline and store.read("bot_chats/index", {})[ANNA].get("running"):
        time.sleep(0.05)

    lines = [json.loads(l) for l in
             (store.DATA_DIR / "bot_chats" / f"{ANNA}.jsonl").read_text().splitlines()]
    # She read it in that same turn, and her chat shows it as a System bubble.
    heard = next(l for l in lines if l.get("type") == "assistant" and "heard:" in json.dumps(l))
    assert "File alert" in json.dumps(heard) and BEN in json.dumps(heard)
    assert [l["source"] for l in lines if l.get("type") == "reminder"] == ["notice"]
    assert _notices(ANNA) == []


def test_the_pre_edit_hook_warns_the_editor_and_tells_the_other_once(repo, telling):
    _open(ANNA)
    _open(BEN)
    _edit(BEN, repo / "pond.py", minutes_ago=15)
    edit = {"file_path": str(repo / "pond.py"), "old_string": "2", "new_string": "3"}

    # Anna is about to edit the file Ben changed: she's warned as the edit goes in.
    warning = file_alerts.before_edit(ANNA, "Edit", edit, repo=repo)
    assert "`pond.py`" in warning and BEN in warning
    (to_ben,) = _notices(BEN)
    assert ANNA in to_ben and "just now" in to_ben
    assert _notices(ANNA) == []                       # she was told on the spot

    # The same edit again, a Bash edit of it, and the minute check: nothing more.
    assert file_alerts.before_edit(ANNA, "Edit", edit, repo=repo) is None
    assert file_alerts.before_edit(ANNA, "Bash", {"command": "sed -i s/2/3/ pond.py"},
                                   repo=repo) is None
    _edit(ANNA, repo / "pond.py")
    assert file_alerts.tick(repo=repo) == 0
    assert len(_notices(BEN)) == 1

    # A file nobody else touched, and a Bash command that only reads: no warning.
    assert file_alerts.before_edit(ANNA, "Write", {"file_path": str(repo / "new.py")},
                                   repo=repo) is None
    assert file_alerts.before_edit(BEN, "Bash", {"command": "grep -n x garden.py"},
                                   repo=repo) is None


def test_the_hook_script_adds_the_warning_and_never_blocks(repo):
    """The script Claude Code runs (tools/file_alert_hook.py), end to end."""
    _open(ANNA)
    _open(BEN)
    _edit(BEN, repo / "pond.py")
    hook = Path(file_alerts.__file__).resolve().parent / "tools" / "file_alert_hook.py"
    env = {**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR), "EXOCORTEX_CONV_ID": ANNA,
           "EXOCORTEX_FILE_ALERTS": "1"}

    def run(event):
        return subprocess.run([sys.executable, str(hook), "--repo", str(repo)],
                              input=event, env=env,
                              capture_output=True, text=True, timeout=30)

    done = run(json.dumps({"tool_name": "Edit", "cwd": str(repo),
                           "tool_input": {"file_path": str(repo / "pond.py")}}))
    out = json.loads(done.stdout)["hookSpecificOutput"]
    assert done.returncode == 0 and out["hookEventName"] == "PreToolUse"
    assert BEN in out["additionalContext"] and "permissionDecision" not in out
    # Garbage in, or a call that isn't an edit: silence and a clean exit.
    for event in ("not json", json.dumps({"tool_name": "Bash",
                                          "tool_input": {"command": "ls 2>&1"}})):
        done = run(event)
        assert (done.returncode, done.stdout) == (0, "")


def test_with_both_switches_off_nothing_is_written_down_or_said(repo, monkeypatch):
    _open(ANNA)
    _open(BEN)
    _edit(ANNA, repo / "pond.py")
    _edit(BEN, repo / "pond.py")
    monkeypatch.setattr(file_alerts.config, "FILE_OVERLAPS", False)
    assert file_alerts.tick(repo=repo) == 0
    assert "Overlaps the app has noticed" not in edited_files.section("coding", repo=repo)
    assert file_alerts.before_edit(ANNA, "Edit", {"file_path": str(repo / "pond.py")},
                                   repo=repo) is None
    assert _notices(ANNA) == _notices(BEN) == []


@pytest.mark.fresh_db
def test_a_mailbox_made_before_notices_is_rebuilt_with_every_message_kept(data_dir):
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
    peermail.send_notice(BEN, "a notice")              # refused by the old table
    assert [(r["id"], r["kind"], r["text"]) for r in peermail.waiting(BEN)] == [
        (7, "A", "kept"), (8, "S", "a notice")]
    conn = sqlstore.open_db()
    try:
        indexes = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE tbl_name = 'agent_messages'")}
    finally:
        conn.close()
    assert {"agent_messages_waiting", "agent_messages_by_day"} <= indexes


def test_only_sessions_that_can_edit_in_a_watched_room_carry_the_hook(data_dir, telling):
    def hooked(lane, tools, **more):
        settings = observatory._session_settings(
            {"conv_id": ANNA, "lane": lane, "act_gate": False, "guard_docs": False, **more}, tools)
        return any("file_alert_hook.py" in h["command"]
                   for rule in settings.get("hooks", {}).get("PreToolUse", [])
                   for h in rule["hooks"])

    assert hooked("coding", ["Read", "Edit", "Bash"])
    assert not hooked("personal", ["Read", "Edit", "Bash"])     # not a watched room
    assert not hooked("coding", ["Read", "Grep"])               # can't change a file
    assert not hooked("coding", ["Read", "Bash"], helper_gate=True)
