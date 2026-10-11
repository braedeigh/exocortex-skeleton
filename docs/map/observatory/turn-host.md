---
id: turn-host
name: Turn host
kind: script
order: 3
sources:
  - scripts/turn_host.py
links:
  - hosts agent: The turn host starts the claude process and holds it for the whole reply.
  - calls engine.turns: It runs the one turn loop, imported from the engine.
  - calls engine.delivery: When the turn ends it runs after_turn, then the follow-ups, then the mailbox.
  - writes data.index: It records its own process and clears the running mark at the end.
  - writes data.transcripts: It writes the transcript and the live sidecar of the turn.
fingerprint: d75c9d131bc1
written: 2026-10-02
---

The turn host is the process that a turn lives in. The engine starts it in a session of its own, so it does not belong to a web worker. A reload of the web server or a worker recycle does not stop the turn. A full restart of the service still stops it.

The turn host reads a job file, starts the agent, and runs the turn loop. It checks for the Stop button every two seconds. At the end it starts whatever waits for the session.
