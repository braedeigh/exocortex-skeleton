#!/usr/bin/env python3
"""Send Coming up reminders into the Keeper's chat at their set time.

**What this does, in plain English.** Once a minute (cron), it asks
`comingup.due_to_fire()` which reminders have reached their `remind_at`, and
for each one puts a short SYSTEM message into the pinned Keeper conversation —
not hers, not the keeper's — telling the Keeper to bring the subject up with
the owner. The chat shows it as a System bubble, the journal records it as an
`S` card saying who set it, and the item is marked `fired` so it never
repeats.

It doesn't wait for anyone: if the Keeper is idle the reminder goes in now;
if it's mid-reply, the reminder waits in the conversation's follow-up queue
and goes in the moment that reply ends (routes/observatory.py, Follow-ups).

Rules, in order:
  - the `enabled` switch on the Automations page (scheduled_runs.json) wins;
  - nothing fires while the 3 AM rollover holds its lock — the pinned Keeper
    is being swapped, and the next minute's run will find the new one;
  - a reminder more than GRACE_MINUTES late is marked `missed`, not sent — a
    6 PM nudge arriving at 2 AM because the machine was asleep is noise, and
    a pile of them after downtime would be worse (same rule as the phone
    push, scripts/todo_push_dispatcher.py);
  - with no pinned Keeper at all, due reminders stay pending and are tried
    again next minute.

Then, as a safety net, it starts any follow-up that's still waiting on an
idle conversation — e.g. an approval whose turn process was killed — and
does the same for the agents' mailbox (peermail.py): a message waiting for a
session that's idle starts its turn here if nothing else did. It also checks
the helpers' watches (watches.py) and wakes a helper whose watch fired. The same
minute also closes finished sessions whose done countdown has run out
(scripts/session_done.py marks them; routes/observatory.py close_done_sessions),
and wakes any session idle for a day to ask itself whether it's done
(idle_check_sessions).

And it wakes a helper whose sessions changed since its last turn — a new
session, or new files read or edited — so it can look; the helper may stay
silent (helper_chat.wake_tick).
Run by cron (the owner wires the crontab):

    * * * * * EXOCORTEX_DATA_DIR=... EXOCORTEX_CONTENT_DIR=... \
        EXOCORTEX_CLAUDE_BIN=... /opt/exocortex/skeleton/venv/bin/python3 \
        /opt/exocortex/skeleton/scripts/coming_up_dispatcher.py >> ...log 2>&1

Touches: `comingup.py` (what's due, marking it), `routes/observatory.py`
(queue_followup / drain_all_followups / drain_all_inbox /
close_done_sessions / idle_check_sessions), `watches.py` (tick), `scripts/keeper_rollover.py` (finding
the pinned Keeper, the rollover lock), `tests/test_coming_up_dispatcher.py`.

Prompt that produced this: "I'm also wanting something that can inject a
Also `helper_chat.py` (wake_tick).
message into the chat to have it talk to me about it. And record that it
wasn't keeper or me but a system injection reminder. But record whether it
was created manually or by the keeper." / "I just want it to inject without
waiting at that time."
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import comingup                                  # noqa: E402
import store                                     # noqa: E402
from routes import observatory as rr            # noqa: E402
from scripts import keeper_rollover             # noqa: E402

RUN_ID = "coming_up_dispatcher"
GRACE_MINUTES = 120


def _log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def _is_enabled():
    """The Automations page's pause switch. Unregistered = enabled."""
    for r in store.read("scheduled_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("id") == RUN_ID:
            return r.get("enabled", True)
    return True


def reminder_message(item):
    """The three texts one reminder turns into: what the model is told, what
    the chat shows, and the S card's body. Kept together so they can't
    disagree about who set it."""
    setter = "the keeper" if item.get("created_by") == "keeper" else "you"
    setter_for_model = ("a previous Keeper" if item.get("created_by") == "keeper"
                        else "the owner")
    when = comingup.when_text(item.get("date", ""), item.get("time", ""),
                               item.get("end_date", ""))
    what = item.get("title", "")
    note = f" {item['note']}" if item.get("note") else ""
    prompt = (
        f"[System reminder — sent by the app, not by the owner and not by you. "
        f"Set by {setter_for_model}.] "
        f"{'Bring up' if item.get('kind') == 'topic' else 'Coming up'}: {what} "
        f"({when}).{note} "
        "Bring this up with the owner now, briefly and in your own words. If "
        "they're not here, say it anyway so it's waiting when they come back."
    )
    display = f"{what} ({when}){note}"
    journal = f"Reminder (set by {setter}): {what} ({when}){note}"
    return prompt, display, journal


def process_due(now=None):
    """One pass. Returns a dict of what happened, for the log and the tests."""
    now = now or datetime.now()
    out = {"fired": [], "missed": [], "waiting": []}
    due = comingup.due_to_fire(now)
    if not due:
        return out
    conv_id, _entry = keeper_rollover._find_pinned(store.read("bot_chats/index", {}))
    for item, due_at in due:
        late_minutes = (now - due_at).total_seconds() / 60
        if late_minutes > GRACE_MINUTES:
            comingup.set_status(item["id"], "missed")
            out["missed"].append(item["id"])
            continue
        if conv_id is None:
            out["waiting"].append(item["id"])
            continue
        prompt, display, journal = reminder_message(item)
        # Mark it fired BEFORE queueing: a crash between the two then costs one
        # reminder, never a reminder sent every minute forever.
        comingup.set_status(item["id"], "fired", fired_at=now.strftime("%Y-%m-%d %H:%M"))
        rr.queue_followup(conv_id, prompt, system={
            "display": display, "journal": journal,
            "source": item.get("created_by", "manual"), "item_id": item["id"]})
        out["fired"].append(item["id"])
    return out


def main():
    if not store.DATA_DIR.exists():
        _log(f"ERROR: DATA_DIR {store.DATA_DIR} missing — is EXOCORTEX_DATA_DIR set?")
        return 1
    # The agents' mailbox safety net (peermail.py) rides this minute tick too,
    # and ahead of the Coming up switch: a message waiting for an idle
    # session has nothing to do with whether reminders are on.
    try:
        woke = rr.drain_all_inbox()
        if woke:
            _log(f"mailbox safety net started {woke} turn(s)")
    except Exception as e:
        _log(f"mailbox drain failed: {e}")
    # Swarm helpers with an update waiting out their interval (swarm_helper.py).
    try:
        import swarm_helper
        ran = swarm_helper.tick()
        if ran:
            _log(f"started {ran} swarm helper run(s)")
    except Exception as e:
        _log(f"swarm helper tick failed: {e}")
    # The room helper, a layer above: forms, joins, splits and releases
    # swarms when something in its room has happened (room_helper.py).
    try:
        import room_helper
        ran = room_helper.tick()
        if ran:
            _log(f"started {ran} room helper run(s)")
    except Exception as e:
        _log(f"room helper tick failed: {e}")
    # The helpers' watches: a watched session did what a helper promised her
    # it would tell her about, so its chat is woken once (watches.py).
    try:
        import watches
        woke = watches.tick()
        if woke:
            _log(f"watches woke {woke} helper(s)")
    except Exception as e:
        _log(f"watch check failed: {e}")
    # Turns whose host process died mid-reply are marked failed here
    # (routes/observatory.py mark_dead_turns), so a red card and an error line
    # land even when nobody has the roster open.
    try:
        dead = rr.mark_dead_turns()
        if dead:
            _log(f"marked {len(dead)} turn(s) whose host died: {', '.join(dead)}")
    except Exception as e:
        _log(f"dead-turn check failed: {e}")
    # Finished sessions whose countdown has run out close here
    # (routes/observatory.py close_done_sessions). Ahead of the Coming up
    # switch for the same reason as the mailbox: it isn't a reminder.
    # The helpers' wake-up: the sessions a helper watches changed since its
    # last turn, so its chat is woken to look — it may stay silent
    # (helper_chat.wake_tick).
    try:
        import helper_chat
        woke = helper_chat.wake_tick()
        if woke:
            _log(f"room changes woke {woke} helper(s)")
    except Exception as e:
        _log(f"helper wake-up check failed: {e}")
    try:
        closed = rr.close_done_sessions()
        if closed:
            _log(f"closed {len(closed)} finished session(s): {', '.join(closed)}")
    except Exception as e:
        _log(f"closing finished sessions failed: {e}")
    # Sessions idle for a day get asked whether they're done
    # (routes/observatory.py idle_check_sessions) — the backstop for the ones
    # that finished without saying so.
    try:
        asked = rr.idle_check_sessions()
        if asked:
            _log(f"idle check woke {len(asked)} session(s): {', '.join(asked)}")
    except Exception as e:
        _log(f"idle check failed: {e}")
    if not _is_enabled():
        return 0
    if keeper_rollover.rollover_running():
        _log("rollover in progress — trying again next minute")
        return 0
    result = process_due()
    for key in ("fired", "missed", "waiting"):
        if result[key]:
            _log(f"{key}: {', '.join(result[key])}")
    started = rr.drain_all_followups()
    if started:
        _log(f"safety net started {started} waiting follow-up(s)")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # cron scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
