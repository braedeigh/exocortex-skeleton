---
id: engine.reading
name: Roster and reading
kind: feature
parent: engine
links:
  - reads data.index: The roster lists every session from the index.
  - reads data.transcripts: A chat reads the transcript and tails the live sidecar.
  - reads data.calls: The inbox status says which step a running turn is on.
fingerprint: 
written: 2026-10-02
---

This part answers the page's read requests. It gives the roster of every session with its room, state and last ask. It gives one conversation, its activity, and a search over the archive.

A watcher follows a turn by reading the transcript file and the live sidecar beside it. So any number of browsers can watch one turn, and a watcher can join in the middle. The watcher never owns the turn.
