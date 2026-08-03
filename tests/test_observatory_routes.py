"""The observatory's pipe (routes/observatory.py, design doc bot-surface-design).

Contracts pinned here:
- a send relays the claude stream-json events as SSE AND appends them to the
  owner's own conversation log (her record is the record);
- capture-first: a journaling bot mints the B card BEFORE claude is spawned;
- off-the-record (record: false) skips the journal mint and NOTHING else: her
  words and the reply still go in her own chat log, flagged off_record, because
  a hole she can't read back was never the point (Terra's amendment, 07-23,
  amended again). Only an `operator: true` send — a cue the app fires on her
  behalf — still leaves a bare gap marker. In a journaling session an off-record
  turn also leaves a hash in .keeper/off_record.jsonl so the two fallback
  capture doors don't "restore" the card the server skipped on purpose;
- the second turn of a conversation resumes claude with the stored session id.

`claude` itself is a stub script (EXOCORTEX_CLAUDE_BIN / observatory.CLAUDE_BIN)
that reads the prompt from stdin and prints canned NDJSON — the pipe is what's
under test, not the model.
"""
import hashlib
import json
import stat
import subprocess
import threading
from datetime import datetime, timedelta

import pytest
from flask import Flask

import recap_summary
import store
from routes import observatory, terminal


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
    """Minimal app with only observatory routes; claude is the stub above; the
    journal mint is recorded, not run."""
    argv_log = tmp_path / "claude_argv.jsonl"
    stub = tmp_path / "claude-stub"
    stub.write_text(STUB.format(argv_log=str(argv_log)))
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(observatory, "CLAUDE_BIN", str(stub))
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    # The roster asks recap_summary for card summaries — never let a test
    # kick off a real background Haiku call.
    monkeypatch.setattr(recap_summary, "_spawn", lambda fn: None)

    # The journal mint is recorded, not run. `mints` keeps the (who, body) pairs
    # most tests assert on; `mint_calls` keeps the full kwargs for the ones that
    # care about provenance (session) or the parent link (reply_to). The fake
    # returns a card id rather than True because the highlight door hangs her
    # annotation off the quote card by id — a bool would lose that.
    mints = []
    mint_calls = []

    def _fake_mint(body, typed, tags=None, who="B", session=None, reply_to=None):
        mints.append((who, body))
        mint_calls.append({"who": who, "body": body, "tags": tags,
                           "session": session, "reply_to": reply_to})
        return f"2026-08-01.120{len(mint_calls)}{who.lower()}"

    monkeypatch.setattr(terminal, "_capture_journal", _fake_mint)

    app = Flask(__name__)
    app.config.update(TESTING=True)
    observatory.register(app)
    client = app.test_client()
    client._mints = mints
    client._mint_calls = mint_calls
    client._argv_log = argv_log
    before = set(threading.enumerate())
    yield client

    # JOIN THE TURN THREADS BEFORE TEARING DOWN. A send hands the turn to a
    # detached daemon thread on purpose (it must outlive the HTTP request), and
    # its last act is writing `running: False` back through the store. Left
    # unjoined it lands AFTER monkeypatch has restored store.DATA_DIR — a write
    # aimed at whatever the real environment points at. That is exactly how a
    # test's empty index once went over the owner's live session roster. The
    # process-wide quarantine in conftest is the wall; this is not leaving
    # anything leaning on it.
    for t in threading.enumerate():
        if t not in before and t is not threading.current_thread():
            t.join(timeout=5)


def _send(client, **body):
    body.setdefault("text", "hello")
    return client.post("/api/observatory/keeper/send", json=body)


def _sse_events(resp):
    out = []
    for chunk in resp.get_data(as_text=True).split("\n\n"):
        chunk = chunk.strip()
        if chunk.startswith("data: "):
            out.append(json.loads(chunk[len("data: "):]))
    return out


def _conv_from_roster(client, conv_id):
    convs = client.get("/api/observatory").get_json()["bots"][0]["conversations"]
    return next(c for c in convs if c["id"] == conv_id)


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
    return client.post("/api/observatory/keeper/conversations",
                       json={"title": "keeper", "journal": True}).get_json()["id"]


def test_journal_mints_before_claude_is_spawned(bot_client, monkeypatch):
    # If the spawn ran first, the mint recorder would still be empty when it
    # fires — assert the order explicitly by failing the spawn: the card must
    # already be minted even though claude never ran.
    conv_id = _journal_conv(bot_client)
    def boom(*a, **k):
        raise OSError("no claude")
    monkeypatch.setattr(observatory, "_spawn", boom)
    resp = _send(bot_client, text="a journal line", conversation_id=conv_id)
    assert resp.status_code == 502
    assert bot_client._mints == [("B", "a journal line")]


def test_fresh_sessions_do_not_journal_by_default(bot_client):
    # Implicit conversation (no id) and explicit create without journal:true
    # are both workshops: nothing mints. The diary door is opt-in.
    _sse_events(_send(bot_client, text="workshop thought"))
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "scratch"}).get_json()["id"]
    _sse_events(_send(bot_client, text="another", conversation_id=conv_id))
    assert bot_client._mints == []


def test_off_record_skips_the_journal_but_stays_in_her_chat(bot_client):
    conv_id = _journal_conv(bot_client)
    resp = _send(bot_client, text="when did i last...", record=False,
                 conversation_id=conv_id)
    events = _sse_events(resp)
    conv_id = events[0]["conversation_id"]
    # streams to the screen normally...
    assert any(e["type"] == "assistant" for e in events)
    # ...mints nothing...
    assert bot_client._mints == []
    # ...but the conversation reads back whole: her line, flagged, and the
    # reply to it. Dropping both is what left her scrolling past holes.
    log = _conv_log(conv_id)
    assert log[0]["type"] == "user" and log[0]["text"] == "when did i last..."
    assert log[0]["off_record"] is True
    assert log[0]["journaled"] is False
    assert [e["type"] for e in log[1:]] == ["system", "assistant", "result"]


def test_on_record_send_carries_no_off_record_flag(bot_client):
    conv_id = _journal_conv(bot_client)
    resp = _send(bot_client, text="a journal line", conversation_id=conv_id)
    conv_id = _sse_events(resp)[0]["conversation_id"]
    assert "off_record" not in _conv_log(conv_id)[0]


def test_an_operator_cue_still_leaves_a_bare_gap(bot_client):
    # The red card's "Resume session?" nudge is the app talking, not her —
    # showing it would put words in her mouth in her own transcript.
    conv_id = _journal_conv(bot_client)
    resp = _send(bot_client, text="That turn ended in an error.", record=False,
                 operator=True, conversation_id=conv_id)
    conv_id = _sse_events(resp)[0]["conversation_id"]
    assert bot_client._mints == []
    log = _conv_log(conv_id)
    assert log[0]["type"] == "off-record-gap"
    # the reply to it is still kept — only the cue is hidden
    assert [e["type"] for e in log[1:]] == ["system", "assistant", "result"]


def test_off_record_leaves_a_suppression_breadcrumb_for_the_fallback_doors(bot_client):
    # Skipping the mint isn't enough on its own: the model still gets the text,
    # so it lands in claude's transcript, and the two fallback capture doors
    # (the UserPromptSubmit hook, the cron'd reconciler) mint whatever the pool
    # is missing from a journaling session — which silently undid the switch.
    # The hash written here is what tells them "skipped on purpose, not lost".
    conv_id = _journal_conv(bot_client)
    _sse_events(_send(bot_client, text="a private line", record=False,
                      conversation_id=conv_id))
    path = store.CONTENT_DIR / ".keeper" / "off_record.jsonl"
    entries = [json.loads(l) for l in path.read_text().splitlines()]
    assert [e["sha256"] for e in entries] == [
        hashlib.sha256(b"a private line").hexdigest()
    ]


def test_on_record_send_writes_no_suppression_breadcrumb(bot_client):
    conv_id = _journal_conv(bot_client)
    _sse_events(_send(bot_client, text="a journal line", conversation_id=conv_id))
    assert not (store.CONTENT_DIR / ".keeper" / "off_record.jsonl").exists()


def test_off_record_in_a_workshop_session_writes_no_breadcrumb(bot_client):
    # A session that doesn't journal has no fallback door to hold off — the
    # sidecar would just accumulate hashes nothing ever reads.
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "scratch"}).get_json()["id"]
    _sse_events(_send(bot_client, text="workshop aside", record=False,
                      conversation_id=conv_id))
    assert not (store.CONTENT_DIR / ".keeper" / "off_record.jsonl").exists()


def test_approval_resume_logs_the_command_not_a_blank_gap(bot_client):
    # Her Approve/Deny tap fires an off-record resume send carrying the decision.
    # It must never journal (control, not a life moment) but must name the exact
    # command in the transcript — a decision line, not the anonymous gap an
    # ordinary off-record send leaves.
    conv_id = _journal_conv(bot_client)
    resp = _send(bot_client, text="Approved — retry now.", record=False,
                 decision={"kind": "approve", "command": "git commit -m hi"},
                 conversation_id=conv_id)
    conv_id = _sse_events(resp)[0]["conversation_id"]
    assert bot_client._mints == []  # still never journaled
    log = _conv_log(conv_id)
    assert log[0]["type"] == "decision"
    assert log[0]["decision"] == "approve"
    assert log[0]["command"] == "git commit -m hi"
    # and what the agent did once she approved is in the transcript too
    assert [e["type"] for e in log[1:]] == ["system", "assistant", "result"]


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
    assert bot_client.post("/api/observatory/nope/send", json={"text": "x"}).status_code == 404
    assert _send(bot_client, text="  ").status_code == 400


def test_conversation_endpoint_round_trips(bot_client):
    events = _sse_events(_send(bot_client, text="hello there"))
    conv_id = events[0]["conversation_id"]
    resp = bot_client.get(f"/api/observatory/conversation/{conv_id}")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["events"][0]["text"] == "hello there"
    assert data["meta"]["bot"] == "keeper"
    # roster lists the conversation under the keeper
    roster = bot_client.get("/api/observatory").get_json()["bots"]
    keeper = next(b for b in roster if b["id"] == "keeper")
    assert any(c["id"] == conv_id for c in keeper["conversations"])


def test_never_sent_session_opens_with_its_staged_draft(bot_client):
    # A freshly-minted session (a /spinoff staged draft, or "+ New session")
    # has an index entry but no jsonl until its first send. Opening it must
    # return 200 with empty events and the staged draft intact — NOT 404 —
    # or the client's history load rejects and the draft never prefills the
    # composer (the "staged" badge shows but the compose box is empty).
    resp = bot_client.post("/api/observatory/conversations",
                           json={"title": "spun off"})
    conv_id = resp.get_json()["id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["draft"] = "Read the BRIEF and follow its Protocol."

    resp = bot_client.get(f"/api/observatory/conversation/{conv_id}")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["events"] == []
    assert data["meta"]["draft"] == "Read the BRIEF and follow its Protocol."

    # A conv_id with no index entry at all is still genuinely not found.
    assert bot_client.get(
        "/api/observatory/conversation/2099-01-01.000000").status_code == 404


def test_send_consumes_the_autostart_flag_so_it_never_refires(bot_client):
    # /spinoff mints a session with draft + autostart:true; the Observatory
    # auto-fires that kickoff on open. The send that fires it must clear BOTH
    # draft and autostart, or reopening the session (e.g. mid-turn) would
    # auto-fire the kickoff a second time.
    resp = bot_client.post("/api/observatory/conversations",
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
    # /api/bots/* stays live as an alias of /api/observatory/* for cached
    # PWA clients that still have the old path baked into their JS bundle.
    resp = bot_client.get("/api/bots")
    assert resp.status_code == 200
    roster = resp.get_json()["bots"]
    assert any(b["id"] == "keeper" for b in roster)


def test_named_session_create_rename_and_journal_toggle(bot_client):
    resp = bot_client.post("/api/observatory/keeper/conversations",
                           json={"title": "morning pages"})
    assert resp.status_code == 200
    conv_id = resp.get_json()["id"]
    meta = store.read("bot_chats/index", {})[conv_id]
    # journal is opt-in: omitted means workshop
    assert meta["title"] == "morning pages" and meta["journal"] is False
    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                           json={"title": "evening pages", "journal": True})
    assert resp.status_code == 200
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["title"] == "evening pages" and meta["journal"] is True


def test_pinned_session_sorts_first(bot_client):
    old = _journal_conv(bot_client)
    newer = bot_client.post("/api/observatory/keeper/conversations",
                            json={"title": "newer"}).get_json()["id"]
    # Pin the older one (data-side, as the migration does).
    with store.mutate("bot_chats/index", {}) as index:
        index[old]["pinned"] = True
    convs = bot_client.get("/api/observatory").get_json()["bots"][0]["conversations"]
    assert convs[0]["id"] == old
    assert any(c["id"] == newer for c in convs[1:])


def test_roster_orders_by_creation_not_activity(bot_client):
    # Cards are fixed by creation time and never reshuffle on activity: an
    # older session getting the most-recent touch must NOT jump above a newer
    # one (her anti-churn call — the list holds still while dots/accents move).
    older = bot_client.post("/api/observatory/keeper/conversations",
                            json={"title": "older"}).get_json()["id"]
    newer = bot_client.post("/api/observatory/keeper/conversations",
                            json={"title": "newer"}).get_json()["id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[older]["started"] = "2026-07-01T00:00:00"
        index[newer]["started"] = "2026-07-02T00:00:00"
        # The OLDER session just did something more recent than the newer one.
        index[older]["last_at"] = "2026-07-27T00:00:00"
        index[newer]["last_at"] = "2026-07-02T00:00:00"
    convs = bot_client.get("/api/observatory").get_json()["bots"][0]["conversations"]
    ids = [c["id"] for c in convs]
    assert ids.index(newer) < ids.index(older)


def test_sending_into_an_archived_session_brings_it_back(bot_client):
    # Her ask: "I need a feature to open old chats." /atlas already lists
    # archived sessions and navigates into them, so the missing half was
    # making one live again — talking to it IS the un-archive, with no
    # separate restore action to hunt for.
    conv_id = _sse_events(_send(bot_client, text="first turn"))[0]["conversation_id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["archived"] = "2026-08-02T05:00:01"
    roster = bot_client.get("/api/observatory").get_json()["sessions"]
    assert not any(c["id"] == conv_id for c in roster)

    _sse_events(_send(bot_client, text="you awake?", conversation_id=conv_id))

    assert "archived" not in store.read("bot_chats/index", {})[conv_id]
    roster = bot_client.get("/api/observatory").get_json()["sessions"]
    assert any(c["id"] == conv_id for c in roster)


def test_roster_clears_a_running_flag_orphaned_by_a_dead_worker(bot_client):
    # A worker that crashed mid-turn never gets to clear `running` — the
    # roster must apply the same staleness check bot_conversation does, or
    # the session shows busy forever.
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "orphaned"}).get_json()["id"]
    stale = (datetime.now() - timedelta(seconds=observatory._RUNNING_STALE_SEC + 60)).isoformat(timespec="seconds")
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["running"] = True
        index[conv_id]["last_at"] = stale
    convs = bot_client.get("/api/observatory").get_json()["bots"][0]["conversations"]
    conv = next(c for c in convs if c["id"] == conv_id)
    assert conv["running"] is False
    # a fresh (non-stale) running flag still reads as busy
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["last_at"] = observatory._now()
    convs = bot_client.get("/api/observatory").get_json()["bots"][0]["conversations"]
    conv = next(c for c in convs if c["id"] == conv_id)
    assert conv["running"] is True


# --- last_prompt: her ask, on the card, while it works ----------------------
# Stamped at send time (no jsonl re-read per roster poll). Two gates are
# privacy, not polish, and both live server-side so the card never re-decides.

def test_a_real_ask_lands_on_the_card(bot_client):
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "work"}).get_json()["id"]
    _sse_events(_send(bot_client, text="collapse the file list on session cards",
                      conversation_id=conv_id))
    conv = _conv_from_roster(bot_client, conv_id)
    assert conv["last_prompt"] == "collapse the file list on session cards"


def test_an_off_record_send_never_lands_on_the_card(bot_client):
    # The whole point of off-the-record is that the turn leaves no trace.
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "work"}).get_json()["id"]
    _sse_events(_send(bot_client, text="something i want no trace of at all",
                      record=False, conversation_id=conv_id))
    assert "last_prompt" not in _conv_from_roster(bot_client, conv_id)


def test_a_journaling_session_never_puts_its_prompts_on_the_card(bot_client):
    # A journaling session's prompts ARE the diary, and the pinned Keeper
    # session sits at the top of the roster.
    conv_id = _journal_conv(bot_client)
    _sse_events(_send(bot_client, text="a private thing about my day",
                      conversation_id=conv_id))
    assert "last_prompt" not in _conv_from_roster(bot_client, conv_id)


def test_a_bare_continuation_leaves_the_previous_ask_up(bot_client):
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "work"}).get_json()["id"]
    _sse_events(_send(bot_client, text="rework the roster card layout",
                      conversation_id=conv_id))
    for filler in ("go", "keep going", "yeah do it", "/compact"):
        _sse_events(_send(bot_client, text=filler, conversation_id=conv_id))
        # "go" says nothing about the work; the real ask is still the truest
        # thing the card can say.
        assert _conv_from_roster(bot_client, conv_id)["last_prompt"] == \
            "rework the roster card layout"


def test_a_long_ask_is_trimmed_to_one_line(bot_client):
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "work"}).get_json()["id"]
    _sse_events(_send(bot_client, text="ok so\nthe real ask is on the second line " + "x" * 300,
                      conversation_id=conv_id))
    got = _conv_from_roster(bot_client, conv_id)["last_prompt"]
    assert len(got) == observatory._MAX_PROMPT_CHARS
    assert "\n" not in got
    # Whitespace is collapsed rather than cut at the first newline, so the
    # throat-clearing opener doesn't hide the point.
    assert got.startswith("ok so the real ask is on the second line")


# --- model_effective: what the card shows a session is running on -----------
# Nearly every session pins no model and inherits the CLI's default, so a card
# reading the raw field would answer "unset" for almost all of them. The roster
# resolves the answer beside the raw field, never over it.

def test_roster_resolves_an_unpinned_session_to_the_cli_default(bot_client, monkeypatch):
    monkeypatch.setattr(observatory, "_cli_default_model", lambda: "opus[1m]")
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "inherits"}).get_json()["id"]
    conv = _conv_from_roster(bot_client, conv_id)
    assert conv["model_effective"] == "opus[1m]"
    assert "model" not in conv   # the raw pin is still absent — nothing was written


def test_a_pinned_model_wins_over_the_cli_default(bot_client, monkeypatch):
    monkeypatch.setattr(observatory, "_cli_default_model", lambda: "opus[1m]")
    # The ✎ dialog's door, not the legacy per-bot create (which takes no model).
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "pinned", "model": "haiku"}).get_json()["id"]
    conv = _conv_from_roster(bot_client, conv_id)
    assert conv["model_effective"] == "haiku"
    assert conv["model"] == "haiku"


def test_clearing_the_pin_falls_back_to_the_cli_default(bot_client, monkeypatch):
    monkeypatch.setattr(observatory, "_cli_default_model", lambda: "opus[1m]")
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "pinned", "model": "haiku"}).get_json()["id"]
    bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                    json={"name": "pinned", "model": ""})
    conv = _conv_from_roster(bot_client, conv_id)
    assert "model" not in conv                      # the pin is gone…
    assert conv["model_effective"] == "opus[1m]"    # …and the default shows through


def test_no_model_anywhere_leaves_the_field_off(bot_client, monkeypatch):
    # The card shows nothing rather than guessing or printing "unknown".
    monkeypatch.setattr(observatory, "_cli_default_model", lambda: None)
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "bare"}).get_json()["id"]
    assert "model_effective" not in _conv_from_roster(bot_client, conv_id)


def test_an_unreadable_cli_settings_file_is_not_fatal(monkeypatch, tmp_path):
    # A decoration must never 500 the roster.
    monkeypatch.setattr(observatory.Path, "home", staticmethod(lambda: tmp_path))
    assert observatory._cli_default_model() is None
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.json").write_text("{not json")
    assert observatory._cli_default_model() is None
    (tmp_path / ".claude" / "settings.json").write_text('{"model": "  "}')
    assert observatory._cli_default_model() is None
    (tmp_path / ".claude" / "settings.json").write_text('{"model": "sonnet"}')
    assert observatory._cli_default_model() == "sonnet"


def test_non_journal_session_logs_but_never_mints(bot_client):
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
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
    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/journal-output",
                           json={"text": "echo: hello"})
    assert resp.status_code == 200
    # Minted in the keeper's voice, not hers.
    assert bot_client._mints == [("K", "echo: hello")]
    # The mark lands in the log so the UI's ✦ survives reload.
    mark = _conv_log(conv_id)[-1]
    assert mark["type"] == "journal-mark" and mark["text"] == "echo: hello"


def test_tap_journal_validates_conv_and_text(bot_client):
    assert bot_client.post("/api/observatory/conversation/nope/journal-output",
                           json={"text": "x"}).status_code == 404
    conv_id = _sse_events(_send(bot_client, text="hi"))[0]["conversation_id"]
    assert bot_client.post(f"/api/observatory/conversation/{conv_id}/journal-output",
                           json={"text": "  "}).status_code == 400
    assert bot_client._mints == []


def _highlight(client, conv_id, **body):
    body.setdefault("who", "K")
    body.setdefault("quote", "echo: hello")
    body.setdefault("turn", 1)
    body.setdefault("start", 0)
    body.setdefault("end", 11)
    return client.post(
        f"/api/observatory/conversation/{conv_id}/journal-highlight", json=body)


def test_highlight_mints_the_quote_in_the_voice_that_said_it(bot_client):
    conv_id = _sse_events(_send(bot_client, text="hello"))[0]["conversation_id"]
    assert _highlight(bot_client, conv_id).status_code == 200
    # One card, the keeper's voice, stamped with the room it came out of.
    assert bot_client._mint_calls == [
        {"who": "K", "body": "echo: hello", "tags": None,
         "session": conv_id, "reply_to": None},
    ]


def test_highlight_of_her_own_message_mints_a_b_card(bot_client):
    conv_id = _sse_events(_send(bot_client, text="hello"))[0]["conversation_id"]
    _highlight(bot_client, conv_id, who="B", quote="hello", turn=0)
    assert bot_client._mint_calls[-1]["who"] == "B"


def test_a_note_becomes_her_own_card_replying_to_the_quote(bot_client):
    conv_id = _sse_events(_send(bot_client, text="hello"))[0]["conversation_id"]
    resp = _highlight(bot_client, conv_id, note="this is the bit that matters")
    body = resp.get_json()
    quote_call, note_call = bot_client._mint_calls
    # The quote keeps the keeper's voice; the note is hers and hangs under it.
    assert quote_call["who"] == "K" and quote_call["reply_to"] is None
    assert note_call["who"] == "B"
    assert note_call["body"] == "this is the bit that matters"
    assert note_call["reply_to"] == body["card"]
    # Both carry the session, so either card can lead back to the room.
    assert note_call["session"] == conv_id


def test_highlight_without_a_note_mints_only_the_quote(bot_client):
    conv_id = _sse_events(_send(bot_client, text="hello"))[0]["conversation_id"]
    _highlight(bot_client, conv_id, note="   ")
    assert len(bot_client._mint_calls) == 1


def test_highlight_anchor_lands_in_the_log_so_the_mark_survives_reload(bot_client):
    conv_id = _sse_events(_send(bot_client, text="hello"))[0]["conversation_id"]
    resp = _highlight(bot_client, conv_id, turn=3, start=5, end=9, quote="o: h")
    mark = _conv_log(conv_id)[-1]
    assert mark["type"] == "journal-highlight"
    assert (mark["turn"], mark["start"], mark["end"]) == (3, 5, 9)
    assert mark["quote"] == "o: h"
    # The logged card id is the one the client got back — that pairing is what
    # lets a re-lit mark link through to the journal card it made.
    assert mark["card"] == resp.get_json()["card"]


def test_highlight_validates_its_inputs(bot_client):
    conv_id = _sse_events(_send(bot_client, text="hello"))[0]["conversation_id"]
    # Unknown conversation.
    assert _highlight(bot_client, "2020-01-01.000000").status_code == 404
    # Empty quote, unknown speaker, and a non-integer anchor are all refusals.
    assert _highlight(bot_client, conv_id, quote="   ").status_code == 400
    assert _highlight(bot_client, conv_id, who="X").status_code == 400
    assert _highlight(bot_client, conv_id, start="0").status_code == 400
    assert bot_client._mint_calls == []


def test_close_hides_the_session_but_deletes_nothing(bot_client):
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "done with this"}).get_json()["id"]
    _sse_events(_send(bot_client, text="some work", conversation_id=conv_id))
    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/close")
    assert resp.status_code == 200
    # Gone from the roster...
    convs = bot_client.get("/api/observatory").get_json()["bots"][0]["conversations"]
    assert not any(c["id"] == conv_id for c in convs)
    # ...but the log and index entry survive — close archives, never deletes.
    assert (store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl").exists()
    assert store.read("bot_chats/index", {})[conv_id]["archived"]


class _FakeProc:
    """Stand-in for a live turn's Popen: alive until killed."""
    def __init__(self):
        self.killed = False

    def poll(self):
        return -9 if self.killed else None

    def kill(self):
        self.killed = True


def test_close_stops_a_locally_running_turn(bot_client, monkeypatch):
    # Closing a session mid-turn now KILLS the turn (it used to leave the
    # subprocess running). When this worker owns the proc, the kill lands
    # directly and the conv is marked as an intentional stop.
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "busy"}).get_json()["id"]
    proc = _FakeProc()
    monkeypatch.setattr(observatory, "_running_procs", {conv_id: proc})
    monkeypatch.setattr(observatory, "_stop_requested", set())
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["running"] = True

    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/close")
    assert resp.status_code == 200
    assert proc.killed is True                       # the turn was shot
    assert conv_id in observatory._stop_requested   # ...read as a clean stop
    assert store.read("bot_chats/index", {})[conv_id]["archived"]  # and archived


def test_close_flags_stop_for_a_turn_on_another_worker(bot_client, monkeypatch):
    # No local proc means the OTHER gunicorn worker owns the turn — close can't
    # kill it here, so it flags stop_requested for that worker to act on, then
    # archives. Mirrors /stop's cross-worker path.
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "busy elsewhere"}).get_json()["id"]
    monkeypatch.setattr(observatory, "_running_procs", {})
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["running"] = True

    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/close")
    assert resp.status_code == 200
    entry = store.read("bot_chats/index", {})[conv_id]
    assert entry["stop_requested"]
    assert entry["archived"]


def test_close_never_kills_the_pinned_keeper_turn(bot_client, monkeypatch):
    # Pinned is checked BEFORE the kill: refusing to close the Keeper must not
    # shoot its running turn on the way out.
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "the diary"}).get_json()["id"]
    proc = _FakeProc()
    monkeypatch.setattr(observatory, "_running_procs", {conv_id: proc})
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["pinned"] = True
        index[conv_id]["running"] = True

    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/close")
    assert resp.status_code == 400
    assert proc.killed is False
    assert not store.read("bot_chats/index", {})[conv_id].get("archived")


def test_pinned_keeper_session_refuses_to_close(bot_client):
    conv_id = _journal_conv(bot_client)
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id]["pinned"] = True
    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/close")
    assert resp.status_code == 400
    convs = bot_client.get("/api/observatory").get_json()["bots"][0]["conversations"]
    assert any(c["id"] == conv_id for c in convs)


def test_roster_carries_cached_summaries(bot_client, monkeypatch):
    events = _sse_events(_send(bot_client, text="summarize me"))
    conv_id = events[0]["conversation_id"]
    monkeypatch.setattr(recap_summary, "get_summary",
                        lambda sid, path, builder=None: "Working on the thing."
                        if sid == f"bot:{conv_id}" else None)
    convs = bot_client.get("/api/observatory").get_json()["bots"][0]["conversations"]
    conv = next(c for c in convs if c["id"] == conv_id)
    assert conv["summary"] == "Working on the thing."


# --- the hovercard's preview -------------------------------------------------
# GET .../preview answers "what did this session last SAY", for the terrain map's
# agent hovercard. The contracts that matter: it finds speech past a tail of tool
# machinery, it never quotes a journaling session, and it reads only the tail of
# the log (so hovering an agent can't cost a megabyte).


def _seed_transcript(conv_id, lines, journal=False):
    """An index entry plus a hand-written jsonl — a conversation with a known
    log, without going through a send. (Named apart from the gate tests'
    `_seed_conv` further down: same file, one namespace.)"""
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = {"title": "T", "journal": journal,
                          "started": "x", "last_at": "x"}
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    path.write_text("".join(json.dumps(l) + "\n" for l in lines))
    return path


def _assistant(text):
    return {"type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def test_preview_returns_the_last_thing_the_agent_said(bot_client):
    _seed_transcript("conv-said", [
        {"type": "user", "text": "first ask"},
        _assistant("an older reply"),
        {"type": "user", "text": "second ask"},
        _assistant("the newest reply"),
    ])
    body = bot_client.get("/api/observatory/conversation/conv-said/preview").get_json()
    assert body["role"] == "assistant"
    assert body["text"] == "the newest reply"
    assert body["truncated"] is False


def test_preview_looks_past_tool_machinery_to_find_speech(bot_client):
    # A turn usually ENDS in tool traffic: a result event, and claude echoing
    # tool output back to itself as {"type": "user", "message": ...}. None of
    # that is speech, and a naive "last event" read would show the wrong thing
    # (or nothing) on every card of a working agent.
    _seed_transcript("conv-tools", [
        {"type": "user", "text": "go"},
        _assistant("here's what I did"),
        {"type": "assistant", "message": {"role": "assistant",
                                          "content": [{"type": "tool_use", "name": "Edit"}]}},
        {"type": "user", "message": {"role": "user", "content": "tool result"}},
        {"type": "result", "subtype": "success"},
    ])
    body = bot_client.get("/api/observatory/conversation/conv-tools/preview").get_json()
    assert (body["role"], body["text"]) == ("assistant", "here's what I did")


def test_preview_falls_back_to_her_ask_when_nothing_has_answered_yet(bot_client):
    _seed_transcript("conv-fresh", [{"type": "user", "text": "just sent this"}])
    body = bot_client.get("/api/observatory/conversation/conv-fresh/preview").get_json()
    assert (body["role"], body["text"]) == ("user", "just sent this")


def test_preview_withholds_a_journaling_session(bot_client):
    _seed_transcript("conv-diary", [_assistant("something from the diary")], journal=True)
    body = bot_client.get("/api/observatory/conversation/conv-diary/preview").get_json()
    assert body["private"] is True
    assert body["text"] == ""
    assert body["role"] is None


def test_preview_truncates_and_says_so(bot_client):
    _seed_transcript("conv-long", [_assistant("x" * 5000)])
    body = bot_client.get("/api/observatory/conversation/conv-long/preview").get_json()
    assert body["truncated"] is True
    assert len(body["text"]) == observatory._PREVIEW_CHARS


def test_preview_reads_only_the_tail_of_a_huge_log(bot_client):
    # The point of the endpoint. Pad well past the tail window with old replies,
    # then confirm it still answers with the newest one — i.e. it seeked rather
    # than read the file, and the seek landed mid-line without breaking parsing.
    filler = [_assistant("old " + "y" * 2000) for _ in range(300)]
    path = _seed_transcript("conv-huge", filler + [_assistant("the newest reply")])
    assert path.stat().st_size > observatory._PREVIEW_TAIL_BYTES
    body = bot_client.get("/api/observatory/conversation/conv-huge/preview").get_json()
    assert body["text"] == "the newest reply"


def test_preview_404s_an_unknown_session(bot_client):
    assert bot_client.get("/api/observatory/conversation/nope-1/preview").status_code == 404


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
    real_spawn = observatory._spawn
    def spy(bot, text, resume_sid, cwd_override=None):
        seen["cwd"] = cwd_override
        seen["resume"] = resume_sid
        return real_spawn(bot, text, resume_sid, cwd_override)
    monkeypatch.setattr(observatory, "_spawn", spy)
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
    monkeypatch.setattr(observatory, "CLAUDE_BIN", str(stub))


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
    assert bot_client.post(f"/api/observatory/conversation/{conv_id}/stop").status_code == 200
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


# --- last_error: the roster's red card --------------------------------------
# A turn that dies used to exist only as an event in the live stream and a line
# in the jsonl — so a session that failed with nobody watching looked idle on
# the roster. The index now carries how the last turn ENDED.

FAILING_STUB = """#!/usr/bin/env python3
import sys
sys.stderr.write("boom: the model went away\\n")
sys.exit(3)
"""


def _install_failing_stub(tmp_path, monkeypatch):
    stub = tmp_path / "claude-fails"
    stub.write_text(FAILING_STUB)
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(observatory, "CLAUDE_BIN", str(stub))


def test_a_failed_turn_records_last_error_on_the_session(bot_client, tmp_path, monkeypatch):
    _install_failing_stub(tmp_path, monkeypatch)
    events = _sse_events(_send(bot_client, text="go"))
    conv_id = events[0]["conversation_id"]
    meta = _wait_not_running(conv_id)
    assert "boom: the model went away" in meta["last_error"]


def test_a_clean_turn_clears_a_previous_failure(bot_client, tmp_path, monkeypatch):
    _install_failing_stub(tmp_path, monkeypatch)
    conv_id = _sse_events(_send(bot_client, text="go"))[0]["conversation_id"]
    assert _wait_not_running(conv_id).get("last_error")
    # The flag means "the last thing this session did was fail" — so a turn
    # that succeeds has to take it back off, not leave the card red forever.
    monkeypatch.setattr(observatory, "CLAUDE_BIN", str(tmp_path / "claude-stub"))
    _sse_events(_send(bot_client, text="again", conversation_id=conv_id))
    assert "last_error" not in _wait_not_running(conv_id)


def test_a_stop_is_not_recorded_as_an_error(bot_client, tmp_path, monkeypatch):
    _install_slow_stub(tmp_path, monkeypatch)
    resp = _send(bot_client, text="never mind")
    it = resp.iter_encoded()
    conv_id = _first_frame_conv(it)
    assert bot_client.post(f"/api/observatory/conversation/{conv_id}/stop").status_code == 200
    b"".join(it)
    assert "last_error" not in _wait_not_running(conv_id)


def test_a_spawn_that_never_starts_still_reddens_the_card(bot_client, monkeypatch):
    # Nobody may be reading the 502 — an autostarted spinoff fires its own
    # kickoff — so the failure has to land on the roster, not just in the reply.
    def boom(*a, **k):
        raise OSError("no claude on PATH")
    monkeypatch.setattr(observatory, "_spawn", boom)
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "doomed"}).get_json()["id"]
    assert _send(bot_client, text="go", conversation_id=conv_id).status_code == 502
    meta = store.read("bot_chats/index", {})[conv_id]
    assert "no claude on PATH" in meta["last_error"]


def test_her_next_send_clears_the_red_before_the_turn_runs(bot_client, monkeypatch):
    # Restore the REAL _spawn by hand rather than monkeypatch.undo(): this
    # monkeypatch instance is the same one bot_client used, so undo() would
    # also put back the true CLAUDE_BIN and let the test spawn actual claude.
    real_spawn = observatory._spawn

    def boom(*a, **k):
        raise OSError("no claude on PATH")
    monkeypatch.setattr(observatory, "_spawn", boom)
    conv_id = bot_client.post("/api/observatory/keeper/conversations",
                              json={"title": "doomed"}).get_json()["id"]
    _send(bot_client, text="go", conversation_id=conv_id)
    assert store.read("bot_chats/index", {})[conv_id].get("last_error")
    monkeypatch.setattr(observatory, "_spawn", real_spawn)   # claude works again
    _sse_events(_send(bot_client, text="try again", conversation_id=conv_id))
    assert "last_error" not in _wait_not_running(conv_id)


# --- Terrain (GET /api/observatory/terrain) ---------------------------------
# The file-tree heatmap's data layer: git heat (routes/observatory.py's own
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
    monkeypatch.setattr(observatory, "_terrain_cache", {})
    app = Flask(__name__)
    app.config.update(TESTING=True)
    observatory.register(app)
    return app.test_client()


def _set_terrain_repos(monkeypatch, skeleton_root, vault_root):
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": skeleton_root},
        {"id": "vault", "name": "Personal vault", "root": vault_root},
    ))


def _age_terrain_cache(seconds):
    """Backdate every cache slot — the cache is keyed by file cap now, so
    tests can't reach into a single well-known entry."""
    for slot in observatory._terrain_cache.values():
        slot["computed_at"] -= seconds


def test_terrain_returns_200_with_missing_sidecars(terrain_client, tmp_path, monkeypatch):
    # No footprints.json/gists.json/index.json (data_dir is a fresh tmp_path)
    # and repo roots that aren't even git repos — the git-missing/failing
    # path must degrade to an empty repo entry, never a 500.
    _set_terrain_repos(monkeypatch, tmp_path / "not-a-repo-a", tmp_path / "not-a-repo-b")
    resp = terrain_client.get("/api/observatory/terrain")
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
    data = terrain_client.get("/api/observatory/terrain").get_json()
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

    data = terrain_client.get("/api/observatory/terrain").get_json()
    skel_out = next(r for r in data["repos"] if r["id"] == "skeleton")
    by_path = {f["path"]: f for f in skel_out["files"]}

    # abs path -> repo-relative path, git touches present
    assert by_path["app.py"]["sessions"] == [
        {"id": "conv-1", "title": "Gist Title", "writes": 3, "reads": 1,
         "creates": 0, "last": "2026-01-02T00:00:00Z"},
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
         "running": False, "open": True, "lane": "orchestra", "last": None},
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
    last_at = observatory._now()
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

    data = terrain_client.get("/api/observatory/terrain").get_json()
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
                    "bot": "spark", "running": True, "open": True,
                    "lane": "personal", "last": last_at}


def test_running_session_with_no_touches_still_appears_in_sessions(terrain_client, tmp_path, monkeypatch):
    # A turn that hasn't touched a file yet is still a presence on the map.
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"conv-idle": {
        "title": "Just thinking", "bot": "keeper", "running": True,
        "last_at": observatory._now()}})
    data = terrain_client.get("/api/observatory/terrain").get_json()
    assert [s["id"] for s in data["sessions"]] == ["conv-idle"]
    assert data["sessions"][0]["running"] is True


def test_sessions_report_open_and_lane_for_the_maps_pools(terrain_client, tmp_path, monkeypatch):
    """The map's agent selector is built on these two fields: `open` is the
    Open pool (not archived — a real server-side state, unlike the browser-
    local heartbeat it replaced) and `lane` is the Personal/Orchestra filter,
    derived from cwd for entries that predate the field."""
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {
        "conv-open": {"title": "Still going", "last_at": "2026-01-03T00:00:00"},
        "conv-closed": {"title": "Done with it", "last_at": "2026-01-02T00:00:00",
                        "archived": "2026-01-02T09:00:00"},
        "conv-personal": {"title": "Vault work", "last_at": "2026-01-01T00:00:00",
                          "cwd": str(tmp_path / "somewhere-else")},
    })
    # An archived session only reaches the roster by having a footprint; the
    # open ones get there on being open alone.
    store.write("bot_chats/footprints", {
        "conv-closed": {"files": {str(tmp_path / "a" / "x.py"): {"writes": 1, "reads": 0}}},
    })

    by_id = {s["id"]: s for s in terrain_client.get("/api/observatory/terrain").get_json()["sessions"]}

    assert by_id["conv-open"]["open"] is True
    assert by_id["conv-closed"]["open"] is False
    # No cwd at all can't be placed, so it derives to the gated lane —
    # an unknown must never widen a session's scope by accident.
    assert by_id["conv-open"]["lane"] == "orchestra"
    # A session rooted anywhere but the app checkout is Personal.
    assert by_id["conv-personal"]["lane"] == "personal"


def test_open_session_joins_the_roster_with_no_footprint_and_nothing_running(
    terrain_client, tmp_path, monkeypatch
):
    """The Open pool is defined by this list, so an open session missing from
    it would be under-reported rather than merely undrawn."""
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"conv-quiet": {"title": "Not touched a thing"}})
    data = terrain_client.get("/api/observatory/terrain").get_json()
    assert [s["id"] for s in data["sessions"]] == ["conv-quiet"]
    assert data["sessions"][0]["running"] is False


def test_terrain_caches_the_payload_for_the_ttl(terrain_client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(observatory, "_terrain_git_touches",
                        lambda root, window_days: calls.append(root) or {})
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")

    terrain_client.get("/api/observatory/terrain")
    terrain_client.get("/api/observatory/terrain")
    assert len(calls) == 2   # one _build_terrain() call touches 2 repos

    _age_terrain_cache(observatory._TERRAIN_CACHE_TTL_SEC + 1)
    terrain_client.get("/api/observatory/terrain")
    assert len(calls) == 4   # cache expired -> _build_terrain() ran again


def test_terrain_ttl_shortens_while_a_session_is_running(terrain_client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(observatory, "_terrain_git_touches",
                        lambda root, window_days: calls.append(root) or {})
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {"conv-live": {
        "title": "Live", "bot": "keeper", "running": True,
        "last_at": observatory._now()}})

    terrain_client.get("/api/observatory/terrain")
    assert len(calls) == 2
    # An age the default 300s TTL would call fresh — but with a session
    # running, the live TTL (~5s) has already expired it.
    _age_terrain_cache(observatory._TERRAIN_LIVE_TTL_SEC + 1)
    terrain_client.get("/api/observatory/terrain")
    assert len(calls) == 4
    # Once nothing is running, the same age is fresh again under 300s.
    store.write("bot_chats/index", {"conv-live": {"title": "Live", "running": False}})
    _age_terrain_cache(observatory._TERRAIN_LIVE_TTL_SEC + 1)
    terrain_client.get("/api/observatory/terrain")
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

    data = terrain_client.get("/api/observatory/terrain?limit=5").get_json()
    skel = next(r for r in data["repos"] if r["id"] == "skeleton")
    assert len(skel["files"]) == 5
    assert skel["files_total"] == 12     # the cut never lies about the whole
    assert data["file_cap"] == 5


def test_limit_zero_means_every_file(terrain_client, tmp_path, monkeypatch):
    skeleton = _repo_with_files(tmp_path / "skeleton", 12)
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "empty-vault")

    data = terrain_client.get("/api/observatory/terrain?limit=0").get_json()
    skel = next(r for r in data["repos"] if r["id"] == "skeleton")
    assert len(skel["files"]) == 12 == skel["files_total"]
    assert data["file_cap"] is None


def test_junk_limit_falls_back_to_the_default_instead_of_erroring(terrain_client, tmp_path, monkeypatch):
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    data = terrain_client.get("/api/observatory/terrain?limit=drop%20table").get_json()
    assert data["file_cap"] == observatory._TERRAIN_FILE_CAP


def test_limit_is_bounded_so_one_request_cannot_ask_for_everything(terrain_client, tmp_path, monkeypatch):
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    data = terrain_client.get("/api/observatory/terrain?limit=99999999").get_json()
    assert data["file_cap"] == observatory._TERRAIN_FILE_CAP_MAX


def test_each_limit_gets_its_own_cache_slot(terrain_client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(observatory, "_terrain_git_touches",
                        lambda root, window_days: calls.append(root) or {})
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")

    terrain_client.get("/api/observatory/terrain?limit=100")
    terrain_client.get("/api/observatory/terrain?limit=100")
    assert len(calls) == 2          # second served from the limit=100 slot
    terrain_client.get("/api/observatory/terrain?limit=200")
    assert len(calls) == 4          # a different cut is a different payload


def test_cache_slots_are_bounded(terrain_client, tmp_path, monkeypatch):
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    for limit in range(1, observatory._TERRAIN_CACHE_SLOTS + 5):
        terrain_client.get(f"/api/observatory/terrain?limit={limit}")
    assert len(observatory._terrain_cache) <= observatory._TERRAIN_CACHE_SLOTS


# --- Terrain: the code modal (GET /api/observatory/terrain/file) ------------
# Tap a file node -> its own text, plus a summary lifted from the file's
# leading docblock. This is an HTTP door onto the filesystem, so the scoping
# tests below are the load-bearing ones.

def test_terrain_file_returns_content_and_summary(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    _commit_file(skeleton, "routes/thing.py",
                 '"""What this module is for.\n\nSecond paragraph.\n"""\nX = 1\n')
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    resp = terrain_client.get("/api/observatory/terrain/file?repo=skeleton&path=routes/thing.py")
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
            "/api/observatory/terrain/file", query_string={"repo": "skeleton", "path": bad})
        assert resp.status_code == 404, bad


def test_terrain_file_refuses_a_symlink_pointing_out_of_every_repo(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    (tmp_path / "outside.txt").write_text("secrets")
    (skeleton / "sneaky.txt").symlink_to(tmp_path / "outside.txt")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    resp = terrain_client.get("/api/observatory/terrain/file?repo=skeleton&path=sneaky.txt")
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

    resp = terrain_client.get("/api/observatory/terrain/file?repo=skeleton&path=notes.md")
    assert resp.status_code == 200
    assert "Real content." in resp.get_json()["content"]


def test_terrain_file_refuses_secrets_by_name(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    (skeleton / ".env").write_text("API_KEY=hunter2\n")
    (skeleton / "server.key").write_text("-----BEGIN PRIVATE KEY-----\n")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    for secret in (".env", "server.key"):
        resp = terrain_client.get(
            "/api/observatory/terrain/file", query_string={"repo": "skeleton", "path": secret})
        assert resp.status_code == 404, secret


def test_terrain_file_flags_binary_without_returning_it(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    (skeleton / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x00binary")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    body = terrain_client.get(
        "/api/observatory/terrain/file?repo=skeleton&path=logo.png").get_json()
    assert body["binary"] is True
    assert body["content"] is None


def test_terrain_file_truncates_on_whole_lines(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    monkeypatch.setattr(observatory, "_TERRAIN_FILE_READ_MAX", 50)
    (skeleton / "big.txt").write_text("".join(f"line {i}\n" for i in range(50)))
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    body = terrain_client.get(
        "/api/observatory/terrain/file?repo=skeleton&path=big.txt").get_json()
    assert body["truncated"] is True
    assert body["content"].endswith("\n")     # never a half-line
    assert body["size"] > len(body["content"])


def test_terrain_file_unknown_repo_and_missing_args(terrain_client, tmp_path, monkeypatch):
    _set_terrain_repos(monkeypatch, tmp_path / "a", tmp_path / "b")
    assert terrain_client.get(
        "/api/observatory/terrain/file?repo=nope&path=x.py").status_code == 404
    assert terrain_client.get(
        "/api/observatory/terrain/file?repo=skeleton").status_code == 400


def test_terrain_file_summary_is_none_when_the_file_does_not_say(terrain_client, tmp_path, monkeypatch):
    skeleton = _make_git_repo(tmp_path / "skeleton")
    (skeleton / "bare.py").write_text("X = 1\n")
    _set_terrain_repos(monkeypatch, skeleton, tmp_path / "vault")

    body = terrain_client.get(
        "/api/observatory/terrain/file?repo=skeleton&path=bare.py").get_json()
    assert body["summary"] is None       # no guessing when there's no docblock


# --- Session-first refactor: per-conversation config replaces the bot lookup -

def _index_entry(**over):
    entry = {"bot": "keeper", "started": observatory._now(),
             "last_at": observatory._now(), "claude_session_id": None,
             "cost_usd": 0.0, "title": "Custom", "journal": False,
             "cwd": str(store.CONTENT_DIR.parent)}
    entry.update(over)
    return entry


def test_conv_send_404s_on_unknown_id(bot_client):
    resp = bot_client.post("/api/observatory/conversation/nope/send",
                           json={"text": "x"})
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "not found"}


def test_conv_send_uses_the_entrys_own_tools_and_cwd(bot_client, tmp_path, monkeypatch):
    own_cwd = tmp_path / "own-cwd"
    own_cwd.mkdir()
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["custom-1"] = _index_entry(cwd=str(own_cwd),
                                         allowed_tools=["Read", "Bash"])
    seen = {}
    real_spawn = observatory._spawn
    def spy(config, text, resume_sid, cwd_override=None):
        seen["config"] = config
        seen["cwd_override"] = cwd_override
        return real_spawn(config, text, resume_sid, cwd_override)
    monkeypatch.setattr(observatory, "_spawn", spy)
    _sse_events(bot_client.post("/api/observatory/conversation/custom-1/send",
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
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["pinned-model"] = _index_entry(model="sonnet")
        index["no-model"] = _index_entry()
    _sse_events(bot_client.post("/api/observatory/conversation/pinned-model/send",
                                json={"text": "go"}))
    argv = _last_argv(bot_client)
    assert argv[argv.index("--model") + 1] == "sonnet"

    _sse_events(bot_client.post("/api/observatory/conversation/no-model/send",
                                json={"text": "go"}))
    assert "--model" not in _last_argv(bot_client)


def test_a_junk_model_on_an_entry_is_ignored_rather_than_passed_through(bot_client):
    # Hand-edited/older data could carry anything; _conv_config filters to the
    # known choices so a bad value degrades to the default instead of failing
    # every turn of that session.
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["junk-model"] = _index_entry(model="gpt-9")
    _sse_events(bot_client.post("/api/observatory/conversation/junk-model/send",
                                json={"text": "go"}))
    assert "--model" not in _last_argv(bot_client)


def test_model_can_be_pinned_switched_and_cleared_through_settings(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "workshop"}).get_json()["id"]
    # created without a pick: no field at all
    assert "model" not in store.read("bot_chats/index", {})[conv_id]

    for pick in ("opus[1m]", "haiku"):
        resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                               json={"model": pick})
        assert resp.status_code == 200
        assert store.read("bot_chats/index", {})[conv_id]["model"] == pick

    # '' clears the pin — the field is REMOVED, not blanked, so _conv_config
    # reads it as inherit rather than as a falsy model.
    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                           json={"model": ""})
    assert resp.status_code == 200
    assert "model" not in store.read("bot_chats/index", {})[conv_id]


def test_an_unknown_model_is_rejected_without_persisting_the_rest_of_the_patch(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "workshop"}).get_json()["id"]
    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                           json={"title": "renamed", "model": "gpt-9"})
    assert resp.status_code == 400
    # The whole patch is refused: validation happens before the mutate block,
    # because an early return inside it would still COMMIT the rename.
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["title"] == "workshop"
    assert "model" not in meta


def test_create_can_pin_a_model_and_rejects_an_unknown_one(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "cheap", "model": "haiku"}).get_json()["id"]
    assert store.read("bot_chats/index", {})[conv_id]["model"] == "haiku"
    resp = bot_client.post("/api/observatory/conversations",
                           json={"title": "bad", "model": "gpt-9"})
    assert resp.status_code == 400


def test_roster_publishes_the_model_choices_the_settings_route_accepts(bot_client):
    # One authority: the picker's options come from the server, so the client
    # can't offer something the settings route would 400 on.
    choices = bot_client.get("/api/observatory").get_json()["model_choices"]
    assert choices == observatory._MODEL_CHOICES


def test_legacy_entry_without_allowed_tools_gets_readonly_trio(bot_client, monkeypatch):
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["legacy-1"] = _index_entry()   # no allowed_tools field at all
    seen = {}
    real_spawn = observatory._spawn
    def spy(config, text, resume_sid, cwd_override=None):
        seen["tools"] = config["allowed_tools"]
        return real_spawn(config, text, resume_sid, cwd_override)
    monkeypatch.setattr(observatory, "_spawn", spy)
    _sse_events(bot_client.post("/api/observatory/conversation/legacy-1/send",
                                json={"text": "hi"}))
    assert seen["tools"] == observatory._DEFAULT_ALLOWED_TOOLS


def test_draft_is_cleared_by_a_send(bot_client):
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["draft-1"] = _index_entry(
            allowed_tools=list(observatory._BUILDER_TOOLS),
            draft="Read BRIEF.md and follow its Protocol section exactly.")
    _sse_events(bot_client.post("/api/observatory/conversation/draft-1/send",
                                json={"text": "Read BRIEF.md and follow its Protocol section exactly."}))
    meta = store.read("bot_chats/index", {})["draft-1"]
    assert "draft" not in meta


def test_new_default_create_route_gives_builder_config(bot_client):
    resp = bot_client.post("/api/observatory/conversations",
                           json={"title": "build thing"})
    assert resp.status_code == 200
    conv_id = resp.get_json()["id"]
    meta = store.read("bot_chats/index", {})[conv_id]
    assert meta["allowed_tools"] == list(observatory._BUILDER_TOOLS)
    assert meta["cwd"] == str(store.BUILD_DIR)
    assert meta["bot"] == "keeper"
    assert meta["journal"] is False


def test_roster_returns_sessions_and_legacy_bots_shapes(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "roster check"}).get_json()["id"]
    data = bot_client.get("/api/observatory").get_json()
    assert "sessions" in data and "bots" in data
    assert any(c["id"] == conv_id for c in data["sessions"])
    assert data["bots"][0]["id"] == "keeper"
    assert any(c["id"] == conv_id for c in data["bots"][0]["conversations"])
    assert data["sessions"] == data["bots"][0]["conversations"]


# --- Act-vs-ask approvals: the inline Approve/Deny door (S4) ----------------

def _seed_conv(conv_id="2026-07-27.120000"):
    observatory._chats_dir()   # the index (and its .lock) lives inside it
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = {"started": observatory._now(), "title": "t",
                          "claude_session_id": None}
    return conv_id


def _seed_pending(conv_id, command):
    observatory._write_approvals(conv_id, {"pending": {"tool": "Bash", "command": command}})


def test_pending_approval_rides_the_roster(bot_client):
    cid = _seed_conv()
    _seed_pending(cid, "git push")
    data = bot_client.get("/api/observatory").get_json()
    sess = next(s for s in data["sessions"] if s["id"] == cid)
    assert sess["awaiting_approval"] == {"tool": "Bash", "command": "git push"}


def test_approve_once_records_command_and_clears_pending(bot_client):
    cid = _seed_conv()
    _seed_pending(cid, "git commit -m x")
    resp = bot_client.post(f"/api/observatory/conversation/{cid}/approve", json={"sticky": False})
    assert resp.status_code == 200 and resp.get_json()["command"] == "git commit -m x"
    rec = observatory._read_approvals(cid)
    assert rec["pending"] is None
    assert rec["once"] == ["git commit -m x"] and "always" not in rec
    # and it no longer shows on the roster
    sess = next(s for s in bot_client.get("/api/observatory").get_json()["sessions"] if s["id"] == cid)
    assert "awaiting_approval" not in sess


def test_approve_sticky_goes_to_always(bot_client):
    cid = _seed_conv()
    _seed_pending(cid, "ls /etc")
    bot_client.post(f"/api/observatory/conversation/{cid}/approve", json={"sticky": True})
    rec = observatory._read_approvals(cid)
    assert rec["always"] == ["ls /etc"] and rec.get("once", []) == [] and rec["pending"] is None


def test_deny_clears_without_whitelisting(bot_client):
    cid = _seed_conv()
    _seed_pending(cid, "rm -rf x")
    bot_client.post(f"/api/observatory/conversation/{cid}/deny", json={})
    rec = observatory._read_approvals(cid)
    assert rec["pending"] is None
    assert rec.get("once", []) == [] and rec.get("always", []) == []


def test_approve_with_nothing_pending_404s(bot_client):
    cid = _seed_conv()
    assert bot_client.post(f"/api/observatory/conversation/{cid}/approve", json={}).status_code == 404


def test_resolve_approval_rejects_a_bad_conversation_id():
    _payload, status = observatory.resolve_approval("../evil", "approve", False)
    assert status == 400


def test_a_hand_reply_dismisses_an_unresolved_card(bot_client):
    cid = _seed_conv()
    _seed_pending(cid, "git push")
    resp = bot_client.post(f"/api/observatory/conversation/{cid}/send", json={"text": "never mind"})
    assert resp.status_code == 200
    assert observatory._read_approvals(cid).get("pending") is None


# --- lanes: the Observatory's three rooms (07-27, split 08-03) --------------
# A session BELONGS to a lane now instead of being filtered into one. The lane
# does NOT gate tools (all three carry the full builder kit) — it decides WHERE
# the session stands and whether it stops and asks. Personal and Coding differ
# by ground, Coding and Orchestra by gate; cwd can never change later.


def test_create_defaults_to_the_orchestra_lane(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "builder"}).get_json()["id"]
    entry = store.read("bot_chats/index", {})[conv_id]
    assert entry["lane"] == "orchestra"
    assert entry["cwd"] == str(store.BUILD_DIR)
    # The lane DRIVES the safety nets rather than freezing them: leaving these
    # unwritten is what lets a later lane move actually re-scope the session.
    assert "act_gate" not in entry and "guard_docs" not in entry
    assert observatory._conv_config(entry)["act_gate"] is True


def test_personal_lane_roots_at_the_shared_parent_and_does_not_ask(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "talking", "lane": "personal"}).get_json()["id"]
    entry = store.read("bot_chats/index", {})[conv_id]
    assert entry["lane"] == "personal"
    # The one place a session sees both repos as peers — derived from the two
    # roots, never hardcoded, so it travels to a differently-laid-out install.
    assert entry["cwd"] == observatory._root_dir()
    config = observatory._conv_config(entry)
    assert config["act_gate"] is False and config["guard_docs"] is False
    # Same toolkit as Orchestra: the lane gates asking, not ability.
    assert entry["allowed_tools"] == list(observatory._BUILDER_TOOLS)


def test_coding_lane_stands_in_the_app_checkout_and_does_not_ask(bot_client):
    # The whole reason Coding is its own room rather than a label on Personal:
    # it shares Personal's "she's watching, so just act" but NOT its ground. A
    # build session rooted at the shared parent can wander into the vault and
    # leave app code there, which the root CLAUDE.md calls a bug outright.
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "building", "lane": "coding"}).get_json()["id"]
    entry = store.read("bot_chats/index", {})[conv_id]
    assert entry["lane"] == "coding"
    assert entry["cwd"] == str(store.BUILD_DIR)          # Orchestra's ground…
    config = observatory._conv_config(entry)
    assert config["act_gate"] is False and config["guard_docs"] is False  # …Personal's gates
    # Unwritten, like every lane: that's what lets a later move re-scope it.
    assert "act_gate" not in entry and "guard_docs" not in entry
    assert entry["allowed_tools"] == list(observatory._BUILDER_TOOLS)


def test_nothing_derives_into_coding(bot_client):
    # Coding and Orchestra stand on the same ground, so a cwd cannot tell them
    # apart — and guessing Coding would hand an unwatched session ungated
    # autonomy. A session only lands there because she put it there.
    assert observatory._conv_lane({"cwd": str(store.BUILD_DIR)}) == "orchestra"
    assert observatory._conv_lane({"cwd": str(store.BUILD_DIR),
                                   "lane": "coding"}) == "coding"


# --- searching the archive (08-03) -----------------------------------------
# "a way to see past sessions and the contents of them ... search inside of it".
# One walk over the transcripts; no index to drift from the record.


def _seed_speech(conv_id, lines, **meta):
    """A conversation with a real jsonl behind it. `lines` is (who, text) —
    'B' becomes her typed user event, 'K' an assistant message. (Distinct from
    the preview tests' _seed_transcript above, which writes raw events.)"""
    chats = store.DATA_DIR / "bot_chats"
    chats.mkdir(parents=True, exist_ok=True)
    with open(chats / f"{conv_id}.jsonl", "w", encoding="utf-8") as fh:
        for who, text in lines:
            if who == "B":
                fh.write(json.dumps({"type": "user", "text": text}) + "\n")
            else:
                fh.write(json.dumps({"type": "assistant", "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": text}]}}) + "\n")
    with store.mutate("bot_chats/index", {}) as index:
        index[conv_id] = dict({"title": conv_id, "last_at": "2026-08-01T00:00:00"}, **meta)


def test_search_finds_words_in_a_transcript_with_a_snippet(bot_client):
    _seed_speech("conv-a", [("B", "what should I do about the balcony door"),
                                ("K", "Seal it before winter.")])
    data = bot_client.get("/api/observatory/search?q=balcony").get_json()
    hit = data["results"][0]["hits"][0]
    assert data["results"][0]["id"] == "conv-a"
    assert hit["who"] == "B"
    # The client marks the words using the offset rather than re-finding the
    # query in trimmed, ellipsised text — so the offset has to be right.
    assert hit["text"][hit["at"]:hit["at"] + hit["len"]].lower() == "balcony"


def test_search_ignores_tool_machinery_and_only_reads_speech(bot_client):
    # A user event carrying `message` is claude echoing a tool result to
    # itself. Matching it would bury the one moment she actually meant under
    # every file the agent happened to touch.
    chats = store.DATA_DIR / "bot_chats"
    chats.mkdir(parents=True, exist_ok=True)
    (chats / "conv-tool.jsonl").write_text(json.dumps({
        "type": "user", "message": {"role": "user", "content": [
            {"type": "text", "text": "balcony.py"}]}}) + "\n")
    with store.mutate("bot_chats/index", {}) as index:
        index["conv-tool"] = {"title": "tooling", "last_at": "2026-08-01T00:00:00"}
    assert bot_client.get("/api/observatory/search?q=balcony").get_json()["results"] == []


def test_search_covers_archived_and_journalled_sessions(bot_client):
    # The archive's whole job is the sessions the roster hides, and the Keeper
    # (journalled) is where most of what she'd go looking for was said.
    _seed_speech("conv-old", [("B", "the mattress arrives thursday")],
                     archived="2026-07-01T00:00:00")
    _seed_speech("conv-diary", [("B", "the mattress finally came")], journal=True)
    found = {r["id"]: r for r in
             bot_client.get("/api/observatory/search?q=mattress").get_json()["results"]}
    assert set(found) == {"conv-old", "conv-diary"}
    # Flagged, not withheld — the client marks a diary hit so she's never
    # surprised which surface a line came off.
    assert found["conv-diary"]["journal"] is True
    assert found["conv-old"]["archived"] is True


def test_search_matches_a_session_by_name_alone(bot_client):
    # "the housing one" is a real way to look for a conversation, and it may
    # never say the word inside.
    _seed_speech("conv-h", [("B", "ok")], title="housing search")
    result = bot_client.get("/api/observatory/search?q=housing").get_json()["results"][0]
    assert result["title_hit"] is True and result["hits"] == []


def test_search_needs_more_than_one_character(bot_client):
    _seed_speech("conv-a", [("B", "anything at all")])
    data = bot_client.get("/api/observatory/search?q=a").get_json()
    assert data["results"] == [] and data["scanned"] == 0


def test_root_dir_is_the_parent_the_two_repos_share(tmp_path, monkeypatch):
    # The live layout: skeleton/ and personal/ side by side under one parent.
    root = tmp_path / "exocortex"
    (root / "skeleton").mkdir(parents=True)
    (root / "personal" / "tulku").mkdir(parents=True)
    monkeypatch.setattr(store, "BUILD_DIR", root / "skeleton")
    monkeypatch.setattr(store, "CONTENT_DIR", root / "personal" / "tulku")
    assert observatory._root_dir() == str(root)


def test_root_dir_refuses_to_root_a_session_at_the_filesystem_root(tmp_path, monkeypatch):
    # Repos that share nothing but '/' (an install with them far apart — and
    # what the test suite's own tmp vault looks like). Rooting a full-toolkit
    # session at '/' would be absurd, so it falls back to the vault.
    vault = tmp_path / "somewhere" / "vault"
    (vault / "tulku").mkdir(parents=True)
    monkeypatch.setattr(store, "BUILD_DIR", "/opt/elsewhere/skeleton")
    monkeypatch.setattr(store, "CONTENT_DIR", vault / "tulku")
    assert observatory._root_dir() == str(vault)


def test_create_rejects_an_unknown_lane(bot_client):
    resp = bot_client.post("/api/observatory/conversations",
                           json={"title": "nope", "lane": "basement"})
    assert resp.status_code == 400


def test_lane_derives_from_cwd_for_sessions_that_predate_it():
    # Nothing was migrated, so every pre-lane entry places itself: the builder
    # ones were born in the checkout, the ~20 legacy Keeper ones in the vault.
    assert observatory._conv_lane({"cwd": str(store.BUILD_DIR)}) == "orchestra"
    assert observatory._conv_lane({"cwd": str(store.CONTENT_DIR.parent)}) == "personal"


def test_an_unplaceable_session_derives_to_the_GATED_lane():
    # Fail toward ask. The lane carries act_gate now, so guessing "personal"
    # for an entry we can't place would silently WIDEN its autonomy — a wrong
    # guess must cost a tap, not a mistake.
    assert observatory._conv_lane({}) == "orchestra"
    assert observatory._conv_lane({"cwd": "\0not-a-path"}) == "orchestra"
    assert observatory._conv_config({})["act_gate"] is True


def test_moving_lanes_rescopes_the_gate_but_never_moves_the_session(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "mover"}).get_json()["id"]
    born_in = store.read("bot_chats/index", {})[conv_id]["cwd"]

    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                           json={"lane": "personal"})
    assert resp.status_code == 200
    entry = store.read("bot_chats/index", {})[conv_id]
    assert entry["lane"] == "personal"
    assert observatory._conv_config(entry)["act_gate"] is False
    # cwd is fixed at birth: Claude Code stores conversations per directory, so
    # a session that changed ground could never be --resume'd again.
    assert entry["cwd"] == born_in


def test_settings_rejects_an_unknown_lane(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "mover"}).get_json()["id"]
    resp = bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                           json={"lane": "attic"})
    assert resp.status_code == 400
    assert store.read("bot_chats/index", {})[conv_id]["lane"] == "orchestra"


def test_act_gate_override_outranks_the_room_until_she_clears_it(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "pinned gate", "lane": "personal"}).get_json()["id"]
    # She deliberately asks a Personal session to stop and ask anyway.
    bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                    json={"act_gate": True})
    entry = store.read("bot_chats/index", {})[conv_id]
    assert observatory._conv_config(entry)["act_gate"] is True

    # An explicit choice outranks the room, even after moving rooms...
    bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                    json={"lane": "orchestra"})
    assert observatory._conv_config(store.read("bot_chats/index", {})[conv_id])["act_gate"] is True

    # ...until she hands it back to the lane with an explicit null. That's the
    # difference between a value she chose and one it merely inherited.
    bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                    json={"act_gate": None})
    entry = store.read("bot_chats/index", {})[conv_id]
    assert "act_gate" not in entry
    assert observatory._conv_config(entry)["act_gate"] is True   # now follows orchestra


def _session(client, conv_id):
    sessions = client.get("/api/observatory").get_json()["sessions"]
    return next(s for s in sessions if s["id"] == conv_id)


def test_the_roster_separates_the_resolved_gate_from_her_pin(bot_client):
    """`act_gate` = what the next turn will DO; `act_gate_set` = what she PINNED
    (absent when the room is driving it). One field can't be both: the ✎ dialog
    reads the pin back to seed its picker, so a resolved value arriving under
    that name is indistinguishable from a choice she made."""
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "unpinned"}).get_json()["id"]
    card = _session(bot_client, conv_id)
    assert card["act_gate"] is True          # Orchestra asks...
    assert "act_gate_set" not in card        # ...but she never said so.

    bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                    json={"act_gate": False})
    card = _session(bot_client, conv_id)
    assert card["act_gate"] is False and card["act_gate_set"] is False


def test_settings_response_carries_her_pin_beside_the_resolved_gate(bot_client):
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "mover"}).get_json()["id"]
    conv = bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                           json={"lane": "personal"}).get_json()["conversation"]
    assert conv["act_gate"] is False
    assert "act_gate_set" not in conv


def test_moving_rooms_without_touching_the_picker_does_not_pin_the_gate(bot_client):
    """The ✎ round-trip that kept every lock: she opens an Orchestra session,
    changes only Room → Personal, saves. The dialog always sends `act_gate`, so
    whatever it seeded from comes back — and if that was the RESOLVED true, the
    save pins the gate and the new room can never turn it off. Reading the pin
    (absent → null) keeps the move a move."""
    conv_id = bot_client.post("/api/observatory/conversations",
                              json={"title": "mover"}).get_json()["id"]
    card = _session(bot_client, conv_id)

    # Exactly what RosterPage.onEdit posts, seeded the way the dialog seeds it.
    bot_client.post(f"/api/observatory/conversation/{conv_id}/settings",
                    json={"title": card["title"], "journal": False, "model": "",
                          "lane": "personal",
                          "act_gate": card.get("act_gate_set")})

    entry = store.read("bot_chats/index", {})[conv_id]
    assert entry["lane"] == "personal"
    assert "act_gate" not in entry
    assert observatory._conv_config(entry)["act_gate"] is False
    assert observatory._session_settings(observatory._conv_config(entry),
                                         observatory._BUILDER_TOOLS) == {}


def test_roster_resolves_lane_and_gate_for_every_card(bot_client):
    bot_client.post("/api/observatory/conversations", json={"title": "a"})
    bot_client.post("/api/observatory/conversations",
                    json={"title": "b", "lane": "personal"})
    sessions = bot_client.get("/api/observatory").get_json()["sessions"]
    # Never raw: the client splits the page on these, so a card with no stored
    # lane must still arrive carrying a resolved one.
    assert all(c["lane"] in ("orchestra", "personal") for c in sessions)
    assert all(isinstance(c["act_gate"], bool) for c in sessions)
    by_title = {c["title"]: c for c in sessions}
    assert by_title["a"]["lane"] == "orchestra" and by_title["a"]["act_gate"] is True
    assert by_title["b"]["lane"] == "personal" and by_title["b"]["act_gate"] is False


# --- session token totals -------------------------------------------------
# Summed from the transcript's per-turn `result` records and cached by byte
# offset, so a roster poll re-reads only what was appended since the last one.

def _log_turn(conv_id, output_tokens, cost):
    """Append one finished turn's result record to a conversation's log."""
    path = observatory._chats_dir() / f"{conv_id}.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"type": "assistant", "message": {"role": "assistant"}}) + "\n")
        f.write(json.dumps({"type": "result", "subtype": "success",
                            "usage": {"output_tokens": output_tokens,
                                      "cache_read_input_tokens": 400_000},
                            "total_cost_usd": cost}) + "\n")


def test_session_tokens_sum_output_across_turns_not_cache_reads(bot_client):
    observatory._chats_dir()
    observatory._TOKEN_TOTALS.clear()
    with store.mutate("bot_chats/index", {}) as index:
        index["tok-1"] = _index_entry(title="Counter")
    _log_turn("tok-1", 300, 0.25)
    _log_turn("tok-1", 200, 0.15)
    # Output only — the 800k of cache reads must not inflate the number she
    # reads as "what this agent wrote".
    assert observatory._session_tokens("tok-1") == {"output": 500, "cost_usd": 0.4}


def test_session_tokens_count_appended_turns_once(bot_client):
    observatory._chats_dir()
    observatory._TOKEN_TOTALS.clear()
    with store.mutate("bot_chats/index", {}) as index:
        index["tok-2"] = _index_entry(title="Counter")
    _log_turn("tok-2", 100, 0.1)
    assert observatory._session_tokens("tok-2")["output"] == 100
    # Re-reading without new bytes must not double-count the same records...
    assert observatory._session_tokens("tok-2")["output"] == 100
    # ...and a new turn adds only itself.
    _log_turn("tok-2", 50, 0.05)
    assert observatory._session_tokens("tok-2")["output"] == 150


def test_session_tokens_ignore_a_half_written_final_line(bot_client):
    observatory._chats_dir()
    observatory._TOKEN_TOTALS.clear()
    with store.mutate("bot_chats/index", {}) as index:
        index["tok-3"] = _index_entry(title="Counter")
    _log_turn("tok-3", 100, 0.1)
    # A turn appending right now leaves a torn line with no trailing newline.
    path = observatory._chats_dir() / "tok-3.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        f.write('{"type": "result", "usage": {"output_tok')
    assert observatory._session_tokens("tok-3")["output"] == 100
    # Once the line completes it counts exactly once.
    with open(path, "a", encoding="utf-8") as f:
        f.write('ens": 70}, "total_cost_usd": 0.07}\n')
    assert observatory._session_tokens("tok-3")["output"] == 170


def test_roster_and_conversation_both_carry_the_token_total(bot_client):
    observatory._chats_dir()
    observatory._TOKEN_TOTALS.clear()
    with store.mutate("bot_chats/index", {}) as index:
        index["tok-4"] = _index_entry(title="Counter")
    _log_turn("tok-4", 420, 0.3)
    card = next(c for c in bot_client.get("/api/observatory").get_json()["sessions"]
                if c["id"] == "tok-4")
    assert card["tokens"]["output"] == 420
    meta = bot_client.get("/api/observatory/conversation/tok-4").get_json()["meta"]
    assert meta["tokens"]["output"] == 420


def test_a_session_with_no_finished_turn_reports_no_total(bot_client):
    observatory._chats_dir()
    observatory._TOKEN_TOTALS.clear()
    with store.mutate("bot_chats/index", {}) as index:
        index["tok-5"] = _index_entry(title="Fresh")
    # No jsonl at all yet (a staged /spinoff draft) — absent, not a zero, so
    # the card can simply say nothing rather than claim "0 tokens".
    assert observatory._session_tokens("tok-5") is None


# --- front-tagged session creation ---------------------------------------------

def _fronts_vocab():
    import store
    store.write("fronts.json", {"fronts": [{"id": "living-space", "name": "Living space"}]})


def test_create_tags_the_session_with_its_front(bot_client):
    """A session started from a front's room is filed to that front EXPLICITLY —
    the field lands on the index entry, which is what outranks whatever
    scripts/sort_bot_chats.py would later infer."""
    import store
    _fronts_vocab()
    r = bot_client.post("/api/observatory/conversations",
                    json={"title": "Shelving", "front": "living-space"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["front"] == "living-space"

    entry = store.read("bot_chats/index", {})[body["id"]]
    assert entry["front"] == "living-space"


def test_create_seeds_the_session_with_the_front_brief(bot_client):
    """Seeding points system_prompt_file at the front's brief, which
    observatory feeds to --append-system-prompt at spawn — so the conversation
    opens already knowing which part of her life it's in."""
    import store
    from pathlib import Path
    _fronts_vocab()
    store.write("todos", {"now": {"items": [
        {"id": "t1", "text": "Get shelving", "done": False, "fronts": ["living-space"]},
    ]}})

    body = bot_client.post("/api/observatory/conversations",
                       json={"title": "Shelving", "front": "living-space"}).get_json()
    assert body["seeded"] is True

    entry = store.read("bot_chats/index", {})[body["id"]]
    text = Path(entry["system_prompt_file"]).read_text()
    assert "Living space" in text
    assert "Get shelving" in text


def test_create_can_tag_without_seeding(bot_client):
    import store
    _fronts_vocab()
    body = bot_client.post("/api/observatory/conversations",
                       json={"front": "living-space", "seed": False}).get_json()
    assert body["seeded"] is False
    entry = store.read("bot_chats/index", {})[body["id"]]
    assert entry["front"] == "living-space"
    assert "system_prompt_file" not in entry


def test_create_rejects_an_unknown_front(bot_client):
    _fronts_vocab()
    r = bot_client.post("/api/observatory/conversations", json={"front": "not-a-front"})
    assert r.status_code == 400


def test_create_without_a_front_writes_no_front_fields(bot_client):
    """A bare create must leave both fields absent — system_prompt_file belongs
    to persona sessions and a front seed must never squat on it."""
    import store
    _fronts_vocab()
    body = bot_client.post("/api/observatory/conversations", json={"title": "Plain"}).get_json()
    entry = store.read("bot_chats/index", {})[body["id"]]
    assert "front" not in entry
    assert "system_prompt_file" not in entry
