---
id: helpers.room
name: Room helper
kind: module
parent: helpers
sources:
  - room_helper.py
  - scripts/room_moves.py
links:
  - reads swarms.grouping: It reads the open swarms, their clusters, and the sessions that work alone.
  - calls swarms.grouping: Its moves place sessions into swarms or take them out.
  - reads helpers.file-alerts: Its runs read which files each open session edits.
  - writes data.helper-tables: Every run, move and session summary is stored.
  - writes data.index: It makes the room helper's own session on first need.
  - writes data.transcripts: It posts each move in its own chat.
  - calls engine.delivery: Each moved session gets one message at the end of its turn.
  - depends-on swarms.helper: It uses the swarm helper's model call.
  - depends-on engine.sessions: It finds each session's room with the lanes rule.
  - depends-on swarms.mail: It writes its posts with the mailbox's line writer.
fingerprint: cd22b42c75f6
written: 2026-10-02
---

The room helper looks at a whole room from above. It reads only summaries: each open swarm, its members, its clusters, and each session that works alone. It runs at most every few minutes, and only when something in the room happened.

It makes four moves: form a swarm, join sessions to one, split a cluster out, and release sessions to work alone. Every move is stored with what it replaced, posted in its chat with a reason, and can be undone with the room_moves.py script.
