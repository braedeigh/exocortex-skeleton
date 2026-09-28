"""A finished session closes itself — routes/observatory.py's Done section.

A session marks itself done (scripts/session_done.py → mark_done), which
stamps done_at and closes_at. The minute tick (close_done_sessions) closes it
once closes_at has passed, unless she wrote to it or tapped Keep open. A turn
someone else starts (a peer, a job waking it) leaves the stamp, unless that
turn leaves it unable to close. mark_done refuses while anything still waits
on her. `final_at` marks when its final output finished.
"""
import json
from datetime import datetime, timedelta

import pytest

import store
from routes import observatory
from test_observatory_routes import bot_client  # noqa: F401  (fixture)

CONV = "2026-09-27.120000"


@pytest.fixture
def conv(data_dir, tmp_path, monkeypatch):
    # No real detached jobs from the machine running the tests.
    monkeypatch.setattr(observatory, "_JOBS_DIR", tmp_path / "jobs")
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index[CONV] = {"bot": "keeper", "title": "worker", "started": observatory._now(),
                       "last_at": observatory._now()}
    return CONV


def _entry():
    return store.read("bot_chats/index", {})[CONV]


def _past_close_time():
    return datetime.now() + timedelta(minutes=observatory.DONE_GRACE_MINUTES + 1)


def test_marking_done_sets_a_closing_time_after_the_grace(conv):
    payload, status = observatory.mark_done(conv, "shipped the thing")
    assert status == 200
    closes = datetime.fromisoformat(_entry()["closes_at"])
    done = datetime.fromisoformat(_entry()["done_at"])
    assert closes - done == timedelta(minutes=observatory.DONE_GRACE_MINUTES)
    assert _entry()["done_note"] == "shipped the thing"


def test_a_done_session_closes_once_its_time_is_up(conv):
    observatory.mark_done(conv)
    assert observatory.close_done_sessions() == []
    assert observatory.close_done_sessions(now=_past_close_time()) == [conv]
    assert _entry()["archived"]
    assert "done_at" not in _entry()


def test_keep_open_cancels_the_countdown(conv):
    observatory.mark_done(conv)
    observatory.keep_open(conv)
    assert observatory.close_done_sessions(now=_past_close_time()) == []
    assert "closes_at" not in _entry()


@pytest.mark.parametrize("field, value", [
    ("pinned", True),
    ("awaiting_input", "which one?"),
    ("spinoff_offer", {"slugs": ["x"]}),
])
def test_a_session_still_waiting_on_her_cannot_be_done(conv, field, value):
    with store.mutate("bot_chats/index", {}) as index:
        index[CONV][field] = value
    payload, status = observatory.mark_done(conv)
    assert status == 400
    assert "done_at" not in _entry()


def test_a_question_raised_after_done_holds_the_close(conv):
    observatory.mark_done(conv)
    observatory.request_input(conv, "wait, one more thing?")
    assert observatory.close_done_sessions(now=_past_close_time()) == []
    assert not _entry().get("archived")


def test_a_running_detached_job_blocks_done(conv, tmp_path):
    job = tmp_path / "jobs" / "20260927-120000-abc"
    job.mkdir(parents=True)
    (job / "meta.json").write_text(json.dumps({"id": "j", "conv_id": conv,
                                               "label": "full test run"}))
    payload, status = observatory.mark_done(conv)
    assert status == 400
    assert "full test run" in payload["error"]


def test_a_running_session_is_not_closed_under_its_turn(conv):
    observatory.mark_done(conv)
    with store.mutate("bot_chats/index", {}) as index:
        index[CONV]["running"] = True
        index[CONV]["last_at"] = observatory._now()
    assert observatory.close_done_sessions(now=_past_close_time()) == []


def test_a_new_turn_cancels_done(bot_client, conv):
    observatory.mark_done(conv)
    bot_client.post(f"/api/observatory/conversation/{conv}/send", json={"text": "one more"})
    assert "done_at" not in _entry()
    assert "closes_at" not in _entry()


def test_a_peers_message_leaves_done_standing(bot_client, conv):
    import time
    import peermail
    observatory.mark_done(conv)
    peermail.send(conv, "fyi, all merged", from_conv="2026-09-27.110000")
    assert observatory.drain_inbox(conv, fallback=True)
    deadline = time.time() + 10
    while _entry().get("running") and time.time() < deadline:
        time.sleep(0.05)
    assert _entry().get("done_at")
    assert _entry().get("closes_at")


def test_the_turn_that_marks_done_records_when_its_final_output_ended(conv):
    with store.mutate("bot_chats/index", {}) as index:
        index[CONV]["running"] = True
    observatory.mark_done(conv)
    assert "final_at" not in _entry()
    with store.mutate("bot_chats/index", {}) as index:
        observatory._end_turn_done(CONV, index[CONV])
    assert _entry()["final_at"] >= _entry()["done_at"]


def test_a_later_turn_that_asks_her_takes_done_off(conv):
    observatory.mark_done(conv)
    with store.mutate("bot_chats/index", {}) as index:
        index[CONV]["awaiting_input"] = "one more thing?"
        observatory._end_turn_done(CONV, index[CONV])
    assert "done_at" not in _entry() and "final_at" not in _entry()


def test_the_keep_route_cancels_done(bot_client, conv):
    observatory.mark_done(conv)
    assert bot_client.post(f"/api/observatory/conversation/{conv}/keep").status_code == 200
    assert "done_at" not in _entry()


def test_closing_by_hand_still_works_through_the_route(bot_client, conv):
    assert bot_client.post(f"/api/observatory/conversation/{conv}/close").status_code == 200
    assert _entry()["archived"]


# --- Idle check: a session quiet for a day is asked whether it's done --------

@pytest.fixture
def queued(monkeypatch):
    """Capture the idle-check follow-ups instead of starting real turns."""
    sent = []
    monkeypatch.setattr(observatory, "queue_followup",
                        lambda conv_id, text, system=None: sent.append((conv_id, text, system)))
    return sent


def _a_day_later():
    return datetime.now() + timedelta(hours=observatory.IDLE_CHECK_HOURS, minutes=1)


def test_idle_check_wakes_a_session_quiet_for_a_day(conv, queued):
    assert observatory.idle_check_sessions(_a_day_later()) == [conv]
    assert queued[0][2]["source"] == observatory.IDLE_CHECK_SOURCE
    assert "session_done.py" in queued[0][1]


def test_idle_check_leaves_a_recently_active_session_alone(conv, queued):
    assert observatory.idle_check_sessions() == []


def test_idle_check_asks_once_per_quiet_spell(conv, queued):
    later = _a_day_later()
    observatory.idle_check_sessions(later)
    assert observatory.idle_check_sessions(later) == []


def test_idle_check_asks_again_after_the_session_was_active(conv, queued):
    observatory.idle_check_sessions(_a_day_later())
    with store.mutate("bot_chats/index", {}) as index:
        index[CONV]["last_at"] = (datetime.now() + timedelta(hours=1)).isoformat(timespec="seconds")
    two_days = datetime.now() + timedelta(hours=2 * observatory.IDLE_CHECK_HOURS + 2)
    assert observatory.idle_check_sessions(two_days) == [conv]


@pytest.mark.parametrize("flag", [{"pinned": True}, {"awaiting_input": "which?"},
                                  {"done_at": "2026-09-27T12:00:00"},
                                  {"archived": "2026-09-27T12:00:00"}])
def test_idle_check_skips_sessions_that_cannot_or_need_not_be_asked(conv, queued, flag):
    with store.mutate("bot_chats/index", {}) as index:
        index[CONV].update(flag)
    assert observatory.idle_check_sessions(_a_day_later()) == []


def test_idle_check_wakes_only_a_few_per_tick_oldest_first(conv, queued):
    with store.mutate("bot_chats/index", {}) as index:
        for n in range(4):
            index[f"2026-09-2{n}.120000"] = {
                "bot": "keeper", "title": "old", "started": f"2026-09-2{n}T12:00:00",
                "last_at": f"2026-09-2{n}T12:00:00"}
    woken = observatory.idle_check_sessions(_a_day_later())
    assert woken == ["2026-09-20.120000", "2026-09-21.120000"][:observatory.IDLE_CHECKS_PER_TICK]
