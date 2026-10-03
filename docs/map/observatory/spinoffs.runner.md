---
id: spinoffs.runner
name: Spinoff runner
kind: script
parent: spinoffs
sources:
  - scripts/spinoff_runner.py
links:
  - calls engine.turns: It posts the kickoff through the real send route and waits for the turn.
fingerprint: f689b16bff97
written: 2026-10-02
---

The runner sends a new session's first message, so nobody has to open it. It builds a bare web app with only the Observatory routes and posts the kickoff through the real send route. It stays alive until the turn ends.

The spinoff door and the run dispatcher both start it, detached. The kickoff also stays staged on the session, so opening the session still starts it if the runner never ran.
