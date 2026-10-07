"""A helper's chat (helper_chat.py) and the swarm helper's closing check
(swarm_helper.close_out), with every model call faked.

What these pin, the way the chat is really used: a helper's turn never
resumes and starts from a seed that is exactly a doc, her last 15 messages
with the helper's replies (whole, and only the turns she started), and one
entry per active session with its own summary, edited files and read files —
helpers never listed, no retelling of the chat, and no model call when a
turn ends. Her standing rules are a file the helper adds to through
scripts/helper_rule.py and she can edit by hand. The helper is woken when a
session is new or its files changed — once, not for a handoff, not inside
the gap — and a wake-up it answers with silence leaves its card as it was.
The helper chat is never continued, however big its context; a handed-off
helper comes back as the one chat; a swarm is "retired" once fewer than two
members are still working; and a retired swarm gets one closing summary —
written by its helper's model, once — above the closing check that names
what git says shipped and what's left, after which the helper marks itself
done. That summary is kept: the helper is handed it on every later turn, by
either door she can ask through, with every member's id long after they
drop out of its view; the room's helper is told in a line; a swarm that
closes again keeps the earlier summary; and a summary that can't be written
never stops the closing or costs a second call.
"""
import importlib.util
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import config
import continuation
import helper_chat
import peermail
import room_helper
import sqlstore
import store
import swarm_helper
import swarms
import toolcallstore
from routes import observatory

A, B = "2026-09-27.100000", "2026-09-27.110000"
C, D = "2026-09-27.120000", "2026-09-27.130000"


def _seed(*conv_ids, **fields):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        for cid in conv_ids:
            index[cid] = {"title": f"title {cid}", "lane": "coding", **fields}


def _log(conv_id, *lines):
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


def _reply(text, msg_id="msg_1"):
    return {"type": "assistant", "message": {"id": msg_id, "role": "assistant",
                                             "content": [{"type": "text", "text": text}]}}


def _entry(conv_id):
    return store.read("bot_chats/index", {}).get(conv_id)


def _did(conv, *tool_uses):
    """One turn's tool calls, folded into tool_calls the way a running turn does it."""
    stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    path = store.DATA_DIR / "bot_chats" / f"{conv}.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        for name, inp in tool_uses:
            f.write(json.dumps({"type": "assistant", "timestamp": stamp, "message": {
                "content": [{"type": "tool_use", "id": f"toolu_{conv}_{f.tell()}",
                             "name": name, "input": inp}]}}) + "\n")
    toolcallstore.live_ingest(path, conv)


def _edit(path):
    return "Edit", {"file_path": str(path), "old_string": "1", "new_string": "2"}


def _read(path):
    return "Read", {"file_path": str(path)}


def _summary(conv, text, at):
    """A summary a summarizer call wrote for a session working alone."""
    conn = sqlstore.open_db()
    try:
        conn.execute("INSERT OR REPLACE INTO session_summaries (conv, summary, summary_at)"
                     " VALUES (?, ?, ?)", (conv, text, at))
        conn.commit()
    finally:
        conn.close()


def _part(seed, conv):
    """One session's entry in part 3 of a seed."""
    sessions = seed.split("# 3. The active sessions")[1]
    return sessions.split(f"## `{conv}`")[1].split("\n## `")[0]


@pytest.fixture
def helper(data_dir, monkeypatch):
    """A two-member swarm and its helper chat, with no detached processes:
    a closing runs where it's started, and its model call is faked (each
    call's input is kept in swarm_helper.closing_calls)."""
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    monkeypatch.setattr(swarm_helper, "_detach",
                        lambda swarm_id, args: swarm_helper.main(["swarm_helper.py", *args]))
    calls = []
    monkeypatch.setattr(swarm_helper, "closing_calls", calls, raising=False)
    monkeypatch.setattr(swarm_helper, "_call_closing", lambda text: calls.append(text) or (
        {"headline": f"Closing {len(calls)} headline.",
         "summary": f"Closing {len(calls)}: the pond page was built."}, 0.02))
    _seed(A, B)
    peermail.send(B, "I'm editing pond.py too", from_conv=A)
    [swarm_id] = swarms.sync()
    return swarm_helper.ensure_helper(swarm_id)


@pytest.fixture
def room(data_dir, monkeypatch, tmp_path):
    """The coding room's helper chat, with turns started but never run, and
    the app checkout stood in for by an empty folder. Returns (helper id,
    the turns started, that folder)."""
    started = []
    monkeypatch.setattr(room_helper, "_spawn", lambda *a, **k: True)
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    monkeypatch.setattr(observatory, "_mem_available_mb", lambda: None)
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, resume_sid, conv_id, log_path:
                        started.append((conv_id, text)) or True)
    repo = tmp_path / "checkout"
    repo.mkdir()
    monkeypatch.setattr(helper_chat, "_REPO", repo)
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    return room_helper.ensure_room_helper("coding"), started, repo


def _turn_ends(conv, *said):
    """The turn started in this chat ends, having said these things."""
    _log(conv, *[_reply(text, f"msg_{n}_{len(text)}") for n, text in enumerate(said)])
    with store.mutate("bot_chats/index", {}) as index:
        index[conv]["running"] = False
    observatory.after_turn(conv)


# --- The rolling seed -------------------------------------------------------------

def test_the_seed_replays_her_last_fifteen_messages_whole_with_the_replies(helper):
    long_message = "pond " * 3000                              # 15,000 characters
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["helper_notes"] = "an old retelling of the chat"
    for n in range(1, 18):
        _log(helper, {"type": "user", "text": f"question {n:02d}" if n != 9 else long_message,
                      "ts": f"2026-09-27T12:{n:02d}:00"},
             _reply(f"answer {n:02d}", f"msg_{n}"))
        # Between hers: a watch fires and an agent writes — turns she didn't start.
        _log(helper, {"type": "reminder", "text": f"watch fired {n:02d}", "source": "helper-watch"},
             _reply(f"told her about watch {n:02d}", f"msg_w{n}"),
             {"type": "peer", "direction": "in", "from_conv": A, "text": f"agent mail {n:02d}"},
             _reply(f"answered the agent {n:02d}", f"msg_a{n}"))
    seed = helper_chat.seed_text(helper, _entry(helper))
    replayed = seed.split("# 2. Her last 15 messages to you")[1].split("# 3. The active")[0]

    assert replayed.count("**She said:**") == 15 and replayed.count("**You replied:**") == 15
    assert all(f"question {n:02d}" in replayed for n in range(3, 18) if n != 9)
    assert all(f"answer {n:02d}" in replayed for n in range(3, 18))
    assert "question 02" not in seed and "answer 02" not in seed    # rolled off
    assert long_message.strip() in replayed                          # whole, not cut
    # Turns she didn't start use up none of the fifteen and aren't replayed.
    assert "watch fired" not in seed and "told her about watch" not in seed
    assert "agent mail" not in seed and "answered the agent" not in seed
    # Nothing retells the chat, and it's told where the rest is.
    assert "an old retelling" not in seed and "chat summary" not in seed.lower()
    assert f"{helper}.jsonl" in seed and "exactly three things" in seed


def test_each_active_session_is_listed_with_its_own_summary_and_files(room):
    helper, _, repo = room
    _seed(A, B, C, last_at="2026-09-27T12:00:00")
    _seed(D, done_at="2026-09-27T12:00:00")                    # finished: not active
    _summary(A, "Builds the pond page.", "2026-09-27T12:00:00")
    _summary(B, "Refactors the garden.", "2026-09-27T12:00:00")
    _did(A, _edit(repo / "pond.py"), _edit(repo / "shared.py"), _read(repo / "docs" / "pond.md"))
    _did(B, _edit(repo / "garden.py"), _edit(repo / "shared.py"), _read(repo / "pond.py"))
    _did(D, _edit(repo / "old.py"))
    _did(helper, _read(repo / "pond.py"))

    seed = helper_chat.seed_text(helper, _entry(helper))
    a, b, c = _part(seed, A), _part(seed, B), _part(seed, C)
    edited = lambda part: part.split("Edited")[1].split("Read")[0]
    was_read = lambda part: part.split("Read")[1]

    assert "Builds the pond page." in a and "Refactors the garden." in b
    assert "pond.py" in edited(a) and "garden.py" not in a
    assert "pond.md" in was_read(a) and "pond.md" not in b
    assert "garden.py" in edited(b) and "pond.py" in was_read(b) and "pond.py" not in edited(b)
    # The file both changed says so on each of them.
    assert f"shared.py" in edited(a) and f"[also edited by `{B}`]" in edited(a)
    assert f"[also edited by `{A}`]" in edited(b)
    # A session nothing was written about or caught for still has its entry.
    assert "(none written yet)" in c and "(nothing caught)" in c
    # A finished session and the helper itself are not entries.
    sessions = seed.split("# 3. The active sessions")[1]
    assert f"## `{D}`" not in sessions and f"## `{helper}`" not in sessions
    assert "old.py" not in sessions


def test_a_swarm_helper_is_shown_its_members_and_nobody_elses(helper):
    _seed(C)                                                   # in the room, not the swarm
    with store.mutate("bot_chats/index", {}) as index:
        index[B]["done_at"] = "2026-09-27T12:00:00"            # a member that finished
    conn = sqlstore.open_db()
    try:
        conn.execute("UPDATE swarm_members SET summary = 'Edits the pond.', summary_at ="
                     " '2026-09-27T12:00:00' WHERE conv = ?", (A,))
        conn.commit()
    finally:
        conn.close()
    seed = helper_chat.seed_text(helper, _entry(helper))
    sessions = seed.split("# 3. The active sessions")[1]
    assert "Edits the pond." in _part(seed, A)
    assert f"## `{C}`" not in sessions and f"## `{B}`" not in sessions
    assert f"finished and not listed: `{B}`" in sessions


def test_a_helper_chat_turn_never_resumes_and_starts_from_the_seed(helper, monkeypatch):
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["claude_session_id"] = "old-session"
    _log(helper, {"type": "user", "text": "earlier question"}, _reply("earlier answer"))
    started = []
    monkeypatch.setattr(observatory, "_mem_available_mb", lambda: None)
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, resume_sid, conv_id, log_path:
                        started.append((config, text, resume_sid)) or True)
    assert observatory.begin_turn(helper, "new question")["ok"]
    [(turn_config, text, resume_sid)] = started
    assert resume_sid is None and text.startswith("new question")
    seed = open(turn_config["system_prompt_file"], encoding="utf-8").read()
    assert "earlier question" in seed and "earlier answer" in seed
    assert "new question" not in seed


def test_an_unprompted_summarizer_update_is_not_an_exchange(helper):
    _log(helper, {"type": "assistant", "helper_run": True, "helper_update": True,
                  "message": {"role": "assistant",
                              "content": [{"type": "text", "text": "swarm update"}]}},
         {"type": "user", "text": "what's happening?"},
         {"type": "assistant", "helper_run": True, "helper_update": False,
          "message": {"role": "assistant",
                      "content": [{"type": "text", "text": "two agents on the pond"}]}})
    assert helper_chat.exchanges(helper) == [
        {"in": [("owner", "what's happening?")], "out": ["two agents on the pond"], "at": ""}]


def test_when_a_helper_turn_ends_no_model_is_called_and_no_handoff_is_asked(helper, monkeypatch):
    _log(helper, {"type": "user", "text": "use sqlite, not json"}, _reply("will do"))
    monkeypatch.setattr(swarm_helper, "ask_model",
                        lambda *a, **k: pytest.fail("a model was called after a helper's turn"))
    monkeypatch.setattr(continuation, "check",
                        lambda conv: pytest.fail("the helper chat was checked for a handoff"))
    observatory.after_turn(helper)


# --- Her standing rules -----------------------------------------------------------

def _helper_rule(conv, monkeypatch, *argv):
    """Run scripts/helper_rule.py the way a session with this id would."""
    spec = importlib.util.spec_from_file_location(
        "helper_rule", Path(helper_chat.__file__).parent / "scripts" / "helper_rule.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setenv("EXOCORTEX_CONV_ID", conv)
    monkeypatch.setenv("EXOCORTEX_DATA_DIR", str(store.DATA_DIR))
    spec.loader.exec_module(module)
    return module.main(list(argv))


def test_her_standing_rules_are_kept_in_her_words_in_a_file_she_can_edit(helper, monkeypatch):
    assert "(none yet)" in helper_chat.seed_text(helper, _entry(helper))   # starts empty
    assert _helper_rule(helper, monkeypatch, "add", "never move a session I saved") == 0
    assert _helper_rule(helper, monkeypatch, "add", "tell me before you split a swarm") == 0
    # She opens the file and writes one herself.
    path = helper_chat.rules_path(_entry(helper))
    path.write_text(path.read_text() + "- keep replies short\n")
    assert _helper_rule(helper, monkeypatch, "drop", "2") == 0

    seed = helper_chat.seed_text(helper, _entry(helper))
    rules = seed.split("# Her standing rules")[1].split("# Your open watches")[0]
    today = datetime.now().date().isoformat()
    assert f'1. {today}: "never move a session I saved"' in rules
    assert "2. keep replies short" in rules and "split a swarm" not in rules
    # Only a helper has rules: an ordinary session is refused.
    assert _helper_rule(A, monkeypatch, "add", "let me through") == 1
    assert "let me through" not in path.read_text()


# --- The wake-up ------------------------------------------------------------------

def _woken(started):
    """How many turns have been started, and what the last one was told."""
    return len(started), (started[-1][1] if started else "")


def _gap_passes(helper):
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["helper_wake_at"] = (
            datetime.now() - timedelta(seconds=config.HELPER_WAKE_MIN_SEC + 1)
        ).isoformat(timespec="seconds")


def test_the_helper_is_woken_once_when_a_session_is_new_or_its_files_change(room):
    helper, started, repo = room
    _seed(A, last_at="2026-09-27T12:00:00")
    _summary(A, "Builds the pond page.", "2026-09-27T12:00:00")
    assert helper_chat.wake_tick() == 0                        # its first look: nothing to compare
    assert helper_chat.wake_tick() == 0                        # and nothing has changed

    # A new session opens. Until something is written about it, there's nothing to say.
    _seed(B, last_at="2026-09-27T12:05:00")
    _did(B, _edit(repo / "pond.py"))
    assert helper_chat.wake_tick() == 0
    _summary(B, "Also in the pond page.", "2026-09-27T12:06:00")
    assert helper_chat.wake_tick() == 1
    count, told = _woken(started)
    assert count == 1 and f"`{B}`" in told and "is new" in told and A not in told
    # The turn it was woken into was handed the new session, summary and files.
    seed = (store.DATA_DIR / "bot_chats" / "helper_seed" / f"{helper}.md").read_text()
    assert "Also in the pond page." in _part(seed, B) and "pond.py" in _part(seed, B)
    _turn_ends(helper, helper_chat.SILENT)
    assert helper_chat.wake_tick() == 0                        # told once, not every minute

    # More changes inside the gap wait, and arrive together when it has passed.
    _did(A, _edit(repo / "garden.py"))
    _summary(A, "Now on the garden too.", "2026-09-27T12:10:00")
    assert helper_chat.wake_tick() == 0
    _did(B, _edit(repo / "notes.py"))
    _summary(B, "Editing the notes.", "2026-09-27T12:11:00")
    _gap_passes(helper)
    assert helper_chat.wake_tick() == 1
    count, told = _woken(started)
    assert count == 2 and "garden.py" in told and "notes.py" in told
    _turn_ends(helper, helper_chat.SILENT)

    # A new summary is not a change when no file is newly edited: not a file
    # it only read, not one it had edited before.
    _did(A, _read(repo / "docs.md"), ("Write", {"file_path": str(repo / "garden.py"),
                                                "content": "x = 3"}))
    _summary(A, "Still on the garden.", "2026-09-27T12:20:00")
    _gap_passes(helper)
    assert helper_chat.wake_tick() == 0

    # A handoff is the same line of work, not a new session.
    with store.mutate("bot_chats/index", {}) as index:
        index[B]["continued_by"] = C
        index[C] = {"title": "pond (cont.)", "lane": "coding", "spawned_via": "continue",
                    "spawned_from": B, "last_at": "2026-09-27T12:30:00"}
    _summary(C, "Carrying the pond page on.", "2026-09-27T12:31:00")
    assert helper_chat.wake_tick() == 0
    assert len(started) == 2


def test_the_wake_up_follows_its_switch(room, monkeypatch):
    helper, started, repo = room
    _seed(A, last_at="2026-09-27T12:00:00")
    _summary(A, "Builds the pond page.", "2026-09-27T12:00:00")
    helper_chat.wake_tick()
    _summary(A, "Still building it.", "2026-09-27T12:10:00")   # a summary, no new file

    monkeypatch.setattr(config, "HELPER_WAKE_ON", "off")
    assert helper_chat.wake_tick() == 0
    _did(A, _read(repo / "notes.md"))                          # a newly read file
    monkeypatch.setattr(config, "HELPER_WAKE_ON", "new-or-files")
    assert helper_chat.wake_tick() == 0                        # reads don't count…
    _summary(A, "Reading the notes.", "2026-09-27T12:11:00")
    monkeypatch.setattr(config, "HELPER_WAKE_ON", "new-or-any-files")
    assert helper_chat.wake_tick() == 1                        # …unless it's set to
    assert "notes.md" in started[-1][1]
    _turn_ends(helper, helper_chat.SILENT)
    _gap_passes(helper)
    _summary(A, "Still building it, again.", "2026-09-27T12:12:00")
    monkeypatch.setattr(config, "HELPER_WAKE_ON", "edit")
    assert helper_chat.wake_tick() == 0                        # nothing was edited
    monkeypatch.setattr(config, "HELPER_WAKE_ON", "summary")
    assert helper_chat.wake_tick() == 1
    _turn_ends(helper, helper_chat.SILENT)

    monkeypatch.setattr(config, "HELPER_WAKE_ON", "edit")
    _gap_passes(helper)
    _did(A, _edit(repo / "pond.py"))                           # an edit, no new summary
    assert helper_chat.wake_tick() == 1
    assert "pond.py" in started[-1][1]


def test_a_wake_up_answered_with_silence_leaves_the_card_as_it_was(room, monkeypatch):
    helper, started, repo = room
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["last_at"] = "2026-09-27T09:00:00"       # when she last heard from it
    _seed(A, last_at="2026-09-27T12:00:00")
    helper_chat.wake_tick()
    _summary(A, "Builds the pond page.", "2026-09-27T12:00:00")
    assert helper_chat.wake_tick() == 1
    assert _entry(helper)["last_at"] != "2026-09-27T09:00:00"  # a turn is running
    _turn_ends(helper, helper_chat.SILENT)
    assert _entry(helper)["last_at"] == "2026-09-27T09:00:00"

    # When it has something to say, the card moves like after any reply.
    _seed(B, last_at="2026-09-27T12:30:00")
    _summary(B, "Also in the pond page.", "2026-09-27T12:31:00")
    _gap_passes(helper)
    assert helper_chat.wake_tick() == 1
    _turn_ends(helper, "Two sessions are both in the pond page; I've joined them.")
    assert _entry(helper)["last_at"] != "2026-09-27T09:00:00"
    # What it said there is carried across a growing helper's reset, and not
    # replayed to a helper that starts fresh every turn: she didn't start it.
    assert "joined them" in helper_chat.seed_text(helper, _entry(helper))
    monkeypatch.setattr(config, "HELPER_GROW_ROLES", ())
    assert "joined them" not in helper_chat.seed_text(helper, _entry(helper))


def test_the_helper_chat_is_never_continued_past_the_cap(helper):
    entry = {**_entry(helper), "context_tokens": 10 ** 6, "context_model": "claude-opus-5-5"}
    assert continuation.due(entry) is False
    assert continuation.due({**entry, "role": None}) is True   # a plain Coding session is


def test_a_handed_off_helper_comes_back_as_the_one_chat(helper):
    with store.mutate("bot_chats/index", {}) as index:
        index[helper].update(continued_by="2026-09-27.200000", archived=True,
                             continuation={"state": "handed_off"})
    swarm_id = _entry(helper)["swarm_id"]
    assert swarm_helper.ensure_helper(swarm_id) == helper
    entry = _entry(helper)
    assert not any(k in entry for k in ("continued_by", "archived", "continuation"))


def test_a_helpers_own_continuation_makes_no_swarm(helper):
    _seed("2026-09-27.200000", spawned_via="continue", spawned_from=helper)
    swarm_id = _entry(helper)["swarm_id"]
    assert swarms.sync() == {swarm_id: {A, B}}


# --- Retirement and the closing check ---------------------------------------------

def test_a_swarm_retires_when_fewer_than_two_members_are_working(helper):
    swarm_id = _entry(helper)["swarm_id"]
    assert swarms.retired(swarm_id) is False
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["done_at"] = "2026-09-27T12:00:00"
        index[A]["running"] = True
    assert swarms.retired(swarm_id) is False                   # A is mid-turn
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["running"] = False
    assert swarms.retired(swarm_id) is True                    # B alone isn't a swarm


def _closing_post(helper):
    """The closing message as the helper's chat holds it."""
    path = store.DATA_DIR / "bot_chats" / f"{helper}.jsonl"
    log = path.read_text().splitlines() if path.exists() else []
    posts = [json.loads(line) for line in log if '"closing_check"' in line]
    return [post["message"]["content"][0]["text"] for post in posts]


def test_a_retired_swarm_gets_one_closing_summary_then_the_helper_is_done(helper, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git = ["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "pond.py").write_text("x = 1\n")
    subprocess.run(git + ["add", "pond.py"], check=True)
    subprocess.run(git + ["commit", "-qm", "Pond page ships"], check=True)
    commit = subprocess.run(git + ["rev-parse", "--short", "HEAD"], check=True,
                            capture_output=True, text=True).stdout.strip()
    # A second commit made quietly, the way agents mostly do: git prints
    # nothing, so the transcript holds only the command and when it ran.
    asked = datetime.now(timezone.utc)
    (repo / "frog.py").write_text("y = 2\n")
    subprocess.run(git + ["add", "frog.py"], check=True)
    subprocess.run(git + ["commit", "-qm", "Frogs join the pond"], check=True)
    quiet = subprocess.run(git + ["rev-parse", "--short", "HEAD"], check=True,
                           capture_output=True, text=True).stdout.strip()
    stamp = lambda when: when.isoformat().replace("+00:00", "Z")
    room = room_helper.ensure_room_helper("coding")
    with store.mutate("bot_chats/index", {}) as index:
        index[A].update(cwd=str(repo), done_at="2026-09-27T12:00:00",
                        done_note="pond page shipped")
        index[B].update(archived=True, awaiting_questions=["which colour?"])
    _log(A, {"type": "user", "text": "build the pond page", "ts": "2026-09-27T10:00:00"},
         {"type": "user", "message": {"content": [{"type": "tool_result",
          "content": f"[main {commit}] Pond page ships\n 1 file changed"}]}},
         {"type": "assistant", "timestamp": stamp(asked), "message": {"content": [
             {"type": "tool_use", "id": "toolu_quiet", "name": "Bash",
              "input": {"command": "git add frog.py && git commit -q -m 'Frogs join the pond'"}}]}},
         {"type": "user", "timestamp": stamp(datetime.now(timezone.utc)), "message": {"content": [
             {"type": "tool_result", "tool_use_id": "toolu_quiet", "content": ""}]}})

    swarm_helper.tick()
    # The model wrote from the members' work AND the git-checked facts.
    [handed] = swarm_helper.closing_calls
    assert "build the pond page" in handed and "pond page shipped" in handed
    assert f"`{commit}` Pond page ships" in handed.split("## The closing check")[1]
    # Its summary is posted above the closing check, in the helper's chat.
    [post] = _closing_post(helper)
    summary, check = post.split("**Closing check")
    assert "Closing 1: the pond page was built." in summary
    assert f"`{commit}` Pond page ships" in check
    assert f"`{quiet}` Frogs join the pond" in check           # the quiet one too
    assert "closed without saying it was done" in check        # B never said done
    assert "which colour?" in check
    entry = _entry(helper)
    assert entry["helper_closed_at"] and entry["done_at"] and not entry["running"]
    # The room's helper is told in one line, with what was done.
    room_log = (store.DATA_DIR / "bot_chats" / f"{room}.jsonl").read_text()
    [told] = [json.loads(line) for line in room_log.splitlines() if "swarm_closed" in line]
    assert "Closing 1 headline." in told["message"]["content"][0]["text"]
    # The mark and the time are what the chat page opens the line into: this
    # swarm's closing, the one kept at the same moment.
    [kept] = swarm_helper.closings(told["swarm_closed"])
    assert told["timestamp"] == kept["at"]

    swarm_helper.tick()                                        # once, not every minute
    assert len(_closing_post(helper)) == 1 and len(swarm_helper.closing_calls) == 1


def test_she_can_ask_a_closed_swarms_helper_what_happened(helper, monkeypatch):
    """Her ask: "so i can know what was completed and ask it questions about
    what happened." Days later the members are out of the helper's view and
    the closing message was never part of an exchange — and still both doors
    she can ask through hand the helper the summary and every member's id."""
    swarm_id = _entry(helper)["swarm_id"]
    long_ago = (datetime.now() - timedelta(days=3)).isoformat(timespec="seconds")
    with store.mutate("bot_chats/index", {}) as index:
        index[A].update(done_at=long_ago, last_at=long_ago, done_note="pond page shipped")
        index[B].update(done_at=long_ago, last_at=long_ago)
    swarm_helper.tick()
    assert swarms.in_helper_view([A, B], store.read("bot_chats/index", {}))[0] == []

    # Her chat with it: the turn starts, un-archived, from a seed that holds
    # the summary, the closing check and the members — once, not also replayed.
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["archived"] = True                       # its countdown closed it
    started = []
    monkeypatch.setattr(observatory, "_mem_available_mb", lambda: None)
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, resume_sid, conv_id, log_path:
                        started.append(config) or True)
    assert observatory.begin_turn(helper, "what did this swarm get done?")["ok"]
    seed = open(started[0]["system_prompt_file"], encoding="utf-8").read()
    kept = seed.split("# What this swarm did")[1].split("# 2. Her last")[0]
    assert "Closing 1: the pond page was built." in kept and "**What shipped**" in kept
    assert f"`{A}`" in kept and "pond page shipped" in kept and f"`{B}`" in kept
    assert seed.count("Closing 1: the pond page was built.") == 1
    assert [p["key"] for p in helper_chat.last_seed(helper)["parts"]] == [
        "doc", "rules", "watches", "closings", "exchanges", "sessions"]
    # Having answered, it starts its countdown to closing again by itself.
    assert "done_at" not in _entry(helper)
    _turn_ends(helper, "It built the pond page.")
    assert _entry(helper)["done_at"]

    # The box on the swarm's page: a run answers, and reads the same record.
    run_input = swarm_helper.gather(swarm_id)
    assert "Closing 1: the pond page was built." in run_input and f"`{A}`" in run_input


def test_a_swarm_that_closes_again_keeps_its_earlier_summary(helper):
    swarm_id = _entry(helper)["swarm_id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["done_at"] = index[B]["done_at"] = "2026-09-27T12:00:00"
    swarm_helper.tick()
    with store.mutate("bot_chats/index", {}) as index:
        index[A].pop("done_at")                                # both get new turns:
        index[B].pop("done_at")                                # the swarm opens again
    swarm_helper.tick()
    assert "helper_closed_at" not in _entry(helper)
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["done_at"] = index[B]["done_at"] = "2026-09-28T12:00:00"
    swarm_helper.tick()

    first, second = swarm_helper.closings(swarm_id)
    assert (first["summary"], second["summary"]) == (
        "Closing 1: the pond page was built.", "Closing 2: the pond page was built.")
    # The second was written knowing the first, and the helper is handed both.
    assert "Closing 1: the pond page was built." in swarm_helper.closing_calls[1]
    seed = helper_chat.seed_text(helper, _entry(helper))
    assert "Closing 1:" in seed and "Closing 2:" in seed and "closed 2 times" in seed


def test_a_summary_that_cant_be_written_never_stops_the_closing(helper, monkeypatch):
    swarm_id = _entry(helper)["swarm_id"]
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["done_at"] = index[B]["done_at"] = "2026-09-27T12:00:00"

    def down(text):
        swarm_helper.closing_calls.append(text)
        raise RuntimeError("model down")
    monkeypatch.setattr(swarm_helper, "_call_closing", down)
    swarm_helper.tick()
    swarm_helper.tick()
    # The closing check is posted alone, saying why; the model was tried once.
    [post] = _closing_post(helper)
    assert "couldn't write the summary (model down)" in post and "**What shipped**" in post
    [closing] = swarm_helper.closings(swarm_id)
    assert closing["summary"] is None and closing["error"] == "model down"
    assert len(swarm_helper.closing_calls) == 1 and _entry(helper)["done_at"]


def test_a_closing_process_that_dies_leaves_the_closing_check_and_no_second_call(
        helper, monkeypatch):
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["done_at"] = index[B]["done_at"] = "2026-09-27T12:00:00"
    monkeypatch.setattr(swarm_helper, "_detach", lambda swarm_id, args: None)   # it never posts
    swarm_helper.tick()
    swarm_helper.tick()
    assert _closing_post(helper) == [] and _entry(helper)["running"]   # left to finish
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["running"] = False                       # its process is gone
    swarm_helper.tick()
    [post] = _closing_post(helper)
    assert "couldn't write the summary" in post and "**What shipped**" in post
    assert swarm_helper.closing_calls == [] and _entry(helper)["done_at"]


def test_a_swarm_that_comes_back_to_life_brings_its_helper_back(helper):
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["done_at"] = index[B]["done_at"] = "2026-09-27T12:00:00"
    swarm_helper.tick()
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["archived"] = True                       # its countdown closed it
        index[A].pop("done_at")                                # and then both got
        index[B].pop("done_at")                                # new turns
    swarm_helper.tick()
    entry = _entry(helper)
    assert not any(k in entry for k in ("helper_closed_at", "archived", "done_at"))


def test_a_summarizer_run_never_reads_an_old_helpers_handoff(helper):
    old = "2026-09-27.200000"
    _seed(old, title="Swarm helper · old (cont.)", spawned_via="continue", spawned_from=helper)
    swarm_id = _entry(helper)["swarm_id"]
    swarms.join(swarm_id, old)
    peermail.send(old, "old helper recap", from_conv=A)
    text = swarm_helper.gather(swarm_id)
    assert A in text and old not in text and "old helper recap" not in text


def test_a_growing_helper_resumes_with_its_seed_untouched_until_it_passes_the_reset_size(
        room, monkeypatch):
    """A growing helper's whole cycle: fresh start, resumed turns that keep
    the seed as it was and carry the room as it is now, then a fresh start
    again once the conversation is past the reset size."""
    helper, _, _ = room
    monkeypatch.setattr(config, "HELPER_GROW_ROLES", ("room_helper",))
    monkeypatch.setattr(config, "HELPER_RESET_TOKENS", 200000)
    # One exchange is the usual number kept here, so the reset below shows
    # that everything she said since the last reset is carried across.
    monkeypatch.setattr(config, "HELPER_CHAT_EXCHANGES", 1)
    started = []
    monkeypatch.setattr(
        observatory, "_spawn_host",
        lambda turn_config, text, resume_sid, conv_id, log_path: started.append(
            (open(turn_config["system_prompt_file"], encoding="utf-8").read(), text, resume_sid))
        or True)

    def model_session(session_id, context_tokens):
        _turn_ends(helper, "noted")
        with store.mutate("bot_chats/index", {}) as index:
            index[helper].update(claude_session_id=session_id, context_tokens=context_tokens)

    # Its first growing turn starts fresh, whatever session it last ran in.
    with store.mutate("bot_chats/index", {}) as index:
        index[helper].update(claude_session_id="rolling-session", context_tokens=50000)
    assert observatory.begin_turn(helper, "who is on pond.py?")["ok"]
    first_seed, text, resume_sid = started[-1]
    assert resume_sid is None and text.startswith("who is on pond.py?")
    assert "this chat GROWS, then RESETS" in first_seed
    assert _entry(helper).get("claude_session_id") is None

    # Under the size it resumes: same seed, the new session in the message.
    model_session("grown-1", 70000)
    _seed(A, last_at="2026-09-27T12:00:00")
    assert observatory.begin_turn(helper, "and now?")["ok"]
    seed, text, resume_sid = started[-1]
    assert resume_sid == "grown-1" and seed == first_seed and f"## `{A}`" not in seed
    assert text.startswith(helper_chat.ROOM_NOW_HEAD) and text.endswith("and now?")
    assert f"## `{A}`" in text
    assert f"## `{A}`" in helper_chat.last_seed(helper)["parts"][-1]["text"]

    # A resumed turn is handed only what changed: nothing when the room is
    # as it was, then the one session that left.
    model_session("grown-2", 80000)
    assert observatory.begin_turn(helper, "anything new?")["ok"]
    _, text, resume_sid = started[-1]
    assert resume_sid == "grown-2" and f"## `{A}`" not in text
    assert "Nothing has changed in the 1 active sessions" in text
    model_session("grown-3", 90000)
    _seed(A, done_at="2026-09-27T13:00:00")
    assert observatory.begin_turn(helper, "and after that?")["ok"]
    _, text, _ = started[-1]
    assert f"No longer active (finished, closed, or continued by another session): `{A}`." in text
    with store.mutate("bot_chats/index", {}) as index:
        index[A].pop("done_at")

    # Past the size it starts over, from a new seed that holds the room now,
    # every message she sent since the reset before, and what it said on a
    # wake-up in that stretch — but not a wake-up it answered with silence.
    model_session("grown-4", 200001)
    for said in ("pond and garden both touch shared.py", helper_chat.SILENT):
        _log(helper, {"type": "reminder", "text": "Room change — a session is new",
                      "source": helper_chat.WAKE_SOURCE,
                      "ts": datetime.now().isoformat(timespec="seconds")},
             _reply(said, f"msg_wake_{len(said)}"))
    assert observatory.begin_turn(helper, "third question")["ok"]
    seed, text, resume_sid = started[-1]
    assert resume_sid is None and text.startswith("third question")
    assert f"## `{A}`" in seed and "who is on pond.py?" in seed and "and now?" in seed
    assert "pond and garden both touch shared.py" in seed
    assert seed.count("**The app woke you:**") == 1 and helper_chat.SILENT not in seed.split(
        "# 2. Her last")[1].split("# 3.")[0]


def test_a_helper_outside_the_growing_roles_still_starts_fresh_every_turn(room, monkeypatch):
    helper, _, _ = room
    monkeypatch.setattr(config, "HELPER_GROW_ROLES", ())
    started = []
    monkeypatch.setattr(
        observatory, "_spawn_host",
        lambda turn_config, text, resume_sid, conv_id, log_path: started.append(
            (open(turn_config["system_prompt_file"], encoding="utf-8").read(), resume_sid))
        or True)
    for question in ("first", "second"):
        assert observatory.begin_turn(helper, question)["ok"]
        _turn_ends(helper, "noted")
        with store.mutate("bot_chats/index", {}) as index:
            index[helper].update(claude_session_id="some-session", context_tokens=60000)
    assert [resume_sid for _, resume_sid in started] == [None, None]
    assert all("this chat is ROLLING" in seed for seed, _ in started)
