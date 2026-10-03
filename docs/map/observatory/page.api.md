---
id: page.api
name: Page API and shared helpers
kind: module
parent: page
sources:
  - frontend/src/features/observatory/api.ts
  - frontend/src/features/observatory/sseFrames.ts
  - frontend/src/features/observatory/sessionLocation.ts
links:
  - calls engine.reading: Reads the roster, one conversation, search and the atlas.
  - calls engine.sessions: Makes sessions and changes their settings.
  - calls spinoffs.door: Reads and answers spinoff offers.
  - calls linear.room: Reads the Linear room, its board and its news.
  - calls worktrees.branches: Wakes a steward on a finished branch.
  - calls helpers.jobs: Lists the button-fired helper runs.
fingerprint: 79c7eca40d38
written: 2026-10-02
---

This file holds the typed HTTP calls of the Observatory page. Most parts of the page reach the server through it. It also holds the shared types for a session, a room and a turn. Two small helpers sit beside it: one reads the server's event stream in frames, and one makes the link that opens a session.
