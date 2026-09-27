"""scripts/backfill_spawned_from.py — finding the parent of spinoffs that
predate `spawned_from`, from the chat logs.

Each test seeds an index plus the logs a real session would have left, runs
resolve(), and checks the parent it names — or that it names none rather
than guessing.
"""
import json

import store
from scripts import backfill_spawned_from as backfill


def _log(chats, conv, *events):
    chats.mkdir(parents=True, exist_ok=True)
    with (chats / f"{conv}.jsonl").open("a") as f:
        for event in events:
            f.write(json.dumps(event) + "\n")


def _bash(command, ts="2026-07-01T10:00:00Z"):
    return {"type": "assistant", "timestamp": ts, "message": {"content": [
        {"type": "tool_use", "name": "Bash", "input": {"command": command}}]}}


def _reply(child):
    body = json.dumps({"ok": True, "conversation_id": child, "newly_spawned": True})
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "content": body}]}}


def _child(slug, started="2026-07-02T09:00:00", **extra):
    return {"spinoff_slug": slug, "started": started, **extra}


def test_the_spawn_scripts_reply_names_the_parent_exactly(tmp_path):
    chats = tmp_path / "bot_chats"
    # Real ids: the reply is matched on the conversation-id shape.
    _log(chats, "2026-07-01.100000", _reply("2026-07-02.090000"))
    index = {"2026-07-01.100000": {}, "2026-07-02.090000": _child("anything")}
    decisions, _ = backfill.resolve(index, chats, tmp_path / "none")
    assert decisions["2026-07-02.090000"] == ("2026-07-01.100000", "skill", "exact")


def test_an_offer_before_the_child_started_means_she_tapped_go(tmp_path):
    chats = tmp_path / "bot_chats"
    _log(chats, "p2", _bash("./venv/bin/python3 scripts/spinoff_offer.py tidy-up --room coding"))
    decisions, _ = backfill.resolve({"p2": {}, "c2": _child("tidy-up")}, chats, tmp_path / "none")
    assert decisions["c2"][:2] == ("p2", "go")


def test_a_shell_loop_over_slugs_counts_as_spawning_each(tmp_path):
    chats = tmp_path / "bot_chats"
    _log(chats, "p3", _bash('for slug in one two; do\n  scripts/spinoff_open.py "$slug"\ndone'))
    index = {"p3": {}, "c3": _child("one"), "c4": _child("two")}
    decisions, _ = backfill.resolve(index, chats, tmp_path / "none")
    assert decisions["c3"][0] == decisions["c4"][0] == "p3"


def test_a_command_after_the_child_started_is_not_its_parent(tmp_path):
    chats = tmp_path / "bot_chats"
    _log(chats, "late", _bash("scripts/spinoff_open.py rerun", ts="2026-08-01T10:00:00Z"))
    _, unresolved = backfill.resolve({"late": {}, "c5": _child("rerun")}, chats, tmp_path / "none")
    assert unresolved == ["c5"]


def test_a_fork_finds_the_session_it_took_over_by_title(tmp_path, data_dir, monkeypatch):
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    brief = data_dir / "spinoffs" / "fork-ui-0702" / "BRIEF.md"
    brief.parent.mkdir(parents=True)
    brief.write_text("# Fork: take over the work of “UI work”\n")
    index = {"orig": {"title": "UI work", "started": "2026-07-01T08:00:00"},
             "c6": _child("fork-ui-0702")}
    decisions, _ = backfill.resolve(index, tmp_path / "bot_chats", tmp_path / "none")
    assert decisions["c6"][:2] == ("orig", "fork")


def test_entries_that_already_have_a_link_are_left_alone(tmp_path):
    chats = tmp_path / "bot_chats"
    _log(chats, "p7", _reply("c7"))
    index = {"p7": {}, "c7": _child("done", spawned_via="skill", spawned_from="other")}
    decisions, unresolved = backfill.resolve(index, chats, tmp_path / "none")
    assert "c7" not in decisions and not unresolved
