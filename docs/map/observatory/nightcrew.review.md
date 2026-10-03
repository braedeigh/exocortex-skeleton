---
id: nightcrew.review
name: Morning review
kind: feature
parent: nightcrew
sources:
  - routes/nightcrew.py
  - frontend/src/features/observatory/NightCrewDoor.tsx
  - frontend/src/features/observatory/NightCrewLane.tsx
  - frontend/src/features/observatory/NightCrewPage.tsx
  - frontend/src/features/observatory/NightCrewPage.module.css
  - frontend/src/features/observatory/NightCrew.module.css
  - frontend/src/features/nightcrew/
links:
  - reads data.queue-files: The cards come from the night run records.
  - depends-on worktrees.branches: A card shows its branch's evidence from the branch routes.
  - depends-on engine.turns: A card's running state uses the engine's liveness check.
  - calls worktrees.branches: A reply on a card wakes a steward on its branch.
  - depends-on nightcrew.run: Which notes are eligible is decided by the crew's triage tool.
  - depends-on page.api: The steward call lives in the shared API file.
  - composes page.roster: The night crew lane uses the roster's lane head.
fingerprint: add183bdff27
written: 2026-10-02
---

The morning review shows one card per night attempt. The owner can merge a fix, and it goes live by itself. A merged card can revert exactly that merge.

The owner can also approve notes for the crew, judge its picks, and give feedback on a run.
