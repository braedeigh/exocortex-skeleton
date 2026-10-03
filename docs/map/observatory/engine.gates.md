---
id: engine.gates
name: Guards and the approval gate
kind: feature
parent: engine
sources:
  - tools/act_ask_gate.py
  - tools/helper_gate.py
links:
  - writes data.transcripts: An approval is kept in a sidecar file per session.
  - calls detached: Every session with Bash carries the hook that turns background commands into detached jobs.
  - calls helpers.file-alerts: The file alert hook is wired in here, and it is switched off by default.
fingerprint: 6589f4a73153
written: 2026-10-02
---

This part decides what a session may do without the owner. It gives each turn one settings payload. The payload holds a deny list for the hand-written doc files, and hooks that run before tool calls.

The act-or-ask gate lets reversible actions through and stops risky ones in unwatched rooms. A stopped command shows an approval card, and the owner approves or denies it. The helper gate lets a helper only look things up. These are guard rails against mistakes, not locks.
