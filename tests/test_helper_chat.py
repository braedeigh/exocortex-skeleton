"""The swarm helper's chat (helper_chat.py) and its closing check
(swarm_helper.close_out), with every model call faked.

What these pin: a helper chat turn never resumes and starts from a seed of
the swarm's summaries, the running notes and only the last N exchanges; the
notes are replaced after each turn, never appended; the helper chat is never
continued, however big its context; a handed-off helper comes back as the one
chat; a swarm is "retired" only when every member is done, closed or
archived; and a retired swarm gets one closing check that names what git says
shipped and what's left, after which the helper marks itself done.
"""
import json
import subprocess

import pytest

import config
import continuation
import helper_chat
import peermail
import store
import swarm_helper
import swarms
from routes import observatory

A, B = "2026-09-27.100000", "2026-09-27.110000"


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


@pytest.fixture
def helper(data_dir, monkeypatch):
    """A two-member swarm and its helper chat, with no detached processes."""
    monkeypatch.setattr(swarm_helper, "_spawn", lambda *a, **k: True)
    _seed(A, B)
    peermail.send(B, "I'm editing pond.py too", from_conv=A)
    [swarm_id] = swarms.sync()
    return swarm_helper.ensure_helper(swarm_id)


# --- The rolling seed -------------------------------------------------------------

def test_the_seed_holds_summaries_and_only_her_last_messages(helper, monkeypatch):
    monkeypatch.setattr(config, "HELPER_CHAT_MESSAGES", 2)
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["helper_notes"] = "## Her decisions\n- \"pond goes on the left\""
    for n in (1, 2, 3):
        _log(helper, {"type": "user", "text": f"question {n}", "ts": f"2026-09-27T12:0{n}:00"},
             _reply(f"answer {n}", f"msg_{n}"))
    seed = helper_chat.seed_text(helper, _entry(helper))
    assert "pond goes on the left" in seed                     # the chat summary
    assert "Members:" in seed and A in seed                    # the swarm now
    assert "question 2" in seed and "question 3" in seed       # her last two, verbatim
    assert "question 1" not in seed                            # older ones rolled off
    assert "answer 3" not in seed                              # its replies never replayed
    assert f"{helper}.jsonl" in seed                           # it's told where to search


def test_only_her_messages_count_toward_the_ten(helper):
    _log(helper, {"type": "user", "text": "hers", "ts": "2026-09-27T12:00:00"},
         _reply("reply", "msg_1"),
         {"type": "peer", "direction": "in", "from_conv": A, "text": "agent mail"},
         {"type": "reminder", "text": "system notice"})
    assert [text for _, text in helper_chat.her_messages(helper)] == ["hers"]


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
    assert "earlier question" in seed and "new question" not in seed


def test_notes_are_replaced_not_appended(helper, monkeypatch):
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["helper_notes"] = "old notes"
    _log(helper, {"type": "user", "text": "use sqlite, not json"}, _reply("will do"))
    seen = []
    monkeypatch.setattr(helper_chat, "_call_notes",
                        lambda text: seen.append(text) or ("new notes", 0.01))
    helper_chat.rewrite_notes(helper)
    assert "old notes" in seen[0] and "use sqlite, not json" in seen[0]
    assert _entry(helper)["helper_notes"] == "new notes"


def test_the_first_summary_is_written_from_the_earlier_exchanges(helper, monkeypatch):
    _log(helper, {"type": "user", "text": "first ask"}, _reply("first reply", "msg_1"),
         {"type": "user", "text": "second ask"}, _reply("second reply", "msg_2"))
    seen = []
    monkeypatch.setattr(helper_chat, "_call_notes",
                        lambda text: seen.append(text) or ("summary", 0.01))
    helper_chat.rewrite_notes(helper)
    assert "first reply" in seen[0] and "second reply" in seen[0]


def test_after_a_helper_turn_it_rewrites_notes_and_never_asks_for_a_handoff(helper, monkeypatch):
    rewrote = []
    monkeypatch.setattr(helper_chat, "rewrite_notes", lambda conv: rewrote.append(conv))
    monkeypatch.setattr(continuation, "check",
                        lambda conv: pytest.fail("the helper chat was checked for a handoff"))
    observatory.after_turn(helper)
    assert rewrote == [helper]


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

def test_a_swarm_retires_only_when_every_member_is_finished(helper):
    swarm_id = _entry(helper)["swarm_id"]
    assert swarms.retired(swarm_id) is False
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["done_at"] = "2026-09-27T12:00:00"
    assert swarms.retired(swarm_id) is False                   # B is still going
    with store.mutate("bot_chats/index", {}) as index:
        index[B]["archived"] = True
        index[B]["running"] = True
    assert swarms.retired(swarm_id) is False                   # ...mid-turn
    with store.mutate("bot_chats/index", {}) as index:
        index[B]["running"] = False
    assert swarms.retired(swarm_id) is True


def test_a_retired_swarm_gets_one_closing_check_then_the_helper_is_done(helper, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git = ["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "pond.py").write_text("x = 1\n")
    subprocess.run(git + ["add", "pond.py"], check=True)
    subprocess.run(git + ["commit", "-qm", "Pond page ships"], check=True)
    commit = subprocess.run(git + ["rev-parse", "--short", "HEAD"], check=True,
                            capture_output=True, text=True).stdout.strip()
    with store.mutate("bot_chats/index", {}) as index:
        index[A].update(cwd=str(repo), done_at="2026-09-27T12:00:00")
        index[B].update(archived=True, awaiting_questions=["which colour?"])
    _log(A, {"type": "user", "message": {"content": [{"type": "tool_result",
          "content": f"[main {commit}] Pond page ships\n 1 file changed"}]}})

    swarm_helper.tick()
    report = helper_chat.exchanges(helper)[-1]["out"][-1]
    assert f"`{commit}` Pond page ships" in report
    assert "closed without saying it was done" in report       # B never said done
    assert "which colour?" in report
    entry = _entry(helper)
    assert entry["helper_closed_at"] and entry["done_at"]

    swarm_helper.tick()                                        # once, not every minute
    log = (store.DATA_DIR / "bot_chats" / f"{helper}.jsonl").read_text()
    assert log.count("Closing check") == 1


def test_a_swarm_that_comes_back_to_life_brings_its_helper_back(helper):
    with store.mutate("bot_chats/index", {}) as index:
        index[A]["done_at"] = index[B]["done_at"] = "2026-09-27T12:00:00"
    swarm_helper.tick()
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["archived"] = True                       # its countdown closed it
        index[B].pop("done_at")                                # and then B got a new turn
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
