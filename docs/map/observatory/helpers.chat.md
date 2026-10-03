---
id: helpers.chat
name: Helper chat and its seed
kind: module
parent: helpers
sources:
  - helper_chat.py
links:
  - reads swarms.grouping: The seed lists the active sessions the helper watches.
  - reads helpers.file-alerts: The seed lists every file each session edited and read.
  - reads helpers.watches: The helper's open watches are part of its seed.
  - reads linear.feed: The Linear helper's seed carries the recent Linear news.
  - reads swarms.helper: A swarm helper's seed carries the swarm's closing summaries.
  - reads data.transcripts: The seed replays the owner's last exchanges with the helper.
  - writes data.transcripts: The seed, its parts and what the helper has seen are kept beside the transcripts.
  - calls engine.turns: A wake-up starts a helper turn when its sessions changed.
fingerprint: 6004cd8c4ca1
written: 2026-10-02
---

A helper's chat is one conversation for the helper's whole life. Each turn is a fresh model session, seeded with a document. The document has three parts: the helper's job and the owner's standing rules, the owner's last fifteen exchanges with it, and one entry per active session.

The minute tick wakes a helper when the sessions it watches change. The helper may stay silent, and then its card shows no unread mark. The full transcript stays on disk.
