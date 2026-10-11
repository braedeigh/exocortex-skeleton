---
id: nightcrew.run
name: Overnight run
kind: script
parent: nightcrew
sources:
  - scripts/nightcrew_run.py
  - tools/nightcrew/
links:
  - calls engine.turns: Each worker turn uses the engine's spawn and turn loop directly.
  - writes data.index: Each attempt is an Observatory session.
  - writes data.transcripts: Each worker's turn is written as a transcript.
  - writes data.queue-files: One run record per attempt.
fingerprint: 04ade162ade1
written: 2026-10-02
---

Cron starts this script at night. It picks the notes the owner approved and, at the current setting, proposes a few more as picks without working them. For each note it makes a worktree, lets an agent fix the note there, and runs the tests itself.

The crew cannot ask the owner, so it never touches the live checkout. A worker that finds a note unclear changes nothing and leaves questions on the note.
