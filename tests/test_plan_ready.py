"""The plan-ready mark (routes/observatory.py mark_plan_ready, scripts/plan_ready.py).

A /spinoff planning session marks its posted plan ready for her go; the roster
card turns purple with "plan: <summary>". These walk a real planning session
(started through her Go, as test_spinoff_routes.py does) through the mark's
life: set by the planner, taken off by her message (with the agent told),
kept as a summary under the build Go card, cleared by her approval, and
holding the session open for a day at most.
"""
import json
from datetime import datetime, timedelta

import store
from routes import observatory, spinoff
from scripts import plan_ready
from tests.test_spinoff_routes import (  # noqa: F401  (spinoff_client is a fixture)
    _approve, _index, _planned, spinoff_client)


def _mark(monkeypatch, conv_id, summary):
    """Run the planner's door the way a turn does: its id in the environment."""
    monkeypatch.setenv("EXOCORTEX_CONV_ID", conv_id)
    code = plan_ready.main([summary])
    monkeypatch.delenv("EXOCORTEX_CONV_ID")
    return code


def test_a_planner_marks_its_plan_ready_and_the_chat_keeps_the_line(spinoff_client, monkeypatch):
    planner = _planned(spinoff_client, monkeypatch)
    assert _mark(monkeypatch, planner, "  Paint the pond blue;\n one file.  ") == 0
    entry = _index()[planner]
    assert entry["plan_ready"]["summary"] == "Paint the pond blue; one file."
    assert entry["plan_summary"] == "Paint the pond blue; one file."
    lines = [json.loads(line) for line in
             (store.DATA_DIR / "bot_chats" / f"{planner}.jsonl").read_text().splitlines()]
    assert lines[-1]["type"] == "plan-ready" and lines[-1]["summary"].startswith("Paint")
    # Marking again replaces the summary.
    _mark(monkeypatch, planner, "Paint it green instead")
    assert _index()[planner]["plan_summary"] == "Paint it green instead"


def test_only_a_planning_session_can_mark_a_plan_ready(spinoff_client, monkeypatch):
    sender = _planned(spinoff_client, monkeypatch)
    builder_like = _index()[sender]["spawned_from"]   # the ordinary session that offered it
    assert _mark(monkeypatch, builder_like, "a plan") == 1
    assert "plan_ready" not in _index()[builder_like]
    assert _mark(monkeypatch, sender, "   ") == 2


def test_her_message_takes_the_mark_off_and_tells_the_agent(spinoff_client, monkeypatch):
    planner = _planned(spinoff_client, monkeypatch)
    _mark(monkeypatch, planner, "Paint the pond blue")
    told = []
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, *a, **k: told.append(text) or True)
    assert observatory.begin_turn(planner, "make it green")["ok"]
    entry = _index()[planner]
    assert "plan_ready" not in entry and entry["plan_summary"] == "Paint the pond blue"
    assert told[0].startswith("make it green") and "plan_ready.py" in told[0]


def test_the_build_card_keeps_the_summary_and_her_go_clears_the_mark(spinoff_client, monkeypatch):
    planner = _planned(spinoff_client, monkeypatch)
    _mark(monkeypatch, planner, "Paint the pond blue")
    body = _approve(spinoff_client, monkeypatch, planner)
    assert body["closed_source"] is True
    entry = _index()[planner]
    assert "plan_ready" not in entry and entry["plan_summary"] == "Paint the pond blue"


def test_a_ready_plan_holds_the_session_open_for_a_day_or_until_a_builder_exists(
        spinoff_client, monkeypatch):
    planner = _planned(spinoff_client, monkeypatch)
    _mark(monkeypatch, planner, "Paint the pond blue")
    payload, status = observatory.mark_done(planner)
    assert status == 400 and "plan waiting" in payload["error"]
    # A day and an hour later it no longer blocks the close.
    with store.mutate("bot_chats/index", {}) as index:
        old = datetime.now() - timedelta(hours=observatory.IDLE_CHECK_HOURS + 1)
        index[planner]["plan_ready"]["at"] = old.isoformat(timespec="seconds")
    assert observatory.mark_done(planner)[1] == 200
    # A fresh mark, with a builder already started from it, doesn't block either.
    observatory.keep_open(planner)
    _mark(monkeypatch, planner, "Paint the pond blue")
    with store.mutate("bot_chats/index", {}) as index:
        index["2026-10-23.120000"] = {"title": "spin: pond-colour", "planned_in": planner}
    assert observatory.mark_done(planner)[1] == 200
