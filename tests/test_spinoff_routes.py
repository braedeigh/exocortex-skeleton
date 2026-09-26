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
import os
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
    # Spinoffs no longer cut worktrees, but a regression would cut a REAL one
    # in the live checkout — so any call is recorded instead of run, and the
    # tests below assert there were none. Real git behaviour is covered
    # against a throwaway repo in test_worktrees.py.
    mints = []
    def fake_mint(slug, base="HEAD"):
        mints.append(slug)
        path = data_dir / "worktrees" / slug
        path.mkdir(parents=True, exist_ok=True)
        return path, f"agent/{slug}-0804-1200"
    monkeypatch.setattr(spinoff.worktrees, "mint", fake_mint)
    monkeypatch.setattr(spinoff.worktrees, "remove", lambda p: None)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    spinoff.register(app)
    client = app.test_client()
    client._launches = launches
    client._mints = mints
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
    # The room is what's asserted here; the ground it picks (the shared
    # checkout, no worktree) is the section below's business.
    _sender(monkeypatch, lane="orchestra")
    _write_brief(store.SPINOFF_DIR, "stays-orchestra")
    body = _post(spinoff_client, "stays-orchestra").get_json()
    assert body["lane"] == "orchestra"
    entry = _index()[body["conversation_id"]]
    assert entry["lane"] == "orchestra"


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


# --- no spinoff gets a private copy of the checkout ---------------------------
# Orchestra spinoffs used to be minted their own git worktree; that is in the
# shed (shed/orchestra-2026-09-25/SHED.md). Every room now works in its lane's
# own cwd, and only the steward's adopt-mode (below) stands in a worktree.

def test_no_room_mints_a_worktree_for_a_spinoff(spinoff_client):
    for room in ("coding", "personal", "orchestra"):
        _write_brief(store.SPINOFF_DIR, f"shared-{room}")
        body = _post(spinoff_client, f"shared-{room}", room=room).get_json()
        entry = _index()[body["conversation_id"]]
        assert entry.get("worktree") is None
        assert entry["cwd"] == observatory._lane_profile(room)["cwd"]
    assert spinoff_client._mints == []


def test_unknown_model_is_refused_without_touching_the_index(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "bad-model")
    r = _post(spinoff_client, "bad-model", model="gpt")
    assert r.status_code == 400
    assert "unknown model 'gpt'" in r.get_json()["error"]
    assert _index() == {}


def test_a_model_pin_lands_on_the_entry_at_mint(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "pinned")
    r = _post(spinoff_client, "pinned", model="fable")
    assert r.status_code == 200
    body = r.get_json()
    assert body["model"] == "fable"
    # On the entry, not just the reply — per-turn model resolution reads it
    # from there, so the pin holds from the kickoff turn onward.
    assert _index()[body["conversation_id"]]["model"] == "fable"


def test_no_model_means_no_field_so_the_cli_default_drives(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "unpinned")
    r = _post(spinoff_client, "unpinned")
    assert r.status_code == 200
    assert "model" not in _index()[r.get_json()["conversation_id"]]


# --- adopt-mode: standing a spinoff on an EXISTING branch (the steward seam) --
# `branch` stands the child on an existing branch. Same door, a mode — the
# steward endpoint (routes/branches.py) and any future escalation spawner both
# come through here rather than growing organs of their own.

def _fake_adopt(monkeypatch, data_dir, adoptions):
    def fake(slug, branch):
        adoptions.append((slug, branch))
        path = data_dir / "worktrees" / slug
        path.mkdir(parents=True, exist_ok=True)
        return path, branch
    monkeypatch.setattr(spinoff.worktrees, "adopt", fake)


def test_a_branch_spinoff_adopts_instead_of_minting(spinoff_client, monkeypatch, data_dir):
    adoptions = []
    _fake_adopt(monkeypatch, data_dir, adoptions)
    _write_brief(store.SPINOFF_DIR, "steward-x")

    body = _post(spinoff_client, "steward-x", room="orchestra",
                 branch="agent/x").get_json()

    assert adoptions == [("steward-x", "agent/x")]
    assert spinoff_client._mints == []          # no new branch was cut
    entry = _index()[body["conversation_id"]]
    assert entry["branch"] == "agent/x"         # the EXISTING branch, verbatim
    assert entry["cwd"] == body["worktree"]


def test_a_failed_adoption_refuses_the_whole_spawn(spinoff_client, monkeypatch):
    """A failed adoption refuses the whole spawn: a session that believes it stands on a branch and
    doesn't is the lie the worktree exists to prevent."""
    def boom(slug, branch):
        raise spinoff.worktrees.WorktreeError("branch is checked out elsewhere")
    monkeypatch.setattr(spinoff.worktrees, "adopt", boom)
    _write_brief(store.SPINOFF_DIR, "steward-stuck")

    r = _post(spinoff_client, "steward-stuck", room="orchestra", branch="agent/x")

    assert r.status_code == 409
    assert "agent/x" in r.get_json()["error"]
    assert _index() == {}                        # nothing minted, nothing staged
    assert spinoff_client._launches == []


def test_adoption_outside_orchestra_is_a_caller_bug(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "steward-lost")
    r = _post(spinoff_client, "steward-lost", room="coding", branch="agent/x")
    assert r.status_code == 400
    assert _index() == {}


def test_only_agent_branches_can_be_adopted(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "steward-main")
    r = _post(spinoff_client, "steward-main", room="orchestra", branch="main")
    assert r.status_code == 400
    assert _index() == {}


def test_a_rejoin_never_re_adopts(spinoff_client, monkeypatch, data_dir):
    adoptions = []
    _fake_adopt(monkeypatch, data_dir, adoptions)
    _write_brief(store.SPINOFF_DIR, "steward-again")
    first = _post(spinoff_client, "steward-again", room="orchestra",
                  branch="agent/x").get_json()

    again = _post(spinoff_client, "steward-again", room="orchestra",
                  branch="agent/x").get_json()

    assert again["newly_spawned"] is False
    assert again["conversation_id"] == first["conversation_id"]
    assert adoptions == [("steward-again", "agent/x")]


# --- briefs are filed on close, never dropped ---------------------------------

def test_closing_a_session_files_its_brief_instead_of_deleting_it(data_dir, monkeypatch):
    """A brief is the ONE record of what a session was asked to do — git shows
    what changed, never what was wanted. So closing moves it; it must still be
    readable afterwards, with its text intact."""
    monkeypatch.setattr(store, "SPINOFF_ARCHIVE_DIR", data_dir / "spinoff_archive")
    _write_brief(store.SPINOFF_DIR, "finished-thing")
    (store.SPINOFF_DIR / "finished-thing" / "BRIEF.md").write_text("the actual ask")

    filed = spinoff.archive_spinoff("finished-thing")

    assert not (store.SPINOFF_DIR / "finished-thing").exists()
    assert (filed / "BRIEF.md").read_text() == "the actual ask"


def test_filing_the_same_slug_twice_keeps_both_records(data_dir, monkeypatch):
    """Slugs get reused — the spawn door rejoins them, and a later spinoff can
    fairly take the same name. The older record must not be clobbered."""
    monkeypatch.setattr(store, "SPINOFF_ARCHIVE_DIR", data_dir / "spinoff_archive")
    _write_brief(store.SPINOFF_DIR, "reused")
    (store.SPINOFF_DIR / "reused" / "BRIEF.md").write_text("first ask")
    spinoff.archive_spinoff("reused")
    _write_brief(store.SPINOFF_DIR, "reused")
    (store.SPINOFF_DIR / "reused" / "BRIEF.md").write_text("second ask")

    spinoff.archive_spinoff("reused")

    filed = sorted(p.name for p in (data_dir / "spinoff_archive").iterdir())
    assert filed == ["reused", "reused-2"]
    assert (data_dir / "spinoff_archive" / "reused" / "BRIEF.md").read_text() == "first ask"


def test_filing_a_slug_that_was_never_spun_off_is_a_quiet_no_op(data_dir, monkeypatch):
    """Tidying up must never be able to fail a session close."""
    monkeypatch.setattr(store, "SPINOFF_ARCHIVE_DIR", data_dir / "spinoff_archive")
    assert spinoff.archive_spinoff("never-existed") is None
    assert spinoff.archive_spinoff("../escape") is None
    assert spinoff.archive_spinoff("") is None


def test_kickoff_paperwork_is_pruned_but_recent_diagnostics_survive(data_dir):
    """The .log is the only trace of a spawn that never woke up, so pruning is
    by AGE, not on sight. Briefs are never touched by this."""
    kick = store.SPINOFF_DIR / ".kickoffs"
    kick.mkdir(parents=True)
    old, new = kick / "2026-01-01.old.log", kick / "2026-08-22.new.log"
    old.write_text("stale")
    new.write_text("fresh")
    os.utime(old, (0, 0))

    spinoff._prune_kickoffs()

    assert not old.exists() and new.exists()


# --- the offer: a Go button in her chat instead of "shall I?" -----------------
# The sender stages an offer on its own conversation (scripts/spinoff_offer.py);
# her tap on Go is the confirm. Go arrives as a web request with no
# EXOCORTEX_CONV_ID, so the room has to come from the sender's entry.

def _offer_from(monkeypatch, *slugs, lane="personal", room=None):
    sender = _sender(monkeypatch, lane=lane)
    for slug in slugs:
        _write_brief(store.SPINOFF_DIR, slug, f"# Spinoff: title of {slug}\n")
    payload, status = spinoff.offer_spinoff(sender, list(slugs), lane=room)
    assert status == 200, payload
    # What follows is her tap in the browser, not the agent's turn.
    monkeypatch.delenv("EXOCORTEX_CONV_ID")
    return sender


def test_an_offer_refuses_a_slug_with_no_brief_yet(spinoff_client, monkeypatch):
    sender = _sender(monkeypatch)
    payload, status = spinoff.offer_spinoff(sender, ["unwritten"])
    assert status == 400
    assert "spinoff_offer" not in _index()[sender]


def test_the_offer_reads_back_with_each_brief_title(spinoff_client, monkeypatch):
    sender = _offer_from(monkeypatch, "keeper-chat")
    offer = spinoff_client.get(f"/api/spinoff/offer/{sender}").get_json()["offer"]
    assert offer["sessions"] == [{"slug": "keeper-chat", "title": "title of keeper-chat"}]


def test_go_spawns_into_the_senders_room_and_takes_the_offer(spinoff_client, monkeypatch):
    sender = _offer_from(monkeypatch, "one", "two", lane="personal")
    body = spinoff_client.post(f"/api/spinoff/offer/{sender}/go").get_json()
    assert [s["slug"] for s in body["spawned"]] == ["one", "two"]
    assert {s["lane"] for s in body["spawned"]} == {"personal"}
    assert "spinoff_offer" not in _index()[sender]


def test_a_named_room_on_the_offer_beats_the_senders(spinoff_client, monkeypatch):
    sender = _offer_from(monkeypatch, "elsewhere", lane="personal", room="coding")
    body = spinoff_client.post(f"/api/spinoff/offer/{sender}/go").get_json()
    assert body["spawned"][0]["lane"] == "coding"


def test_a_second_go_spawns_nothing(spinoff_client, monkeypatch):
    """A double tap, or a second open window, must not start the work twice."""
    sender = _offer_from(monkeypatch, "once")
    spinoff_client.post(f"/api/spinoff/offer/{sender}/go")
    r = spinoff_client.post(f"/api/spinoff/offer/{sender}/go")
    assert r.status_code == 409
    assert len(spinoff_client._launches) == 1


def test_dismiss_clears_the_offer_without_spawning(spinoff_client, monkeypatch):
    sender = _offer_from(monkeypatch, "not-now")
    spinoff_client.post(f"/api/spinoff/offer/{sender}/dismiss")
    assert spinoff_client.get(f"/api/spinoff/offer/{sender}").get_json()["offer"] is None
    assert spinoff_client._launches == []


def test_a_new_offer_replaces_the_old_one(spinoff_client, monkeypatch):
    sender = _offer_from(monkeypatch, "first-draft")
    _write_brief(store.SPINOFF_DIR, "second-draft")
    spinoff.offer_spinoff(sender, ["second-draft"])
    assert _index()[sender]["spinoff_offer"]["slugs"] == ["second-draft"]
