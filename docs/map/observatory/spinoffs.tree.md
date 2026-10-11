---
id: spinoffs.tree
name: Spinoff tree
kind: feature
parent: spinoffs
sources:
  - frontend/src/features/observatory/SpinoffTreeDoor.tsx
  - frontend/src/features/observatory/SpinoffTreePage.tsx
  - frontend/src/features/observatory/SpinoffTreePage.module.css
  - frontend/src/features/observatory/spinoffTree.ts
  - scripts/backfill_spawned_from.py
links:
  - calls spinoffs.door: The tree page reads the family tree from the spinoff routes.
  - writes data.index: The backfill fills in the parent of sessions from before the fields existed.
  - depends-on page.api: The tree is fetched through the shared API file.
fingerprint: 48580269a576
written: 2026-10-02
---

The spinoff tree page draws every session under the session it came from. A door at the bottom of the roster opens it.

A one-time backfill script found the parents of older sessions from their chat logs. It leaves a session alone when the evidence is not clear.
