---
id: page.roster
name: Roster and rooms
kind: feature
parent: page
sources:
  - frontend/src/features/observatory/ObservatoryPage.tsx
  - frontend/src/features/observatory/ObservatoryPage.module.css
  - frontend/src/features/observatory/RosterPage.tsx
  - frontend/src/features/observatory/RosterPage.module.css
  - frontend/src/features/observatory/SessionLane.tsx
  - frontend/src/features/observatory/SessionLane.module.css
  - frontend/src/features/observatory/SessionCard.tsx
  - frontend/src/features/observatory/LaneHead.tsx
  - frontend/src/features/observatory/LaneHead.module.css
  - frontend/src/features/observatory/SavedLane.tsx
  - frontend/src/features/observatory/DoneDrawer.tsx
  - frontend/src/features/observatory/QuestionsCard.tsx
  - frontend/src/features/observatory/QuestionsCard.module.css
  - frontend/src/features/observatory/ArchivePage.tsx
  - frontend/src/features/observatory/ArchivePage.module.css
  - frontend/src/features/observatory/orchestra.ts
  - frontend/src/features/observatory/sessionFilters.ts
  - frontend/src/features/observatory/roomOrder.ts
  - frontend/src/features/observatory/sessionStatus.ts
  - frontend/src/features/observatory/presence.ts
  - frontend/src/features/observatory/useOpenSessions.ts
  - frontend/src/features/observatory/readReceipts.ts
  - frontend/src/features/observatory/parkedReading.ts
  - frontend/src/features/observatory/turnStats.ts
  - frontend/src/features/observatory/useTurnStats.ts
links:
  - depends-on page.api: The roster fetches every session through the shared API calls.
  - calls engine.reading: The roster polls the session list and searches the archive.
  - composes swarms.views: Each room draws its swarm cards beside its session cards.
  - composes nightcrew.review: The roster shows the night crew lane and its door.
  - composes page.chat: The roster opens a session's chat in the session dialog.
  - composes run-queue.window: The roster shows the memory meter, each card's memory chip, and the queue prompt.
  - composes sudo: The roster shows the open sudo requests in orange.
  - composes helpers.jobs: The Helpers door sits at the bottom of the roster.
  - composes linear.room: The Linear door sits on the roster.
  - composes spinoffs.tree: The spinoff tree door sits at the bottom of the roster.
  - composes worktrees.map: The worktree map door sits on the roster.
fingerprint: 86ed870f6e27
written: 2026-10-02
---

The roster is the front of the page. It puts each session card in its room: Personal, Coding, and the rooms behind doors. A card shows the session's state with a color: working, needs input, or idle.

The roster sorts cards so that sessions that wait for the owner come first. It shows open questions on the card, a drawer of finished sessions, and saved sessions. The archive page searches closed sessions.
