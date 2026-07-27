"""Fork-the-work (routes/reading_room.py).

From a running session's live footprint, stage a clean-context take-over
spinoff seeded with the files it is WRITING/creating (reads excluded — lookup
noise). Three seams pinned:

- `_fork_work_surface` — live-parses the jsonl, keeps writes/creates, drops
  reads, groups by repo and makes paths repo-relative;
- `_fork_brief_md` — renders the file surface + a take-over Protocol (marks
  created files, always carries Protocol + Result);
- POST /conversation/<id>/fork — writes the BRIEF and stages a spinoff
  (open_spinoff), 400s a session with no write surface, 404s an unknown one.
"""
import json
import stat

import pytest
from flask import Flask

import store
from routes import reading_room as rr


@pytest.fixture
def fork_client(data_dir, tmp_path, monkeypatch):
    skeleton = tmp_path / "skeleton"
    vault = tmp_path / "vault"
    (skeleton).mkdir()
    monkeypatch.setattr(store, "BUILD_DIR", skeleton)
    monkeypatch.setattr(store, "CONTENT_DIR", vault / "tulku")
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    app = Flask(__name__)
    app.config.update(TESTING=True)
    rr.register(app)
    client = app.test_client()
    client._skeleton = skeleton
    return client


def _write_jsonl(conv_id, tool_uses):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    events = [{"type": "assistant", "message": {"content": tool_uses}}]
    (store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl").write_text(
        "\n".join(json.dumps(e) for e in events) + "\n")


def _edit(path):
    return {"type": "tool_use", "name": "Edit",
            "input": {"file_path": str(path), "old_string": "a", "new_string": "b"}}


def _read(path):
    return {"type": "tool_use", "name": "Read", "input": {"file_path": str(path)}}


def _seed_running(conv_id, skeleton):
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = {"bot": "keeper", "title": "Long build", "running": True,
                          "last_at": rr._now(), "cwd": str(skeleton)}


# --- the work surface -------------------------------------------------------

def test_work_surface_keeps_writes_drops_reads_and_is_repo_relative(fork_client):
    skeleton = fork_client._skeleton
    _write_jsonl("c1", [_edit(skeleton / "routes" / "existing.py"),
                        _read(skeleton / "docs" / "ref.md")])
    surface = rr._fork_work_surface("c1", {"cwd": str(skeleton), "last_at": rr._now()})
    # only the written file, repo-relative, under the skeleton repo's display name
    assert surface == [("App code", [("routes/existing.py", False)])]


def test_work_surface_empty_when_nothing_written(fork_client):
    skeleton = fork_client._skeleton
    _write_jsonl("c1", [_read(skeleton / "docs" / "ref.md")])
    assert rr._fork_work_surface("c1", {"cwd": str(skeleton), "last_at": rr._now()}) == []


# --- the generated BRIEF ----------------------------------------------------

def test_brief_lists_the_surface_marks_created_and_carries_protocol():
    md = rr._fork_brief_md("Long build", [
        ("App code", [("routes/a.py", True), ("routes/b.py", False)]),
    ])
    assert "routes/a.py`  — created fresh" in md
    assert "routes/b.py`" in md and "routes/b.py`  — created fresh" not in md
    assert "## Protocol" in md and "## Result" in md
    assert "Take-over, not parallel" in md


# --- the endpoint -----------------------------------------------------------

def test_fork_stages_a_spinoff_seeded_with_the_write_surface(fork_client):
    skeleton = fork_client._skeleton
    _seed_running("c1", skeleton)
    _write_jsonl("c1", [_edit(skeleton / "routes" / "existing.py")])

    resp = fork_client.post("/api/reading-room/conversation/c1/fork")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True and body["newly_spawned"] is True

    # the staged spinoff exists, is a fork, and carries an autostart kickoff
    new_id = body["conversation_id"]
    entry = store.read("bot_chats/index", {})[new_id]
    assert entry["spinoff_slug"].startswith("fork-")
    assert entry["title"].startswith("spin: fork-")
    assert entry["autostart"] is True and entry["draft"]

    # the BRIEF was written with the write surface in it
    brief = (store.SPINOFF_DIR / entry["spinoff_slug"] / "BRIEF.md").read_text()
    assert "routes/existing.py" in brief
    assert "clean-context take-over" in brief


def test_fork_400s_a_session_with_no_write_surface(fork_client):
    skeleton = fork_client._skeleton
    _seed_running("c2", skeleton)
    _write_jsonl("c2", [_read(skeleton / "docs" / "ref.md")])
    resp = fork_client.post("/api/reading-room/conversation/c2/fork")
    assert resp.status_code == 400
    # nothing staged
    assert not any(e.get("spinoff_slug") for e in store.read("bot_chats/index", {}).values())


def test_fork_404s_an_unknown_conversation(fork_client):
    assert fork_client.post("/api/reading-room/conversation/nope/fork").status_code == 404
