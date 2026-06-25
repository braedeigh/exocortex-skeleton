"""Habit cadence ladder: daily → weekly → monthly → retired.

Promotion is suggested/user-tapped (the promote() call); demotion is automatic in
reconcile() when a spot-check window closes unfulfilled. State is an overlay keyed
by the same 'section|text' log key, so plain daily habits are simply absent.
"""
from datetime import date, timedelta

import pytest

import store
import habit_cadence as hc

KEY = "morning|Chia seeds in a glass of water"
SECTION, TEXT = "Morning", "Chia seeds in a glass of water"
TODAY = date(2026, 6, 25)


@pytest.fixture(autouse=True)
def frozen(data_dir, monkeypatch):
    """Freeze 'today' and make scheduling deterministic (+7 days) for assertions."""
    monkeypatch.setattr(hc, "_today", lambda: TODAY)
    monkeypatch.setattr(hc.random, "randint", lambda lo, hi: 7)


def write_cadence(entry):
    store.write(hc.CADENCE_FILE, {KEY: entry})


# --- promotion (user-tapped) ---

def test_promote_walks_the_whole_ladder():
    hc.promote(SECTION, TEXT)
    assert store.read(hc.CADENCE_FILE)[KEY]["stage"] == "weekly"
    hc.promote(SECTION, TEXT)
    assert store.read(hc.CADENCE_FILE)[KEY]["stage"] == "monthly"
    hc.promote(SECTION, TEXT)
    c = store.read(hc.CADENCE_FILE)[KEY]
    assert c["stage"] == "retired"
    assert c["next_check"] is None          # retired habits get no more checks
    hc.promote(SECTION, TEXT)               # nowhere left to go — stays retired
    assert store.read(hc.CADENCE_FILE)[KEY]["stage"] == "retired"


def test_promote_to_weekly_schedules_a_future_check():
    hc.promote(SECTION, TEXT)
    c = store.read(hc.CADENCE_FILE)[KEY]
    assert c["passes"] == 0
    assert c["next_check"] == (TODAY + timedelta(days=7)).isoformat()


# --- reconcile: passing a spot-check ---

def test_passed_check_increments_passes_and_reschedules():
    write_cadence({"stage": "weekly", "passes": 1, "next_check": "2026-06-20"})
    log = {"2026-06-20": {KEY: True}}        # done on the check day; window now closed
    out = hc.reconcile(log)
    assert out[KEY]["passes"] == 2
    assert out[KEY]["next_check"] == (TODAY + timedelta(days=7)).isoformat()


def test_completion_during_grace_day_still_counts_as_pass():
    write_cadence({"stage": "weekly", "passes": 0, "next_check": "2026-06-23"})
    log = {"2026-06-24": {KEY: True}}        # a day late, but within the lenient window
    out = hc.reconcile(log)
    assert out[KEY]["passes"] == 1


# --- reconcile: missing a spot-check demotes automatically ---

def test_missed_weekly_check_falls_back_to_plain_daily():
    write_cadence({"stage": "weekly", "passes": 2, "next_check": "2026-06-20"})
    out = hc.reconcile({})                   # nothing logged in the window
    assert KEY not in out                    # back to a plain daily habit


def test_missed_monthly_check_falls_back_to_weekly():
    write_cadence({"stage": "monthly", "passes": 2, "next_check": "2026-06-20"})
    out = hc.reconcile({})
    assert out[KEY]["stage"] == "weekly"
    assert out[KEY]["passes"] == 0
    assert out[KEY]["next_check"] == (TODAY + timedelta(days=7)).isoformat()


# --- reconcile: open / pending checks are left alone ---

def test_check_due_today_is_left_pending():
    write_cadence({"stage": "weekly", "passes": 1, "next_check": TODAY.isoformat()})
    out = hc.reconcile({})
    assert out[KEY]["next_check"] == TODAY.isoformat()
    assert out[KEY]["passes"] == 1


def test_future_check_untouched_and_nothing_persisted_when_unchanged():
    write_cadence({"stage": "weekly", "passes": 0, "next_check": "2026-07-10"})
    out = hc.reconcile({})
    assert out[KEY]["next_check"] == "2026-07-10"


# --- restore ---

def test_restore_returns_a_habit_to_daily():
    write_cadence({"stage": "monthly", "passes": 1, "next_check": "2026-07-10"})
    hc.restore(SECTION, TEXT)
    assert store.read(hc.CADENCE_FILE) == {}


# --- HTTP contract ---

def test_promote_and_restore_endpoints():
    from flask import Flask
    from routes import habits
    app = Flask(__name__)
    app.config.update(TESTING=True)
    habits.register(app)
    c = app.test_client()

    c.post("/api/habits/cadence/promote", json={"habit": TEXT, "section": SECTION})
    assert store.read(hc.CADENCE_FILE)[KEY]["stage"] == "weekly"
    c.post("/api/habits/cadence/restore", json={"habit": TEXT, "section": SECTION})
    assert store.read(hc.CADENCE_FILE) == {}
