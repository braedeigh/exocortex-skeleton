---
id: helpers.watches
name: Watches
kind: module
parent: helpers
sources:
  - watches.py
  - scripts/helper_watch.py
links:
  - writes data.helper-tables: Each watch is a row, marked fired or retired.
  - reads data.transcripts: The check reads what the session did after the watch was set.
  - calls engine.delivery: A fired watch wakes the helper's chat with one System message.
  - calls swarms.continuation: A watch follows its session into a continuation.
fingerprint: 76fb41ac7476
written: 2026-10-02
---

A watch is a promise a helper made, written down. The helper sets one with the helper_watch.py script. It names a session and the events to wait for: done, asked, committed, stalled or error.

The minute tick checks every open watch. When one fires, it is marked fired first, and then the helper's chat is woken. Each watch fires once and expires after a week.
