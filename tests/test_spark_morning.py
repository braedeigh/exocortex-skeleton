"""The 5 AM Spark ritual's archive guard.

`scripts/spark_morning.py` clears yesterday's Spark session off the roster
before spawning today's. These tests pin the GUARD on that clearing: a prior
Spark survives only if she actually talked to it AND touched it inside the keep
window. Everything else — the untouched 5 AM orientation, the session that went
quiet two days ago — still gets archived.

The load-bearing case is `test_tool_results_do_not_count_as_her_messages`. The
conversation log records tool RESULTS as `user` events too, so a naive count
reads a session she never opened as busy. That regression is the whole reason
`_was_used` looks at `ts` + text rather than the event type alone.

Prompt this came from: "Skip it if I haven't used it at all since it was
generated or in the last 24 hours ... but otherwise keep it."
"""
import json
from datetime import datetime, timedelta

import pytest

import store
from scripts import spark_morning as sm


def _log(conv_id, messages, tool_results=0):
    """Write a conversation jsonl: `messages` of hers (the first being the
    seeded kickoff), plus tool-result `user` events that must not be counted."""
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for i in range(messages):
            f.write(json.dumps({"type": "user", "text": f"message {i}",
                                "ts": "2026-08-01T09:00:00"}) + "\n")
        for _ in range(tool_results):
            f.write(json.dumps({"type": "user", "text": "", "ts": None}) + "\n")


def _entry(hours_ago, **extra):
    seen = datetime.now() - timedelta(hours=hours_ago)
    return dict({"origin": sm.ORIGIN, "bot": "keeper",
                 "started": seen.isoformat(timespec="seconds"),
                 "last_at": seen.isoformat(timespec="seconds")}, **extra)


@pytest.fixture
def index(data_dir):
    """Write a bot_chats index and hand back a reader for the result."""
    def _write(entries):
        (data_dir / "bot_chats").mkdir(parents=True, exist_ok=True)
        store.write("bot_chats/index", entries)
        return lambda: store.read("bot_chats/index", {})
    return _write


def test_untouched_orientation_is_archived(index):
    """The common case: a 5 AM Spark she never opened. Only the seeded kickoff
    is in the log, so it clears even though it's minutes old."""
    read = index({"2026-08-01.050002": _entry(hours_ago=0.1)})
    _log("2026-08-01.050002", messages=1)
    sm._archive_prior()
    assert read()["2026-08-01.050002"]["archived"]


def test_session_she_used_recently_is_kept(index):
    """Her rule, and the case that prompted it: she worked in yesterday
    afternoon's Spark, so this morning's run must leave it on the roster."""
    read = index({"2026-08-01.050002": _entry(hours_ago=14.6)})
    _log("2026-08-01.050002", messages=3)
    sm._archive_prior()
    assert "archived" not in read()["2026-08-01.050002"]


def test_used_but_stale_session_is_archived(index):
    """Used, but untouched for more than the keep window — it ages out on the
    next run rather than accumulating forever."""
    read = index({"2026-07-30.050001": _entry(hours_ago=sm.KEEP_WINDOW_HOURS + 1)})
    _log("2026-07-30.050001", messages=8)
    sm._archive_prior()
    assert read()["2026-07-30.050001"]["archived"]


def test_tool_results_do_not_count_as_her_messages(index):
    """The regression that motivated `_was_used`: a session she never replied
    in still logs dozens of `user` events, because tool results ride that type.
    Counting events instead of HER messages would keep it forever."""
    read = index({"2026-08-01.050002": _entry(hours_ago=1)})
    _log("2026-08-01.050002", messages=1, tool_results=41)
    sm._archive_prior()
    assert read()["2026-08-01.050002"]["archived"]


def test_other_sessions_are_never_touched(index):
    """The ritual only ever clears its own. A hand-made session — or the
    pinned Keeper — must survive regardless of age or use."""
    read = index({
        "2026-07-01.120000": {"bot": "keeper", "last_at": "2026-07-01T12:00:00"},
        "2026-08-01.030304": {"bot": "keeper", "origin": "keeper_rollover",
                              "last_at": "2026-08-01T03:03:04"},
    })
    sm._archive_prior()
    after = read()
    assert "archived" not in after["2026-07-01.120000"]
    assert "archived" not in after["2026-08-01.030304"]


def test_already_archived_entry_keeps_its_original_stamp(index):
    """Re-running the ritual must not re-stamp a session it already closed."""
    read = index({"2026-07-28.050002": _entry(hours_ago=99,
                                              archived="2026-07-29T05:00:01")})
    _log("2026-07-28.050002", messages=1)
    sm._archive_prior()
    assert read()["2026-07-28.050002"]["archived"] == "2026-07-29T05:00:01"


def test_missing_log_is_treated_as_used(data_dir):
    """Fail safe: a log we can't read must never be the reason a session she
    was working in disappears."""
    assert sm._was_used("2026-08-01.050002") is True
