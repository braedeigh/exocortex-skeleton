---
id: swarms.continuation
name: Self-continuing sessions
kind: module
parent: swarms
sources:
  - continuation.py
links:
  - reads data.index: It reads each session's context size and model.
  - calls engine.delivery: It asks the agent for its handoff with a System follow-up.
  - calls spinoffs.door: The handoff opens a fresh session that starts on its own.
  - reads swarms.grouping: The fresh session is told its swarm and the swarm's summary.
  - depends-on engine.sessions: Only rooms on the continue list hand off, found by the lanes rule.
fingerprint: 0730f5a83d47
written: 2026-10-02
---

Each model has a soft cap on context size. A Coding session over its cap is never stopped. When its turn ends, the app asks it to write a handoff.

The handoff opens a fresh session. The fresh session gets the handoff, the files the old one touched, and its swarm's summary. The old session is archived after its last reply and is linked as the new one's parent.
