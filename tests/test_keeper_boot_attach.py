"""Waking a Keeper attaches its boot package (routes/observatory.py
attach_boot_package + the /journalstart hook in the send path, and the
3 AM rollover in scripts/keeper_rollover.py).

The send tests reuse test_observatory_routes' stubbed app: `claude` is a stub
script that logs its argv, so these assert on the real command line built for
the turn.
"""
import json

from routes import observatory
import store
from tests.test_observatory_routes import (  # noqa: F401  (bot_client is a fixture)
    bot_client, _send, _sse_events, _wait_not_running)


def _argv_calls(tmp_path):
    log = tmp_path / "claude_argv.jsonl"
    return [json.loads(line) for line in log.read_text().splitlines()]


def test_system_prompt_goes_in_by_path_not_contents(tmp_path):
    prompt = tmp_path / "big.md"
    prompt.write_text("x" * 300_000)            # over Linux's 128 KB per-argument cap
    cmd = observatory._build_cmd({"system_prompt_file": str(prompt)}, None)
    assert cmd[cmd.index("--append-system-prompt-file") + 1] == str(prompt)
    assert "--append-system-prompt" not in cmd
    assert all(len(arg) < 10_000 for arg in cmd)


def test_missing_system_prompt_file_is_skipped(tmp_path):
    cmd = observatory._build_cmd({"system_prompt_file": str(tmp_path / "gone.md")}, None)
    assert "--append-system-prompt-file" not in cmd


def test_is_journalstart_matches_only_the_command():
    assert observatory._is_journalstart("/journalstart")
    assert observatory._is_journalstart("  /journalstart please")
    assert not observatory._is_journalstart("/journalstartle")
    assert not observatory._is_journalstart("tell me about /journalstart")


def test_attach_boot_package_writes_a_snapshot_per_conversation(data_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    path = observatory.attach_boot_package("2026-09-25.120000")
    assert path.endswith("bot_chats/boot/2026-09-25.120000.md")
    text = open(path, encoding="utf-8").read()
    assert text.startswith("# Boot package") and "## Coming up" in text


def test_journalstart_send_attaches_the_package_for_every_turn(bot_client, tmp_path):
    events = _sse_events(_send(bot_client, text="/journalstart"))
    conv_id = events[0]["conversation_id"]
    meta = _wait_not_running(conv_id)
    boot = meta.get("system_prompt_file")
    assert boot and boot.endswith(f"boot/{conv_id}.md")
    # the turn that woke it already carried the package...
    first = _argv_calls(tmp_path)[-1]
    assert first[first.index("--append-system-prompt-file") + 1] == boot
    # ...and so does the next one, with no /journalstart in it
    _send(bot_client, text="morning", conversation_id=conv_id).get_data()
    _wait_not_running(conv_id)
    second = _argv_calls(tmp_path)[-1]
    assert second[second.index("--append-system-prompt-file") + 1] == boot


def test_rollover_wakes_the_new_keeper_with_its_package(data_dir, tmp_path, monkeypatch):
    from scripts import keeper_rollover
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    sent = []
    monkeypatch.setattr(keeper_rollover, "_run_turn_sync",
                        lambda bot, text, conv_id, sid, cwd: sent.append((bot, text, conv_id)))
    conv_id = keeper_rollover._open()
    entry = store.read("bot_chats/index", {})[conv_id]
    assert entry["system_prompt_file"].endswith(f"boot/{conv_id}.md")
    bot, text, _ = sent[0]
    assert text == "/journalstart"
    assert bot["system_prompt_file"] == entry["system_prompt_file"]


def test_ordinary_send_attaches_nothing(bot_client, tmp_path):
    events = _sse_events(_send(bot_client, text="just chatting"))
    meta = _wait_not_running(events[0]["conversation_id"])
    assert "system_prompt_file" not in meta
    assert "--append-system-prompt-file" not in _argv_calls(tmp_path)[-1]
