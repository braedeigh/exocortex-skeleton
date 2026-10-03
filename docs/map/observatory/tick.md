---
id: tick
name: Minute tick
kind: script
order: 14
sources:
  - scripts/coming_up_dispatcher.py
links:
  - calls engine.delivery: It drains every follow-up queue and every mailbox as a safety net.
  - calls engine.closing: It closes sessions whose done countdown ended and sends idle checks.
  - calls engine.turns: It marks turns dead when their processes are gone.
  - calls swarms.helper: It runs the swarm helpers' tick and the closing of retired swarms.
  - calls helpers.room: It lets the room helper run when the room changed.
  - calls helpers.file-alerts: It looks for sessions that work in the same file.
  - calls helpers.watches: It checks every open watch.
  - calls helpers.chat: It wakes helpers whose sessions changed.
  - calls linear.feed: It asks Linear what changed.
fingerprint: d04aae4036be
written: 2026-10-02
---

Cron runs this script every minute. One job sends the Coming up reminders, which are outside the Observatory. The other jobs keep the Observatory moving when nothing else starts a turn.

Each job runs on its own. A failure in one job does not stop the others.
