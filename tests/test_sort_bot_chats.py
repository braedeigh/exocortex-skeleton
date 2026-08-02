"""scripts/sort_bot_chats.py — which conversations the sorter will touch.

The classify/prompt half calls out to Claude and isn't exercised here; what's
pinned is the SKIP LOGIC, because that's where the sorter silently lost 4% of
the corpus. A `running` flag can outlive its turn (the event relay lives in a
gunicorn worker thread, so a worker recycle strands it), and archived sessions
never reach the roster read that would clear it — so four conversations carried
a stale flag for 5-9 days and were skipped on every single run.

Liveness is therefore read off the conversation log's mtime, not the flag.
"""
import json
import os
import time

import pytest

import store
from scripts import sort_bot_chats as sbc


@pytest.fixture
def chats(data_dir):
    """Write an index entry plus a conversation log, and age the log."""
    def _make(conv_id, log_age_sec=0, **entry):
        chats_dir = data_dir / "bot_chats"
        chats_dir.mkdir(parents=True, exist_ok=True)
        path = chats_dir / f"{conv_id}.jsonl"
        path.write_text(json.dumps({"type": "user", "text": "hi"}) + "\n")
        touched = time.time() - log_age_sec
        os.utime(path, (touched, touched))
        index = store.read("bot_chats/index", {})
        index[conv_id] = dict({"bot": "keeper"}, **entry)
        store.write("bot_chats/index", index)
        return index[conv_id]
    return _make


def test_a_turn_writing_right_now_is_live(chats):
    entry = chats("2026-08-02.120000", log_age_sec=0, running=True)
    assert sbc._is_live("2026-08-02.120000", entry) is True


def test_a_stranded_running_flag_is_not_live(chats):
    """The bug: a worker recycle leaves `running` set forever. The log hasn't
    moved in days, so the flag is a corpse and the session must be sortable."""
    entry = chats("2026-07-24.120010", log_age_sec=218 * 3600, running=True)
    assert sbc._is_live("2026-07-24.120010", entry) is False


def test_an_archived_session_with_a_stranded_flag_still_sorts(chats, capsys):
    """Archived + stale running was the exact permanent blind spot: invisible
    on the roster (so nothing ever cleared the flag) AND skipped by the sorter.

    Driven through main(--dry-run) because the skip lives in main's loop, not
    in _candidates — asserting on _candidates alone would pass with the bug
    still in place."""
    chats("2026-07-26.115156", log_age_sec=136 * 3600,
          running=True, archived="2026-07-27T22:00:00")
    sbc.main(["--dry-run"])
    out = capsys.readouterr().out
    assert "running — skipped" not in out
    assert "would sort 1 conversation(s)" in out


def test_a_conversation_mid_turn_is_skipped(chats, capsys):
    """The behaviour the skip exists for, still intact: a log being written to
    right now is a moving target and must not be gisted half-written."""
    chats("2026-08-02.120000", log_age_sec=0, running=True)
    sbc.main(["--dry-run"])
    out = capsys.readouterr().out
    assert "2026-08-02.120000: running — skipped" in out
    assert "nothing to sort" in out


def test_a_conversation_with_no_log_is_not_treated_as_live(data_dir):
    """Matches what the script already does with logless conversations, and
    keeps a missing file from pinning a flag on forever."""
    assert sbc._is_live("2026-08-02.999999", {"running": True}) is False


def test_a_session_with_no_running_flag_is_never_live(chats):
    entry = chats("2026-08-02.130000", log_age_sec=0)
    assert sbc._is_live("2026-08-02.130000", entry) is False


def test_already_gisted_conversations_are_skipped(chats):
    chats("2026-08-02.140000", log_age_sec=3600)
    index = store.read("bot_chats/index", {})
    gists = {"2026-08-02.140000": {"title": "already done"}}
    assert sbc._candidates(index, gists, None, False) == []
    # ...unless --all forces a re-sort.
    assert sbc._candidates(index, gists, None, True) == ["2026-08-02.140000"]
