---
id: linear.room
name: Linear room page
kind: feature
parent: linear
sources:
  - routes/linear_room.py
  - frontend/src/features/observatory/LinearDoor.tsx
  - frontend/src/features/observatory/LinearPage.tsx
  - frontend/src/features/observatory/LinearBoard.tsx
  - frontend/src/features/observatory/LinearBoard.module.css
  - frontend/src/features/observatory/LinearNews.tsx
  - frontend/src/features/observatory/linearNewsSeen.ts
links:
  - calls linear.api: The board and its changes go through the API client.
  - reads linear.feed: The news list reads the events the feed wrote down.
  - writes data.index: Work on an issue opens a Linear-room session.
  - calls spinoffs.runner: The new session's first message is posted by the runner.
  - composes page.chat: The page opens a new session in the session dialog.
  - depends-on page.api: The page's Linear calls live in the shared API file.
  - depends-on engine.sessions: A new Linear session gets the room profile and model choices from the engine.
fingerprint: 60b082c09a8e
written: 2026-10-04
---

These routes list the Linear room's sessions and show Linear itself. The page shows the board, lets the owner move, assign and comment on issues, and save the key. A new-in-Linear list sits at the top, with a count on the door.

A Work button on an issue opens a session in the Linear room, briefed with that issue.
