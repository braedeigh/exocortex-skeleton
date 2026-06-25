"""Habit cadence ladder — proven daily habits graduate to occasional spot-checks.

A habit climbs **daily → weekly → monthly → retired**. The idea: once something is
genuinely automatic (done ~60×), it doesn't need to sit in the daily list forever.
It graduates to an occasional spot-check on a *random* day; pass the checks and it
keeps climbing until it retires off the list entirely.

Two deliberate asymmetries:
  - **Promotion is suggested** — the UI flags "ready to graduate"; nothing moves
    until Bradie taps it (see the /api/habits/cadence/promote route).
  - **Demotion is automatic** — miss a spot-check and the habit falls back one rung
    on its own, so nothing silently slips off the list. That's the safety net.

State lives in ``habit_cadence.json``, keyed by the same ``'section|text'`` key as
``habits_log.json`` (see data_helpers.habit_log_key). Plain daily habits are simply
*absent* from the file — the whole feature is an overlay that never touches
HABITS.md or the existing log/move/rename machinery.
"""
from datetime import date, datetime, timedelta
import random

import store
from data_helpers import habit_log_key

CADENCE_FILE = "habit_cadence.json"

# Tunables, surfaced to the frontend (see CONFIG below) so thresholds live in one
# place and the JS never hard-codes a magic number that can drift from the server.
CONFIG = {
    "graduate_count": 60,         # lifetime completions before daily→weekly is offered
    "graduate_recent": [24, 30],  # AND ≥24 of the last 30 days (must still be consistent NOW,
                                  # so a long-dormant habit's stale lifetime count can't re-nag)
    "weekly_to_monthly": 4,       # weekly spot-checks passed before monthly is offered
    "monthly_to_retire": 3,       # monthly spot-checks passed before retirement is offered
    "grace_days": 1,              # extra day(s) a spot-check stays open before a miss counts
}

# Random spacing between spot-checks (inclusive day range from the check that just
# passed / the graduation). Jittered so the check lands on a genuinely random day.
_GAP = {"weekly": (5, 9), "monthly": (25, 35)}

_GRACE = CONFIG["grace_days"]
_GRADUATED = ("weekly", "monthly")


def _today():
    return date.today()


def _parse(d):
    return datetime.strptime(d, "%Y-%m-%d").date()


def _schedule(stage, frm=None):
    """A random next-check date string for `stage`, measured from `frm` (default today)."""
    lo, hi = _GAP[stage]
    return ((frm or _today()) + timedelta(days=random.randint(lo, hi))).isoformat()


def _logged_between(log, key, start, end):
    """True if the habit was completed on any date in [start, end) (date objects)."""
    d = start
    while d < end:
        if log.get(d.isoformat(), {}).get(key):
            return True
        d += timedelta(days=1)
    return False


def reconcile(log, cadence=None, persist=True):
    """Advance every graduated habit's spot-check state against the completion log.

    For each weekly/monthly habit whose check window (check day + grace) has fully
    closed: a completion anywhere in the window is a PASS (accrues toward the next
    rung and reschedules the next check); an empty window is a MISS (demote one
    rung — weekly falls back to plain daily, monthly falls back to weekly).

    Returns the (possibly mutated) cadence dict. Safe to call on every data load.
    """
    if cadence is None:
        cadence = store.read(CADENCE_FILE, {})
    today = _today()
    changed = False
    for key in list(cadence.keys()):
        c = cadence[key]
        stage = c.get("stage")
        if stage not in _GRADUATED:
            continue
        nc = c.get("next_check")
        if not nc:                       # shouldn't happen, but self-heal
            c["next_check"] = _schedule(stage)
            changed = True
            continue
        # Still pending or within the grace window — leave it be.
        if _parse(nc) > today - timedelta(days=_GRACE + 1):
            continue
        if _logged_between(log, key, _parse(nc), today):
            c["passes"] = c.get("passes", 0) + 1
            c["next_check"] = _schedule(stage, frm=today)
        elif stage == "weekly":
            del cadence[key]             # back to a plain daily habit (reappears in the list)
        else:                           # monthly miss → fall back to weekly
            c["stage"] = "weekly"
            c["passes"] = 0
            c["next_check"] = _schedule("weekly", frm=today)
        changed = True
    if persist and changed:
        store.write(CADENCE_FILE, cadence)
    return cadence


# Where each stage advances to when promoted (the user-tapped direction).
_PROMOTE = {"daily": "weekly", "weekly": "monthly", "monthly": "retired"}


def promote(section, text, cadence=None):
    """Advance one rung up the ladder (suggested promotion, user-confirmed)."""
    key = habit_log_key(section, text)
    if cadence is None:
        cadence = store.read(CADENCE_FILE, {})
    cur = cadence.get(key, {}).get("stage", "daily")
    nxt = _PROMOTE.get(cur)
    if not nxt:
        return cadence                  # already retired — nowhere to go
    today = _today().isoformat()
    cadence[key] = {
        "stage": nxt,
        "passes": 0,
        "next_check": _schedule(nxt) if nxt in _GRADUATED else None,
        "since": today,
    }
    store.write(CADENCE_FILE, cadence)
    return cadence


def restore(section, text, cadence=None):
    """Bring a habit all the way back to plain daily (un-graduate / un-retire)."""
    key = habit_log_key(section, text)
    if cadence is None:
        cadence = store.read(CADENCE_FILE, {})
    if key in cadence:
        del cadence[key]
        store.write(CADENCE_FILE, cadence)
    return cadence
