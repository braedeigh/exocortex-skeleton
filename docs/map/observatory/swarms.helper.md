---
id: swarms.helper
name: Swarm helper
kind: module
parent: swarms
sources:
  - swarm_helper.py
links:
  - reads swarms.grouping: It reads the swarm's members and which of them it should still watch.
  - reads data.transcripts: It reads what each member did since its last summary.
  - reads data.calls: The closing check finds the members' commits in their tool calls.
  - writes data.swarm-tables: Every run, summary and closing is stored.
  - writes data.index: It makes the helper's own session the first time a swarm needs one.
  - calls engine.delivery: It sends messages to members and posts in its own chat.
  - calls engine.closing: A retired swarm's helper marks itself done.
  - calls helpers.room: The room helper's chat is told when a swarm closes.
  - depends-on swarms.mail: It reads questions sent to it and writes chat lines with the mailbox's helpers.
fingerprint: fdbcb91adb37
written: 2026-10-02
---

Each swarm has one helper session. Its work is short, separate model calls, never one long conversation. One call per changed member writes that member's new summary. One call for the swarm writes its name, its summary, and where members' work collides.

When a swarm retires, the helper writes one closing summary. A closing check built from git and the session records says what was really committed and what is still open. Both are kept and handed to the helper on later turns.
