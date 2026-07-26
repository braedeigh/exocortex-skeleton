"""The reading room's pipe (routes/reading_room.py, design doc bot-surface-design).

Contracts pinned here:
- a send relays the claude stream-json events as SSE AND appends them to the
  owner's own conversation log (her record is the record);
- capture-first: a journaling bot mints the B card BEFORE claude is spawned;
- off-the-record (record: false) skips BOTH the journal mint and the log —
  the log gets only an explicit gap marker (Terra's amendment, 07-23);
- the second turn of a conversation resumes claude with the stored session id.

`claude` itself is a stub script (EXOCORTEX_CLAUDE_BIN / reading_room.CLAUDE_BIN)
that reads the prompt from stdin and prints canned NDJSON — the pipe is what's
under test, not the model.
"""
import json
import stat
import subprocess
from datetime import datetime, timedelta

import pytest
from flask import Flask

import recap_summary
import store
from routes import reading_room, terminal


STUB = """#!/usr/bin/env python3
import sys, json
text = sys.stdin.read()
with open({argv_log!r}, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
print(json.dumps({{"type": "system", "subtype": "init", "session_id": "sid-1"}}))
print(json.dumps({{"type": "stream_event", "event": {{"type": "content_block_delta",
    "delta": {{"type": "text_delta", "text": "echo"}}}}}}))
print(json.dumps({{"type": "assistant", "message": {{"role": "assistant",
    "content": [{{"type": "text", "text": "echo: " + text}}]}}}}))
print(json.dumps({{"type": "result", "subtype": "success",
    "session_id": "sid-1", "total_cost_usd": 0.01}}))
"""


@pytest.fixture
def bot_client(data_dir, tmp_path, monkeypatch):
    """Minimal app with only reading-room routes; claude is the stub above; the
    journal mint is recorded, not run."""
    argv_log = tmp_path / "claude_argv.jsonl"
    stub = tmp_path / "claude-stub"
    stub.write_text(STUB.format(argv_log=str(argv_log)))
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(reading_room, "CLAUDE_BIN", str(stub))
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    # The roster asks recap_summary for card summaries — never let a test
    # kick off a real background Haiku call.
    monkeypatch.setattr(recap_summary, "_spawn", lambda fn: None)

    mints = []
    monkeypatch.setattr(terminal, "_capture_journal",
                        lambda body, typed, tags=None, who="B":
                        mints.append((who, body)) or True)

    app = Flask(__name__)
    app.config.update(TESTING=True)
    reading_room.register(app)
    client = app.test_client()
    client._mints = mints
    client._argv_log = argv_log
    return client


def _send(client, **body):
    body.setdefault("text", "hello")
    return client.post("/api/reading-room/keeper/send", json=body)


def _sse_events(resp):
    out = []
    for chunk in resp.get_data(as_text=True).split("\n\n"):
        chunk = chunk.strip()
        if chunk.startswith("data: "):
            out.append(json.loads(chunk[len("data: "):]))
    return out


def _conv_log(conv_id):
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines()]


def test_send_streams_events_and_writes_her_own_log(bot_client):
    resp = _send(bot_client, text="hi keeper")
    assert resp.status_code == 200
    events = _sse_events(resp)
    conv_id = events[0]["conversation_id"]
    # relay: conv header, then the stub's four events (deltas included), done
    types = [e["type"] for e in events]
    assert types == ["conv", "system", "stream_event", "assistant", "result", "done"]
    assert "echo: hi keeper" in json.dumps(events[3])
    # her own record: user line + every claude event EXCEPT the token deltas
    # (stream_event is transport; the assistant message carries the text)
    log = _conv_log(conv_id)
    assert log[0]["type"] == "user" and log[0]["text"] == "hi keeper"
    assert [e["type"] for e in log[1:]] == ["system", "assistant", "result"]
    # index: session id + cost captured for the next resume
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["claude_session_id"] == "sid-1"
    assert meta["cost_usd"] == pytest.approx(0.01)


def _journal_conv(client):
    """A session that writes to the diary (journal is opt-in per session)."""
    return client.post("/api/reading-room/keeper/conversations",
                       json={"title": "keeper", "journal": True}).get_json()["id"]


def test_journal_mints_before_claude_is_spawned(bot_client, monkeypatch):
    # If the spawn ran first, the mint recorder would still be empty when it
    # fires — assert the order explicitly by failing the spawn: the card must
    # already be minted even though claude never ran.
    conv_id = _journal_conv(bot_client)
    def boom(*a, **k):
        raise OSError("no claude")
    monkeypatch.setattr(reading_room, "_spawn", boom)
    resp = _send(bot_client, text="a journal line", conversation_id=conv_id)
    assert resp.status_code == 502
    assert bot_client._mints == [("B", "a journal line")]


def test_fresh_sessions_do_not_journal_by_default(bot_client):
    # Implicit conversation (no id) and explicit create without journal:true
    # are both workshops: nothing mints. The diary door is opt-in.
    _sse_events(_send(bot_client, text="workshop thought"))
    conv_id = bot_client.post("/api/reading-room/keeper/conversations",
                              json={"title": "scratch"}).get_json()["id"]
    _sse_events(_send(bot_client, text="another", conversation_id=conv_id))
    assert bot_client._mints == []


def test_off_record_skips_journal_and_log(bot_client):
    conv_id = _journal_conv(bot_client)
    resp = _send(bot_client, text="when did i last...", record=False,
                 conversation_id=conv_id)
    events = _sse_events(resp)
    conv_id = events[0]["conversation_id"]
    # streams to the screen normally...
    assert any(e["type"] == "assistant" for e in events)
    # ...but mints nothing and persists nothing except the deliberate gap
    assert bot_client._mints == []
    log = _conv_log(conv_id)
    assert [e["type"] for e in log] == ["off-record-gap"]


def test_slash_commands_do_not_journal(bot_client):
    # Even in a journaling session, a summon/command is operator control.
    conv_id = _journal_conv(bot_client)
    _sse_events(_send(bot_client, text="/endsession", conversation_id=conv_id))
    assert bot_client._mints == []


def test_second_turn_resumes_stored_session(bot_client):
    first = _sse_events(_send(bot_client, text="turn one"))
    conv_id = first[0]["conversation_id"]
    # consume the stream so the turn (and the stub's argv write) completes
    _sse_events(_send(bot_client, text="turn two", conversation_id=conv_id))
    argvs = [json.loads(l) for l in bot_client._argv_log.read_text().splitlines()]
    assert not any("--resume" in a for a in argvs[0])
    assert "--resume" in argvs[1]
    assert argvs[1][argvs[1].index("--resume") + 1] == "sid-1"


def test_unknown_bot_404s_and_empty_text_400s(bot_client):
    assert bot_client.post("/api/reading-room/nope/send", json={"text": "x"}).status_code == 404
    assert _send(bot_client, text="  ").status_code == 400


def test_conversation_endpoint_round_trips(bot_client):
    events = _sse_events(_send(bot_client, text="hello there"))
    conv_id = events[0]["conversation_id"]
    resp = bot_client.get(f"/api/reading-room/conversation/{conv_id}")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["events"][0]["text"] == "hello there"
    assert data["meta"]["bot"] == "keeper"
    # roster lists the conversation under the keeper
    roster = bot_client.get("/api/reading-room").get_json()["bots"]
    keeper = next(b for b in roster if b["id"] == "keeper")
    assert any(c["id"] == conv_id for c in keeper["conversations"])


def test_never_sent_session_opens_with_its_staged_draft(bot_client):
    # A freshly-minted session (a /spinoff staged draft, or "+ New session")
    # has an index entry but no jsonl until its first send. Opening it must
    # return 200 with empty events and the staged draft intact — NOT 404 —
    # or the client's history load rejects and the draft never prefills the
    # composer (the "staged" badge shows but the compose box is empty).
    resp = bot_client.post("/api/reading-room/conversations",
                           json={"title": "spun off"})
    conv_id = resp.get_json()["id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["draft"] = "Read the BRIEF and follow its Protocol."

    resp = bot_client.get(f"/api/reading-room/conversation/{conv_id}")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["events"] == []
    assert data["meta"]["draft"] == "Read the BRIEF and follow its Protocol."

    # A conv_id with no index entry at all is still genuinely not found.
    assert bot_client.get(
        "/api/reading-room/conversation/2099-01-01.000000").status_code == 404


def test_send_consumes_the_autostart_flag_so_it_never_refires(bot_client):
    # /spinoff mints a session with draft + autostart:true; the Reading Room
    # auto-fires that kickoff on open. The send that fires it must clear BOTH
    # draft and autostart, or reopening the session (e.g. mid-turn) would
    # auto-fire the kickoff a second time.
    resp = bot_client.post("/api/reading-room/conversations",
                           json={"title": "spun off"})
    conv_id = resp.get_json()["id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["draft"] = "Read the BRIEF and follow its Protocol."
        index[conv_id]["autostart"] = True

    # Fire the staged kickoff exactly as the auto-start effect does: a normal
    # send into the existing conversation. Drain the stream so the turn runs.
    _sse_events(_send(bot_client, text="Read the BRIEF and follow its Protocol.",
                      conversation_id=conv_id))

    entry = store.read("bot_chats/index", {})[conv_id]
    assert "autostart" not in entry
    assert "draft" not in entry


def test_old_bots_alias_path_still_answers(bot_client):
    # /api/bots/* stays live as an alias of /api/reading-room/* for cached
    # PWA clients that still have the old path baked into their JS bundle.
    resp = bot_client.get("/api/bots")
    assert resp.status_code == 200
    roster = resp.get_json()["bots"]
    assert any(b["id"] == "keeper" for b in roster)


def test_named_session_create_rename_and_journal_toggle(bot_client):
    resp = bot_client.post("/api/reading-room/keeper/conversations",
                           json={"title": "morning pages"})
    assert resp.status_code == 200
    conv_id = resp.get_json()["id"]
    meta = store.read("bot_chats/index", {})[conv_id]
    # journal is opt-in: omitted means workshop
    assert meta["title"] == "morning pages" and meta["journal"] is False
    resp = bot_client.post(f"/api/reading-room/conversation/{conv_id}/settings",
                           json={"title": "evening pages", "journal": True})
    assert resp.status_code == 200
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["title"] == "evening pages" and meta["journal"] is True


def test_pinned_session_sorts_first(bot_client):
    old = _journal_conv(bot_client)
    newer = bot_client.post("/api/reading-room/keeper/conversations",
                            json={"title": "newer"}).get_json()["id"]
    # Pin the older one (data-side, as the migration does).
    with store.mutate("bot_chats/index", {}) as index:
        index[old]["pinned"] = True
    convs = bot_client.get("/api/reading-room").get_json()["bots"][0]["conversations"]
    assert convs[0]["id"] == old
    assert any(c["id"] == newer for c in convs[1:])


def test_roster_clears_a_running_flag_orphaned_by_a_dead_worker(bot_client):
    # A worker that crashed mid-turn never gets to clear `running` — the
    # roster must apply the same staleness check bot_conversation does, or
    # the session shows busy forever.
    conv_id = bot_client.post("/api/reading-room/keeper/conversations",
                              json={"title": "orphaned"}).get_json()["id"]
    stale = (datetime.now() - timedelta(seconds=reading_room._RUNNING_STALE_SEC + 60)).isoformat(timespec="seconds")
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["running"] = True
        index[conv_id]["last_at"] = stale
    convs = bot_client.get("/api/reading-room").get_json()["bots"][0]["conversations"]
    conv = next(c for c in convs if c["id"] == conv_id)
    assert conv["running"] is False
    # a fresh (non-stale) running flag still reads as busy
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["last_at"] = reading_room._now()
    convs = bot_client.get("/api/reading-room").get_json()["bots"][0]["conversations"]
    conv = next(c for c in convs if c["id"] == conv_id)
    assert conv["running"] is True


def test_non_journal_session_logs_but_never_mints(bot_client):
    conv_id = bot_client.post("/api/reading-room/keeper/conversations",
                              json={"title": "dev scratch", "journal": False}).get_json()["id"]
    events = _sse_events(_send(bot_client, text="not a diary line",
                               conversation_id=conv_id))
    # streams + logs normally...
    assert any(e["type"] == "assistant" for e in events)
    assert _conv_log(conv_id)[0]["text"] == "not a diary line"
    # ...but the journal door never opened (unlike a default session)
    assert bot_client._mints == []


def test_tap_puts_a_keeper_reply_into_the_journal_as_a_k_card(bot_client):
    # Works even in a non-journal workshop session — the tap is the
    # fine-grained opposite of the session's journal switch.
    events = _sse_events(_send(bot_client, text="hello"))
    conv_id = events[0]["conversation_id"]
    resp = bot_client.post(f"/api/reading-room/conversation/{conv_id}/journal-output",
                           json={"text": "echo: hello"})
    assert resp.status_code == 200
    # Minted in the keeper's voice, not hers.
    assert bot_client._mints == [("K", "echo: hello")]
    # The mark lands in the log so the UI's ✦ survives reload.
    mark = _conv_log(conv_id)[-1]
    assert mark["type"] == "journal-mark" and mark["text"] == "echo: hello"


def test_tap_journal_validates_conv_and_text(bot_client):
    assert bot_client.post("/api/reading-room/conversation/nope/journal-output",
                           json={"text": "x"}).status_code == 404
    conv_id = _sse_events(_send(bot_client, text="hi"))[0]["conversation_id"]
    assert bot_client.post(f"/api/reading-room/conversation/{conv_id}/journal-output",
                           json={"text": "  "}).status_code == 400
    assert bot_client._mints == []


def test_close_hides_the_session_but_deletes_nothing(bot_client):
    conv_id = bot_client.post("/api/reading-room/keeper/conversations",
                              json={"title": "done with this"}).get_json()["id"]
    _sse_events(_send(bot_client, text="some work", conversation_id=conv_id))
    resp = bot_client.post(f"/api/reading-room/conversation/{conv_id}/close")
    assert resp.status_code == 200
    # Gone from the roster...
    convs = bot_client.get("/api/reading-room").get_json()["bots"][0]["conversations"]
    assert not any(c["id"] == conv_id for c in convs)
    # ...but the log and index entry survive — close archives, never deletes.
    assert (store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl").exists()
    assert store.read("bot_chats/index", {})[conv_id]["archived"]


def test_pinned_keeper_session_refuses_to_close(bot_client):
    conv_id = _journal_conv(bot_client)
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["pinned"] = True
    resp = bot_client.post(f"/api/reading-room/conversation/{conv_id}/close")
    assert resp.status_code == 400
    convs = bot_client.get("/api/reading-room").get_json()["bots"][0]["conversations"]
    assert any(c["id"] == conv_id for c in convs)


def test_roster_carries_cached_summaries(bot_client, monkeypatch):
    events = _sse_events(_send(bot_client, text="summarize me"))
    conv_id = events[0]["conversation_id"]
    monkeypatch.setattr(recap_summary, "get_summary",
                        lambda sid, path, builder=None: "Working on the thing."
                        if sid == f"bot:{conv_id}" else None)
    convs = bot_client.get("/api/reading-room").get_json()["bots"][0]["conversations"]
    conv = next(c for c in convs if c["id"] == conv_id)
    assert conv["summary"] == "Working on the thing."


def test_resume_happens_in_the_conversations_own_cwd(bot_client, tmp_path, monkeypatch):
    # Claude sessions are per-directory: an imported conversation carries the
    # cwd it was born in, and every spawn for it must run there — not in the
    # bot's default cwd (the "No conversation found with session ID" bug).
    born_in = tmp_path / "born-here"
    born_in.mkdir()
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index["imported-1"] = {"bot": "keeper", "started": "x", "last_at": "x",
                               "claude_session_id": "sid-old", "cost_usd": 0.0,
                               "title": "Imported", "journal": False,
                               "cwd": str(born_in)}
    seen = {}
    real_spawn = reading_room._spawn
    def spy(bot, text, resume_sid, cwd_override=None):
        seen["cwd"] = cwd_override
        seen["resume"] = resume_sid
        return real_spawn(bot, text, resume_sid, cwd_override)
    monkeypatch.setattr(reading_room, "_spawn", spy)
    _sse_events(_send(bot_client, text="continue", conversation_id="imported-1"))
    assert seen == {"cwd": str(born_in), "resume": "sid-old"}


# --- Detached turns (the PWA-close fix) --------------------------------------
# A turn's life belongs to its background thread, not the HTTP connection:
# closing the app kills the fetch, and that must no longer kill the reply.

SLOW_STUB = """#!/usr/bin/env python3
import sys, json, time
sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init",
                  "session_id": "sid-slow"}), flush=True)
time.sleep(4)
print(json.dumps({"type": "assistant", "message": {"role": "assistant",
    "content": [{"type": "text", "text": "late reply"}]}}), flush=True)
print(json.dumps({"type": "result", "subtype": "success",
    "session_id": "sid-slow", "total_cost_usd": 0.01}), flush=True)
"""


def _install_slow_stub(tmp_path, monkeypatch):
    stub = tmp_path / "claude-slow"
    stub.write_text(SLOW_STUB)
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(reading_room, "CLAUDE_BIN", str(stub))


def _first_frame_conv(it):
    chunk = next(it).decode()
    return json.loads(chunk.split("data: ", 1)[1].split("\n\n")[0])["conversation_id"]


def _wait_not_running(conv_id, timeout=10):
    import time as _t
    deadline = _t.time() + timeout
    while _t.time() < deadline:
        meta = store.read("bot_chats/index", {}).get(conv_id, {})
        if meta and meta.get("running") is False:
            return meta
        _t.sleep(0.2)
    raise AssertionError("turn never finished")


def test_client_disconnect_does_not_kill_the_turn(bot_client, tmp_path, monkeypatch):
    import time as _t
    _install_slow_stub(tmp_path, monkeypatch)
    t0 = _t.time()
    resp = _send(bot_client, text="keep going without me")
    it = resp.iter_encoded()
    conv_id = _first_frame_conv(it)
    # Laziness guard: if the test client had buffered the whole stream, the
    # slow stub would have made this take 4s+ and prove nothing.
    assert _t.time() - t0 < 3
    next(it)   # the init event has been relayed…
    meta = store.read("bot_chats/index", {})[conv_id]
    # …so the resume id is ALREADY durable, while the turn is still running —
    # an interrupted turn resumes into what claude remembers.
    assert meta["claude_session_id"] == "sid-slow"
    assert meta["running"] is True
    resp.close()   # she closes the PWA mid-reply
    meta = _wait_not_running(conv_id)
    types = [e["type"] for e in _conv_log(conv_id)]
    assert "assistant" in types and "error" not in types
    assert meta["cost_usd"] == pytest.approx(0.01)


def test_stop_ends_the_turn_without_an_error_event(bot_client, tmp_path, monkeypatch):
    import time as _t
    _install_slow_stub(tmp_path, monkeypatch)
    t0 = _t.time()
    resp = _send(bot_client, text="never mind")
    it = resp.iter_encoded()
    conv_id = _first_frame_conv(it)
    assert bot_client.post(f"/api/reading-room/conversation/{conv_id}/stop").status_code == 200
    rest = b"".join(it).decode()
    # Her stop is not a failure: the viewer ends with done, and neither the
    # stream nor the log carries an error event.
    frames = [json.loads(c[len("data: "):]) for c in rest.split("\n\n")
              if c.strip().startswith("data: ")]
    assert frames and frames[-1]["type"] == "done"
    assert all(f["type"] != "error" for f in frames)
    assert _t.time() - t0 < 3   # the kill landed; nobody sat out the sleep
    meta = _wait_not_running(conv_id)
    assert "error" not in [e["type"] for e in _conv_log(conv_id)]
    assert "stop_requested" not in meta


# --- Terrain (GET /api/reading-room/terrain) ---------------------------------
# The file-tree heatmap's data layer: git heat (routes/reading_room.py's own
# `git log` call) merged with bot_chats footprint attribution (scripts/
# extract_footprints.py's sidecar). Repo roots are monkeypatched to scratch
# git repos under tmp_path — never the real skeleton/vault checkouts — and
# the module-level cache is reset per test so runs don't bleed into each
# other.

def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def _make_git_repo(root):
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    return root


def _commit_file(repo, relpath, content):
    path = repo / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    _git(repo, "add", relpath)
    _git(repo, "commit", "-q", "-m", f"add {relpath}")


@pytest.fixture
def terrain_client(data_dir, monkeypatch):
    """Isolated data dir (no real footprints/gists/index) + a fresh terrain
    cache — the module-level cache must not survive across tests. It's keyed
    by resolved file cap now (one slot per distinct ?limit=)."""
    monkeypatch.setattr(reading_room, "_terrain_cache", {})
    app = Flask(__name__)
    app.config.update(TESTING=True)
    reading_room.register(app)
    return app.test_client()


def _set_terrain_repos(monkeypatch, skeleton_root, vault_root):
    monkeypatch.setattr(reading_room, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": skeleton_root},
        {"id": "vault", "name": "Personal vault", "root": vault_root},
    ))


def _age_terrain_cache(seconds):
    """Backdate every cache slot — the cache is keyed by file cap now, so
    tests can't reach into a single well-known entry."""
    for slot in reading_room._terrain_cache.values():
        slot["computed_at"] -= seconds


def test_terrain_returns_200_with_missing_sidecars(terrain_client, tmp_path, monkeypatch):
    # No footprints.json/gists.json/index.json (data_dir is a fresh tmp_path)
    # and repo roots that aren't even git repos — the git-missing/failing
    # path must degrade to an empty repo entry, never a 500.
    _set_terrain_repos(monkeypatch, tmp_path / "not-a-repo-a", tmp_path / "not-a-repo-b")
    resp = terrain_client.get("/api/reading-room/terrain")
    assert resp.status_code == 200
    data = resp.get_json()
    assert set(data.keys()) == {"generated_at", "window_days", "file_cap", "repos", "sessions"}
    assert data["window_days"] == 90
    assert [r["id"] for r in data["repos"]] == ["skeleton", "vault"]
    assert all(r["files"] == [] for r in data["repos"])
    assert data["sessions"] == []


def test_denylist_filters_machine_churn(terrain_client, tmp_path, monkeypatch):
    vault = _make_git_repo(tmp_path / "vault")
    _commit_file(vault, "dev_todo.md", "# todo\n- thing\n")
    _commit_file(vault, "data/exo.db", "not really sqlite")
    _commit_file(vault, "data/bot_chats/2026-01-01.jsonl", "{}\n")
    _commit_file(vault, "scripts/research_dispatcher.log", "log line\n")
    _commit_file(vault, "frontend/dist/bundle.js", "// built\n")
    _set_terrain_repos(monkeypatch, tmp_path / "empty-skeleton", vault)
    data = terrain_client.get("/api/reading-room/terrain").get_json()
    vault_out = next(r for r in data["repos"] if r["id"] == "vault")
    paths = {f["path"] for f in vault_out["files"]}
    # human-meaningful content survives; machine churn is filtered out
    assert paths == {"dev_todo.md"}


def test_footprint_merge_maps_abs_path_to_repo_relative(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    _commit_file(skeleton, "app.py", "print('hi')\n")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "empty-vault")

    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"conv-1": {"title": "Index Title"}})
    store.write("bot_chats/gists", {"conv-1": {"title": "Gist Title"}})
    store.write("bot_chats/footprints", {
        "conv-1": {
            "files": {
                str(skeleton / "app.py"): {"writes": 3, "reads": 1,
                                           "last": "2026-01-02T00:00:00Z"},
                str(skeleton / "uncommitted.py"): {"writes": 1, "reads": 0,
                                                   "last": "2026-01-02T00:00:00Z"},
            },
            "extracted_at": "2026-01-02T00:00:00",
        },
    })

    data = terrain_client.get("/api/reading-room/terrain").get_json()
    skel_out = next(r for r in data["repos"] if r["id"] == "skeleton")
    by_path = {f["path"]: f for f in skel_out["files"]}

    # abs path -> repo-relative path, git touches present
    assert by_path["app.py"]["sessions"] == [
        {"id": "conv-1", "title": "Gist Title", "writes": 3, "reads": 1,
         "last": "2026-01-02T00:00:00Z"},
    ]
    assert len(by_path["app.py"]["touches"]) == 1
    # a file git never saw in the window (e.g. uncommitted) still surfaces,
    # attributed purely from the footprint, with no git touches
    assert by_path["uncommitted.py"]["touches"] == []
    assert by_path["uncommitted.py"]["sessions"][0]["writes"] == 1

    # the session itself is a first-class map entity: identity/status only
    # (per-file counts live in files[].sessions above)
    assert data["sessions"] == [
        {"id": "conv-1", "title": "Gist Title", "bot": None,
         "running": False, "last": None},
    ]


def test_live_touches_merge_for_a_running_session(terrain_client, tmp_path, monkeypatch):
    # A mid-turn session's batch footprints are stale; its jsonl must be
    # re-parsed live, REPLACING the batch entry (a live parse of the same log
    # is a strict superset — replacement can't double-count).
    skeleton = _make_git_repo(tmp_path / "skeleton")
    _commit_file(skeleton, "app.py", "print('hi')\n")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "empty-vault")

    chats = store.DATA_DIR / "bot_chats"
    chats.mkdir(parents=True, exist_ok=True)
    last_at = reading_room._now()
    store.write("bot_chats/index", {"conv-live": {
        "title": "Mid-flight work", "bot": "spark", "running": True,
        "last_at": last_at, "cwd": str(skeleton)}})
    # the batch sidecar saw one Edit on app.py before the turn started...
    store.write("bot_chats/footprints", {"conv-live": {"files": {
        str(skeleton / "app.py"): {"writes": 1, "reads": 0,
                                   "last": "2026-01-01T00:00:00Z"}}}})
    # ...but the log has since gained a Write on a brand-new file
    events = [
        {"type": "user", "text": "go", "ts": "2026-01-01T00:00:00"},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Edit",
             "input": {"file_path": str(skeleton / "app.py"),
                       "old_string": "a", "new_string": "b"}},
            {"type": "tool_use", "name": "Write",
             "input": {"file_path": str(skeleton / "fresh.py"), "content": "x"}},
        ]}},
    ]
    (chats / "conv-live.jsonl").write_text(
        "\n".join(json.dumps(e) for e in events) + "\n")

    data = terrain_client.get("/api/reading-room/terrain").get_json()
    skel_out = next(r for r in data["repos"] if r["id"] == "skeleton")
    by_path = {f["path"]: f for f in skel_out["files"]}
    # the mid-turn Write surfaces even though the batch sidecar never saw it
    assert by_path["fresh.py"]["sessions"][0]["id"] == "conv-live"
    assert by_path["fresh.py"]["sessions"][0]["writes"] == 1
    # app.py's counts come from the live parse alone — not batch + live
    assert by_path["app.py"]["sessions"][0]["writes"] == 1
    # and the session is on the map, marked running
    sess = next(s for s in data["sessions"] if s["id"] == "conv-live")
    assert sess == {"id": "conv-live", "title": "Mid-flight work",
                    "bot": "spark", "running": True, "last": last_at}


def test_running_session_with_no_touches_still_appears_in_sessions(terrain_client, tmp_path, monkeypatch):
    # A turn that hasn't touched a file yet is still a presence on the map.
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"conv-idle": {
        "title": "Just thinking", "bot": "keeper", "running": True,
        "last_at": reading_room._now()}})
    data = terrain_client.get("/api/reading-room/terrain").get_json()
    assert [s["id"] for s in data["sessions"]] == ["conv-idle"]
    assert data["sessions"][0]["running"] is True


def test_terrain_caches_the_payload_for_the_ttl(terrain_client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(reading_room, "_terrain_git_touches",
                        lambda root, window_days: calls.append(root) or {})
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")

    terrain_client.get("/api/reading-room/terrain")
    terrain_client.get("/api/reading-room/terrain")
    assert len(calls) == 2   # one _build_terrain() call touches 2 repos

    _age_terrain_cache(reading_room._TERRAIN_CACHE_TTL_SEC + 1)
    terrain_client.get("/api/reading-room/terrain")
    assert len(calls) == 4   # cache expired -> _build_terrain() ran again


def test_terrain_ttl_shortens_while_a_session_is_running(terrain_client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(reading_room, "_terrain_git_touches",
                        lambda root, window_days: calls.append(root) or {})
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"conv-live": {
        "title": "Live", "bot": "keeper", "running": True,
        "last_at": reading_room._now()}})

    terrain_client.get("/api/reading-room/terrain")
    assert len(calls) == 2
    # An age the default 300s TTL would call fresh — but with a session
    # running, the live TTL (~5s) has already expired it.
    _age_terrain_cache(reading_room._TERRAIN_LIVE_TTL_SEC + 1)
    terrain_client.get("/api/reading-room/terrain")
    assert len(calls) == 4
    # Once nothing is running, the same age is fresh again under 300s.
    store.write("bot_chats/index", {"conv-live": {"title": "Live", "running": False}})
    _age_terrain_cache(reading_room._TERRAIN_LIVE_TTL_SEC + 1)
    terrain_client.get("/api/reading-room/terrain")
    assert len(calls) == 4   # served from cache


# --- Terrain: the Files slider (?limit=) -------------------------------------
# The client's Files slider is the only thing that sets the hottest-N-per-repo
# cut; "All" is ?limit=0. files_total always reports the uncapped truth so the
# map can say how much it is not showing.

def _repo_with_files(root, n):
    repo = _make_git_repo(root)
    for i in range(n):
        _commit_file(repo, f"f{i:03d}.py", f"# file {i}\n")
    return repo


def test_limit_caps_files_per_repo_and_files_total_stays_honest(terrain_client, tmp_path, monkeypatch):
    skeleton = _repo_with_files(tmp_path / "skeleton", 12)
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "empty-vault")

    data = terrain_client.get("/api/reading-room/terrain?limit=5").get_json()
    skel = next(r for r in data["repos"] if r["id"] == "skeleton")
    assert len(skel["files"]) == 5
    assert skel["files_total"] == 12     # the cut never lies about the whole
    assert data["file_cap"] == 5


def test_limit_zero_means_every_file(terrain_client, tmp_path, monkeypatch):
    skeleton = _repo_with_files(tmp_path / "skeleton", 12)
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "empty-vault")

    data = terrain_client.get("/api/reading-room/terrain?limit=0").get_json()
    skel = next(r for r in data["repos"] if r["id"] == "skeleton")
    assert len(skel["files"]) == 12 == skel["files_total"]
    assert data["file_cap"] is None


def test_junk_limit_falls_back_to_the_default_instead_of_erroring(terrain_client, tmp_path, monkeypatch):
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    data = terrain_client.get("/api/reading-room/terrain?limit=drop%20table").get_json()
    assert data["file_cap"] == reading_room._TERRAIN_FILE_CAP


def test_limit_is_bounded_so_one_request_cannot_ask_for_everything(terrain_client, tmp_path, monkeypatch):
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    data = terrain_client.get("/api/reading-room/terrain?limit=99999999").get_json()
    assert data["file_cap"] == reading_room._TERRAIN_FILE_CAP_MAX


def test_each_limit_gets_its_own_cache_slot(terrain_client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(reading_room, "_terrain_git_touches",
                        lambda root, window_days: calls.append(root) or {})
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")

    terrain_client.get("/api/reading-room/terrain?limit=100")
    terrain_client.get("/api/reading-room/terrain?limit=100")
    assert len(calls) == 2          # second served from the limit=100 slot
    terrain_client.get("/api/reading-room/terrain?limit=200")
    assert len(calls) == 4          # a different cut is a different payload


def test_cache_slots_are_bounded(terrain_client, tmp_path, monkeypatch):
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    for limit in range(1, reading_room._TERRAIN_CACHE_SLOTS + 5):
        terrain_client.get(f"/api/reading-room/terrain?limit={limit}")
    assert len(reading_room._terrain_cache) <= reading_room._TERRAIN_CACHE_SLOTS


# --- Terrain: the code modal (GET /api/reading-room/terrain/file) ------------
# Tap a file node -> its own text, plus a summary lifted from the file's
# leading docblock. This is an HTTP door onto the filesystem, so the scoping
# tests below are the load-bearing ones.

def test_terrain_file_returns_content_and_summary(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    _commit_file(skeleton, "routes/thing.py",
                 '"""What this module is for.\n\nSecond paragraph.\n"""\nX = 1\n')
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    resp = terrain_client.get("/api/reading-room/terrain/file?repo=skeleton&path=routes/thing.py")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["summary"] == "What this module is for.\n\nSecond paragraph."
    assert body["content"].endswith("X = 1\n")
    assert body["binary"] is False and body["truncated"] is False


def test_terrain_file_refuses_to_escape_the_repo_root(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    _commit_file(skeleton, "app.py", "x = 1\n")
    (tmp_path / "outside.txt").write_text("secrets")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    for bad in ("../outside.txt", "../../etc/passwd", "/etc/passwd",
                "app.py/../../outside.txt"):
        resp = terrain_client.get(
            "/api/reading-room/terrain/file", query_string={"repo": "skeleton", "path": bad})
        assert resp.status_code == 404, bad


def test_terrain_file_refuses_a_symlink_pointing_out_of_every_repo(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    (tmp_path / "outside.txt").write_text("secrets")
    (skeleton / "sneaky.txt").symlink_to(tmp_path / "outside.txt")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    resp = terrain_client.get("/api/reading-room/terrain/file?repo=skeleton&path=sneaky.txt")
    assert resp.status_code == 404


def test_terrain_file_follows_a_symlink_into_the_sibling_repo(terrain_client, tmp_path, monkeypatch):
    # The real skeleton's CLAUDE.local.md is exactly this: a file on the map
    # that lives in the vault. Both repos are readable here by design, so
    # landing in the sibling root is allowed — landing outside both is not.
    skeleton = _make_git_repo(tmp_path / "skeleton")
    vault = _make_git_repo(tmp_path / "vault")
    _commit_file(vault, "docs/notes.md", "# Notes\n\nReal content.\n")
    (skeleton / "notes.md").symlink_to(vault / "docs" / "notes.md")
    _set_terrain_repos(monkeypatch, skeleton, vault)

    resp = terrain_client.get("/api/reading-room/terrain/file?repo=skeleton&path=notes.md")
    assert resp.status_code == 200
    assert "Real content." in resp.get_json()["content"]


def test_terrain_file_refuses_secrets_by_name(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    (skeleton / ".env").write_text("API_KEY=hunter2\n")
    (skeleton / "server.key").write_text("-----BEGIN PRIVATE KEY-----\n")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    for secret in (".env", "server.key"):
        resp = terrain_client.get(
            "/api/reading-room/terrain/file", query_string={"repo": "skeleton", "path": secret})
        assert resp.status_code == 404, secret


def test_terrain_file_flags_binary_without_returning_it(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    (skeleton / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x00binary")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    body = terrain_client.get(
        "/api/reading-room/terrain/file?repo=skeleton&path=logo.png").get_json()
    assert body["binary"] is True
    assert body["content"] is None


def test_terrain_file_truncates_on_whole_lines(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    monkeypatch.setattr(reading_room, "_TERRAIN_FILE_READ_MAX", 50)
    (skeleton / "big.txt").write_text("".join(f"line {i}\n" for i in range(50)))
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    body = terrain_client.get(
        "/api/reading-room/terrain/file?repo=skeleton&path=big.txt").get_json()
    assert body["truncated"] is True
    assert body["content"].endswith("\n")     # never a half-line
    assert body["size"] > len(body["content"])


def test_terrain_file_unknown_repo_and_missing_args(terrain_client, tmp_path, monkeypatch):
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    assert terrain_client.get(
        "/api/reading-room/terrain/file?repo=nope&path=x.py").status_code == 404
    assert terrain_client.get(
        "/api/reading-room/terrain/file?repo=skeleton").status_code == 400


def test_terrain_file_summary_is_none_when_the_file_does_not_say(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    (skeleton / "bare.py").write_text("X = 1\n")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    body = terrain_client.get(
        "/api/reading-room/terrain/file?repo=skeleton&path=bare.py").get_json()
    assert body["summary"] is None       # no guessing when there's no docblock


# --- Session-first refactor: per-conversation config replaces the bot lookup -

def _index_entry(**over):
    entry = {"bot": "keeper", "started": reading_room._now(),
             "last_at": reading_room._now(), "claude_session_id": None,
             "cost_usd": 0.0, "title": "Custom", "journal": False,
             "cwd": str(store.CONTENT_DIR.parent)}
    entry.update(over)
    return entry


def test_conv_send_404s_on_unknown_id(bot_client):
    resp = bot_client.post("/api/reading-room/conversation/nope/send",
                           json={"text": "x"})
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "not found"}


def test_conv_send_uses_the_entrys_own_tools_and_cwd(bot_client, tmp_path, monkeypatch):
    own_cwd = tmp_path / "own-cwd"
    own_cwd.mkdir()
    reading_room._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["custom-1"] = _index_entry(cwd=str(own_cwd),
                                         allowed_tools=["Read", "Bash"])
    seen = {}
    real_spawn = reading_room._spawn
    def spy(config, text, resume_sid, cwd_override=None):
        seen["config"] = config
        seen["cwd_override"] = cwd_override
        return real_spawn(config, text, resume_sid, cwd_override)
    monkeypatch.setattr(reading_room, "_spawn", spy)
    _sse_events(bot_client.post("/api/reading-room/conversation/custom-1/send",
                                json={"text": "go"}))
    assert seen["config"]["allowed_tools"] == ["Read", "Bash"]
    assert seen["config"]["cwd"] == str(own_cwd)
    assert seen["cwd_override"] == str(own_cwd)
    # and the spawned claude actually got the tool flag
    argvs = [json.loads(l) for l in bot_client._argv_log.read_text().splitlines()]
    argv = argvs[-1]
    assert argv[argv.index("--allowedTools") + 1] == "Read,Bash"


def _last_argv(client):
    return json.loads(client._argv_log.read_text().splitlines()[-1])


def test_a_pinned_model_reaches_claude_and_no_pin_inherits_the_cli_default(bot_client):
    # Two sessions, one pinned to sonnet and one with no `model` field: the
    # pinned one gets --model, the unpinned one must pass NO --model flag at
    # all (that absence is what lets ~/.claude/settings.json keep deciding).
    reading_room._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["pinned-model"] = _index_entry(model="sonnet")
        index["no-model"] = _index_entry()
    _sse_events(bot_client.post("/api/reading-room/conversation/pinned-model/send",
                                json={"text": "go"}))
    argv = _last_argv(bot_client)
    assert argv[argv.index("--model") + 1] == "sonnet"

    _sse_events(bot_client.post("/api/reading-room/conversation/no-model/send",
                                json={"text": "go"}))
    assert "--model" not in _last_argv(bot_client)


def test_a_junk_model_on_an_entry_is_ignored_rather_than_passed_through(bot_client):
    # Hand-edited/older data could carry anything; _conv_config filters to the
    # known choices so a bad value degrades to the default instead of failing
    # every turn of that session.
    reading_room._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["junk-model"] = _index_entry(model="gpt-9")
    _sse_events(bot_client.post("/api/reading-room/conversation/junk-model/send",
                                json={"text": "go"}))
    assert "--model" not in _last_argv(bot_client)


def test_model_can_be_pinned_switched_and_cleared_through_settings(bot_client):
    conv_id = bot_client.post("/api/reading-room/conversations",
                              json={"title": "workshop"}).get_json()["id"]
    # created without a pick: no field at all
    assert "model" not in store.read("bot_chats/index", {})[conv_id]

    for pick in ("opus[1m]", "haiku"):
        resp = bot_client.post(f"/api/reading-room/conversation/{conv_id}/settings",
                               json={"model": pick})
        assert resp.status_code == 200
        assert store.read("bot_chats/index", {})[conv_id]["model"] == pick

    # '' clears the pin — the field is REMOVED, not blanked, so _conv_config
    # reads it as inherit rather than as a falsy model.
    resp = bot_client.post(f"/api/reading-room/conversation/{conv_id}/settings",
                           json={"model": ""})
    assert resp.status_code == 200
    assert "model" not in store.read("bot_chats/index", {})[conv_id]


def test_an_unknown_model_is_rejected_without_persisting_the_rest_of_the_patch(bot_client):
    conv_id = bot_client.post("/api/reading-room/conversations",
                              json={"title": "workshop"}).get_json()["id"]
    resp = bot_client.post(f"/api/reading-room/conversation/{conv_id}/settings",
                           json={"title": "renamed", "model": "gpt-9"})
    assert resp.status_code == 400
    # The whole patch is refused: validation happens before the mutate block,
    # because an early return inside it would still COMMIT the rename.
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["title"] == "workshop"
    assert "model" not in meta


def test_create_can_pin_a_model_and_rejects_an_unknown_one(bot_client):
    conv_id = bot_client.post("/api/reading-room/conversations",
                              json={"title": "cheap", "model": "haiku"}).get_json()["id"]
    assert store.read("bot_chats/index", {})[conv_id]["model"] == "haiku"
    resp = bot_client.post("/api/reading-room/conversations",
                           json={"title": "bad", "model": "gpt-9"})
    assert resp.status_code == 400


def test_roster_publishes_the_model_choices_the_settings_route_accepts(bot_client):
    # One authority: the picker's options come from the server, so the client
    # can't offer something the settings route would 400 on.
    choices = bot_client.get("/api/reading-room").get_json()["model_choices"]
    assert choices == reading_room._MODEL_CHOICES


def test_legacy_entry_without_allowed_tools_gets_readonly_trio(bot_client, monkeypatch):
    reading_room._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["legacy-1"] = _index_entry()   # no allowed_tools field at all
    seen = {}
    real_spawn = reading_room._spawn
    def spy(config, text, resume_sid, cwd_override=None):
        seen["tools"] = config["allowed_tools"]
        return real_spawn(config, text, resume_sid, cwd_override)
    monkeypatch.setattr(reading_room, "_spawn", spy)
    _sse_events(bot_client.post("/api/reading-room/conversation/legacy-1/send",
                                json={"text": "hi"}))
    assert seen["tools"] == reading_room._DEFAULT_ALLOWED_TOOLS


def test_draft_is_cleared_by_a_send(bot_client):
    reading_room._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["draft-1"] = _index_entry(
            allowed_tools=list(reading_room._BUILDER_TOOLS),
            draft="Read BRIEF.md and follow its Protocol section exactly.")
    _sse_events(bot_client.post("/api/reading-room/conversation/draft-1/send",
                                json={"text": "Read BRIEF.md and follow its Protocol section exactly."}))
    meta = store.read("bot_chats/index", {})["draft-1"]
    assert "draft" not in meta


def test_new_default_create_route_gives_builder_config(bot_client):
    resp = bot_client.post("/api/reading-room/conversations",
                           json={"title": "build thing"})
    assert resp.status_code == 200
    conv_id = resp.get_json()["id"]
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["allowed_tools"] == list(reading_room._BUILDER_TOOLS)
    assert meta["cwd"] == str(store.BUILD_DIR)
    assert meta["bot"] == "keeper"
    assert meta["journal"] is False


def test_roster_returns_sessions_and_legacy_bots_shapes(bot_client):
    conv_id = bot_client.post("/api/reading-room/conversations",
                              json={"title": "roster check"}).get_json()["id"]
    data = bot_client.get("/api/reading-room").get_json()
    assert "sessions" in data and "bots" in data
    assert any(c["id"] == conv_id for c in data["sessions"])
    assert data["bots"][0]["id"] == "keeper"
    assert any(c["id"] == conv_id for c in data["bots"][0]["conversations"])
    assert data["sessions"] == data["bots"][0]["conversations"]
