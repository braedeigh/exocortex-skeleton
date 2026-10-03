---
id: worktrees.map
name: Worktree map
kind: feature
parent: worktrees
sources:
  - routes/worktree_map.py
  - frontend/src/features/observatory/WorktreeMapDoor.tsx
  - frontend/src/features/observatory/WorktreeMapPage.tsx
  - frontend/src/features/observatory/WorktreeMapPage.module.css
  - frontend/src/features/observatory/worktreeMapApi.ts
  - frontend/src/features/observatory/worktreeMapMath.ts
links:
  - reads data.calls: A session counts in a tree when its tool calls touched the tree.
  - reads data.index: Each session's title, room and starting folder come from the index.
  - depends-on worktrees.copies: The main checkout's path comes from the worktree module.
  - composes swarms.views: The page draws the swarm networks under its plots.
  - depends-on page.api: The page reads the session roster through the shared API file.
  - composes page.roster: Each tree lists its sessions with the roster's session lane.
fingerprint: a2447759d275
written: 2026-10-02
---

The worktree map shows which sessions work in which copy of the code. It works this out from what the sessions did: every tool call names the files it touched. A touch is an edit, a command that ran in the tree, or a read.

Each tree shows its branch, how far it is from the main branch, and its uncommitted files. The colors follow the Terrain map.
