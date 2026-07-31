"""routes/spinoff.py — the shared spawn door for /spinoff.

Session-first: opening a spinoff mints (or rejoins) a Observatory
conversation (routes/observatory.py) rather than a tmux session. A fresh
mint gets a builder-tool config and its kickoff carried on the entry as a
`draft` AND flagged `autostart` — the Observatory fires that kickoff
automatically the moment she opens the session (no manual send). Re-invoking
against a slug that already has a live (non-archived) conversation is a
rejoin: the entry is returned untouched, not re-minted or re-drafted.

A mint also lands in a ROOM: the sending session's, read off EXOCORTEX_CONV_ID,
unless the caller names one. The room decides the child's cwd and (via the
absent act_gate/guard_docs fields) whether it stops to ask.
"""
import json
from pathlib import Path

import pytest
from flask import Flask

import store
from routes import observatory, spinoff


@pytest.fixture
def spinoff_client(data_dir, monkeypatch):
    # Mirrors conftest's store-isolation style: data_dir points store.DATA_DIR
    # (and UPLOAD_DIR) at a fresh tmp_path; SPINOFF_DIR is resolved once at
    # import time from the (real) DATA_DIR, so it needs its own monkeypatch
    # to land under the same isolated tree.
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    # A mint now LAUNCHES the session (scripts/spinoff_runner.py, detached).
    # Tests must never actually spawn claude, so Popen is recorded instead of
    # run; `client._launches` is what the launch assertions read.
    launches = []
    def fake_popen(argv, **kw):
        launches.append((argv, kw))
        return object()
    monkeypatch.setattr(spinoff.subprocess, "Popen", fake_popen)
    # The suite can be run FROM an Observatory session, whose env carries a
    # real EXOCORTEX_CONV_ID — which is exactly the signal room-inheritance
    # reads. Cleared here so "no sender" tests mean it, and so the room tests
    # below set the sender themselves.
    monkeypatch.delenv("EXOCORTEX_CONV_ID", raising=False)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    spinoff.register(app)
    client = app.test_client()
    client._launches = launches
    return client


def _post(client, slug, **body):
    return client.post("/api/spinoff/open",
                       data=json.dumps({"slug": slug, **body}),
                       content_type="application/json")


def _sender(monkeypatch, conv_id="2026-07-30.101010", **entry):
    """Pretend this call came from an Observatory session — the same way a real
    /spinoff does: an index entry for the sender, and its id in the turn's
    environment (observatory._spawn puts it there)."""
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = {"bot": "keeper", "title": "sender",
                          "started": observatory._now(), **entry}
    monkeypatch.setenv("EXOCORTEX_CONV_ID", conv_id)
    return conv_id


def _write_brief(spinoff_dir, slug, text="Do the thing.\n"):
    d = spinoff_dir / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "BRIEF.md").write_text(text)
    return d / "BRIEF.md"


def _index():
    return store.read("bot_chats/index", {})


def test_bad_slug_400(spinoff_client):
    r = _post(spinoff_client, "NOT-A-SLUG")
    assert r.status_code == 400
    assert r.get_json() == {"error": "bad slug"}
    assert _index() == {}


def test_missing_brief_400_and_no_index_write(spinoff_client):
    r = _post(spinoff_client, "some-slug")
    assert r.status_code == 400
    brief = store.SPINOFF_DIR / "some-slug" / "BRIEF.md"
    assert r.get_json() == {"error": f"no brief at {brief}"}
    assert _index() == {}


def test_valid_slug_mints_an_autostarting_builder_session(spinoff_client):
    brief = _write_brief(store.SPINOFF_DIR, "cool-idea")
    r = _post(spinoff_client, "cool-idea")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["newly_spawned"] is True
    assert body["staged"] is True
    assert body["autostart"] is True
    assert body["brief"] == str(brief)
    conv_id = body["conversation_id"]

    index = _index()
    entry = index[conv_id]
    assert entry["spinoff_slug"] == "cool-idea"
    assert str(brief) in entry["draft"]
    # The kickoff auto-fires on open (Observatory reads meta.autostart) rather
    # than sitting in the compose box waiting for a manual send.
    assert entry["autostart"] is True
    assert entry["allowed_tools"] == list(spinoff._BUILDER_TOOLS)
    assert entry["journal"] is False
    assert entry["cwd"]
    assert entry["bot"] == "keeper"
    assert entry["title"] == "spin: cool-idea"


def test_second_call_rejoins_without_touching_the_entry(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "twice")
    first = _post(spinoff_client, "twice").get_json()
    conv_id = first["conversation_id"]
    before = _index()[conv_id]

    r = _post(spinoff_client, "twice")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["newly_spawned"] is False
    assert body["conversation_id"] == conv_id

    after = _index()
    # exactly one entry for this slug, and it's byte-for-byte the same as
    # before — a rejoin must not re-write the draft (or anything else).
    assert list(after.keys()) == [conv_id]
    assert after[conv_id] == before


def test_archived_spinoff_gets_a_fresh_conversation(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "reopen-me")
    first = _post(spinoff_client, "reopen-me").get_json()
    old_id = first["conversation_id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[old_id]["archived"] = "2026-01-01T00:00:00"

    r = _post(spinoff_client, "reopen-me")
    assert r.status_code == 200
    body = r.get_json()
    assert body["newly_spawned"] is True
    new_id = body["conversation_id"]
    assert new_id != old_id

    index = _index()
    assert index[old_id]["archived"]
    assert index[new_id]["spinoff_slug"] == "reopen-me"
    assert not index[new_id].get("archived")


# --- starting the session without her opening it ---------------------------

def test_a_fresh_spinoff_launches_its_own_runner(spinoff_client):
    # The whole point: she doesn't open it, and it works anyway.
    _write_brief(store.SPINOFF_DIR, "self-starter")
    body = _post(spinoff_client, "self-starter").get_json()
    assert body["started"] is True
    assert len(spinoff_client._launches) == 1
    argv, kw = spinoff_client._launches[0]
    assert argv[1].endswith("scripts/spinoff_runner.py")
    assert argv[2] == body["conversation_id"]
    # Detached, or it dies with the request/CLI process that spawned it.
    assert kw["start_new_session"] is True


def test_the_kickoff_reaches_the_runner_by_file_not_argv(spinoff_client):
    # Doctrine: prompts travel as files. An argv-borne prompt is one refactor
    # away from being shell-interpolated.
    _write_brief(store.SPINOFF_DIR, "by-file")
    body = _post(spinoff_client, "by-file").get_json()
    argv, _ = spinoff_client._launches[0]
    kick = Path(argv[3])
    assert kick.exists()
    text = kick.read_text()
    assert "BRIEF.md" in text
    assert not any("BRIEF.md" in str(a) for a in argv[:3])
    assert body["conversation_id"] in str(kick)


def test_a_rejoin_does_not_re_fire_the_session(spinoff_client):
    # Rejoining a live spinoff must not start a second turn against a session
    # that may well be mid-work.
    _write_brief(store.SPINOFF_DIR, "no-restart")
    _post(spinoff_client, "no-restart")
    assert len(spinoff_client._launches) == 1
    body = _post(spinoff_client, "no-restart").get_json()
    assert body["newly_spawned"] is False
    assert "started" not in body
    assert len(spinoff_client._launches) == 1


def test_a_failed_launch_still_yields_a_usable_spinoff(spinoff_client, monkeypatch):
    # If the runner can't start, the session must still exist and still carry
    # the draft+autostart fallback, so opening it fires the kickoff the old way.
    def boom(*a, **kw):
        raise OSError("no fork for you")
    monkeypatch.setattr(spinoff.subprocess, "Popen", boom)
    _write_brief(store.SPINOFF_DIR, "cant-launch")
    body = _post(spinoff_client, "cant-launch").get_json()
    assert body["ok"] is True
    assert body["started"] is False
    entry = _index()[body["conversation_id"]]
    assert entry["autostart"] is True
    assert "BRIEF.md" in entry["draft"]


def test_start_false_mints_without_launching(spinoff_client):
    # The fork route's contract: a fork is a take-over, opened AFTER she stops
    # the original. Launching it on mint would put two agents on one session's
    # files — the thing forking exists to avoid.
    _write_brief(store.SPINOFF_DIR, "dont-start-me")
    payload, status = spinoff.open_spinoff("dont-start-me", start=False)
    assert status == 200
    assert payload["started"] is False
    assert spinoff_client._launches == []
    # ...but the entry still carries the fallback, so opening it works.
    entry = _index()[payload["conversation_id"]]
    assert entry["autostart"] is True


# --- which room it lands in -------------------------------------------------

def test_a_spinoff_lands_in_the_senders_room(spinoff_client, monkeypatch):
    # The point of the feature: work handed off from a Personal conversation
    # keeps happening in Personal — same room, same cwd, same act-or-ask.
    _sender(monkeypatch, lane="personal")
    _write_brief(store.SPINOFF_DIR, "stays-personal")
    body = _post(spinoff_client, "stays-personal").get_json()
    assert body["lane"] == "personal"
    entry = _index()[body["conversation_id"]]
    assert entry["lane"] == "personal"
    assert entry["cwd"] == observatory._lane_profile("personal")["cwd"]


def test_an_orchestra_sender_spins_off_into_orchestra(spinoff_client, monkeypatch):
    _sender(monkeypatch, lane="orchestra")
    _write_brief(store.SPINOFF_DIR, "stays-orchestra")
    body = _post(spinoff_client, "stays-orchestra").get_json()
    assert body["lane"] == "orchestra"
    entry = _index()[body["conversation_id"]]
    assert entry["cwd"] == observatory._lane_profile("orchestra")["cwd"]


def test_a_sender_that_predates_lanes_is_placed_by_its_cwd(spinoff_client, monkeypatch):
    # Inheritance goes through _conv_lane, not a bare field read, so the ~20
    # sessions with no `lane` of their own still hand down a real room: rooted
    # anywhere but the app checkout means Personal.
    _sender(monkeypatch, cwd=str(store.CONTENT_DIR.parent))
    _write_brief(store.SPINOFF_DIR, "old-sender")
    body = _post(spinoff_client, "old-sender").get_json()
    assert body["lane"] == "personal"


def test_no_sender_falls_to_the_gated_room(spinoff_client):
    # A plain terminal or a cron has no EXOCORTEX_CONV_ID to inherit from.
    # Fail toward ask: unknown lands in Orchestra, never in the ungated room.
    _write_brief(store.SPINOFF_DIR, "no-sender")
    body = _post(spinoff_client, "no-sender").get_json()
    assert body["lane"] == "orchestra"
    assert _index()[body["conversation_id"]]["lane"] == "orchestra"


def test_an_unknown_sender_id_also_falls_to_the_gated_room(spinoff_client, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "2026-01-01.000000")   # not in the index
    _write_brief(store.SPINOFF_DIR, "ghost-sender")
    assert _post(spinoff_client, "ghost-sender").get_json()["lane"] == "orchestra"


def test_a_named_room_beats_the_senders(spinoff_client, monkeypatch):
    # "unless otherwise specified" — she can say where it goes.
    _sender(monkeypatch, lane="personal")
    _write_brief(store.SPINOFF_DIR, "sent-away")
    body = _post(spinoff_client, "sent-away", room="orchestra").get_json()
    assert body["lane"] == "orchestra"
    assert _index()[body["conversation_id"]]["lane"] == "orchestra"


def test_unknown_room_is_refused_without_touching_the_index(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "bad-room")
    r = _post(spinoff_client, "bad-room", room="basement")
    assert r.status_code == 400
    assert r.get_json() == {"error": "unknown room 'basement'"}
    assert _index() == {}


def test_the_room_drives_the_safety_nets_rather_than_being_pinned(spinoff_client, monkeypatch):
    # act_gate/guard_docs are deliberately NOT written onto the entry — absent
    # is what lets the room keep driving them, so moving the card between rooms
    # actually re-scopes it (same contract as the create route).
    _sender(monkeypatch, lane="personal")
    _write_brief(store.SPINOFF_DIR, "unpinned")
    body = _post(spinoff_client, "unpinned").get_json()
    entry = _index()[body["conversation_id"]]
    assert "act_gate" not in entry and "guard_docs" not in entry
    config = observatory._conv_config(entry)
    assert config["act_gate"] is False and config["guard_docs"] is False
