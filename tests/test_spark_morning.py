"""The 5 AM Spark ritual — its archive guard, and its findings registry.

TWO CONCERNS, two halves of this file.

1. THE ARCHIVE GUARD. `scripts/spark_morning.py` clears yesterday's Spark
session off the roster before spawning today's. These tests pin the GUARD on
that clearing: a prior Spark survives only if she actually talked to it AND
touched it inside the keep window. Everything else — the untouched 5 AM
orientation, the session that went quiet two days ago — still gets archived.

The load-bearing case is `test_tool_results_do_not_count_as_her_messages`. The
conversation log records tool RESULTS as `user` events too, so a naive count
reads a session she never opened as busy. That regression is the whole reason
`_was_used` looks at `ts` + text rather than the event type alone.

Prompt this came from: "Skip it if I haven't used it at all since it was
generated or in the last 24 hours ... but otherwise keep it."

2. THE FINDINGS REGISTRY. The morning turn is act-gated, so it can't record
anything itself — it drops JSON at the inbox path with the Write tool and this
script merges it. These tests pin the merge's two jobs: an item seen again
keeps its ORIGINAL `first_seen` while bumping `times_seen` (that's the "still
open since Aug 3, seen 4 times" line the next run reads back), and every
malformed shape the agent could emit degrades to "recorded nothing" instead of
raising — a bad findings file must never cost her the orientation already
sitting in the session log.

Prompt this came from: "dig through my dev notes and then pick the most
important structural ones ... maybe top 3", plus her rule that the run must not
read its own history before choosing, so as not to bias what it picks.
"""
import json
from datetime import datetime, timedelta
from pathlib import Path

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


# --- The findings registry -------------------------------------------------

def _inbox(payload):
    """Write the drop file exactly as the turn's Write tool would. Takes a raw
    object, not a findings list, so the malformed cases can hand it junk."""
    path = store.DATA_DIR / sm.INBOX_NAME
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _rows():
    return store.read(sm.REGISTRY, {"findings": []})["findings"]


def test_a_new_finding_lands_with_its_conversation(data_dir):
    """The plain case: one pick, recorded with the session that dug it up so
    she can reopen that conversation instead of re-running the research."""
    _inbox({"findings": [{"key": "devnote:0836838d", "label": "swipe gesture",
                          "source": "dev_notes:global", "verdict": "stale",
                          "summary": "shipped in 1b26b90"}]})
    assert sm._merge_findings("2026-08-04.050001") == 1
    row, = _rows()
    assert row["key"] == "devnote:0836838d"
    assert row["verdict"] == "stale"
    assert row["times_seen"] == 1
    assert row["conv_id"] == "2026-08-04.050001"
    assert row["first_seen"] == row["last_seen"]


def test_a_repeat_keeps_first_seen_and_bumps_the_count(data_dir):
    """The whole point of the registry. A second sighting must not reset the
    clock — `first_seen` is what makes "still open since ..." true, and
    `conv_id` moves to the newest session because that's the one to reopen."""
    store.write(sm.REGISTRY, {"findings": [
        {"key": "devtodo:capture-gap", "label": "capture gap",
         "first_seen": "2026-08-03", "last_seen": "2026-08-03",
         "times_seen": 1, "conv_id": "2026-08-03.050001"}]})
    _inbox({"findings": [{"key": "devtodo:capture-gap", "label": "capture gap",
                          "verdict": "still real", "summary": "card still gone"}]})
    sm._merge_findings("2026-08-04.050001")
    row, = _rows()
    assert row["first_seen"] == "2026-08-03"       # original, not today
    assert row["times_seen"] == 2
    assert row["conv_id"] == "2026-08-04.050001"   # newest investigation
    assert row["verdict"] == "still real"


def test_a_turn_that_wrote_nothing_records_nothing(data_dir):
    """A crashed or refused turn leaves no inbox. That's a no-op, not a
    crash — the orientation in the session log is still hers to read."""
    assert sm._merge_findings("2026-08-04.050001") == 0
    assert _rows() == []


@pytest.mark.parametrize("junk", [
    {"findings": "not a list"},
    {"no_findings_key": []},
    ["a bare list, not an object"],
    {"findings": [{"label": "keyless rows can't dedupe"}]},
    {"findings": [None, 7, "nope"]},
])
def test_malformed_findings_degrade_to_nothing(data_dir, junk):
    """Every shape a confused turn could emit drops quietly. The agent is an
    untrusted writer here; this script owns the record."""
    _inbox(junk)
    assert sm._merge_findings("2026-08-04.050001") == 0
    assert _rows() == []


def test_findings_past_the_ceiling_are_dropped(data_dir):
    """The prompt asks for at most three. A turn returning hundreds is
    confused, and the registry shouldn't inherit the confusion."""
    _inbox({"findings": [{"key": f"devnote:{i}"} for i in range(sm.MAX_FINDINGS + 25)]})
    assert sm._merge_findings("2026-08-04.050001") == sm.MAX_FINDINGS


def test_the_build_queue_resolves_to_the_vault_copy(data_dir, monkeypatch, tmp_path):
    """Regression. The prompt hardcoded `<skeleton>/dev_todo.md`, the file moved
    into the vault, and for two and a half weeks the ritual read one backlog
    while telling itself it read two — silently, because a prompt naming a
    missing path just gets a failed read the model shrugs off."""
    vault = tmp_path / "vault"
    (vault / "tulku").mkdir(parents=True)
    (vault / "dev_todo.md").write_text("queue", encoding="utf-8")
    monkeypatch.setattr(store, "CONTENT_DIR", vault / "tulku")
    assert sm._dev_todo_path() == vault / "dev_todo.md"


def test_build_queue_falls_back_to_the_checkout(data_dir, monkeypatch, tmp_path):
    """A fresh install with no vault copy still gets a usable path rather than
    a path into a directory that isn't there."""
    (tmp_path / "tulku").mkdir()
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "tulku")
    assert sm._dev_todo_path() == Path(sm.SKELETON_CWD) / "dev_todo.md"


def test_clearing_the_inbox_stops_yesterdays_findings_being_rebanked(data_dir):
    """Why _clear_inbox runs BEFORE the turn: otherwise a turn that writes
    nothing today would have yesterday's file merged as today's work, and
    times_seen would climb on a morning nobody looked."""
    _inbox({"findings": [{"key": "devnote:stale-run"}]})
    sm._clear_inbox()
    assert not (store.DATA_DIR / sm.INBOX_NAME).exists()
    assert sm._merge_findings("2026-08-04.050001") == 0
