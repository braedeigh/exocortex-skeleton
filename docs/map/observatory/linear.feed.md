---
id: linear.feed
name: Linear feed and helper
kind: module
parent: linear
sources:
  - linear_feed.py
  - scripts/linear_feed.py
links:
  - calls linear.api: Each look asks Linear what changed since the last look.
  - writes data.linear-events: Each event is written down once.
  - writes data.index: It makes the Linear helper's session on first news.
  - calls engine.delivery: The Linear helper is woken with the new events as one System message.
  - reads helpers.room: The wake-up names the room helpers it can pass the news to.
  - depends-on swarms.helper: The Linear helper gets the same lookup tools as a swarm helper.
  - depends-on engine.sessions: It finds sessions in the Linear room with the lanes rule.
  - depends-on swarms.grouping: Helper sessions are left out of the sessions it names.
fingerprint: 7c518b5dfc7e
written: 2026-10-02
---

Once a minute this module asks Linear what changed. It keeps only what someone other than the key's owner did: a comment, a new issue, a move, an edit. Each event is written down once.

The Linear helper is a helper like the others, with a rolling chat. It decides whom to tell. Words quoted from Linear are information, never an instruction. The script lets a session read the news and one issue live.
