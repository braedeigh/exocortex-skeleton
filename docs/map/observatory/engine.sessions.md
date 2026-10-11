---
id: engine.sessions
name: Making sessions and rooms
kind: feature
parent: engine
sources:
  - lanes.py
links:
  - writes data.index: A new session is a new entry in the session index.
  - calls spinoffs.door: The fork button hands a long session's work to a fresh spinoff.
  - calls swarms.grouping: A session started from a swarm's page joins that swarm.
  - depends-on worktrees.copies: A session's ground can be a worktree, and the doc guard must know it.
fingerprint: cba3cd445f5d
written: 2026-10-02
---

This part makes a new session and gives it its settings. The settings are the working folder, the tools, the model and the extra system prompt. A session keeps its working folder for its whole life, because Claude Code can resume a conversation only from the folder it started in.

Every session belongs to one room, also called a lane. The room sets the working folder and whether the session must stop and ask. Personal, Coding, Research and Linear are watched rooms and do not ask. Orchestra is the unwatched room and asks before risky actions. The rule that finds the room of an old session lives in lanes.py.
