---
id: worktrees.copies
name: Worktree copies
kind: module
parent: worktrees
sources:
  - worktrees.py
fingerprint: 40f615553fa2
written: 2026-10-02
---

This module makes, adopts and removes git worktrees. A new worktree is cut from the main branch. Adopt stands a new session on an existing agent branch, which is how a steward session starts.

A worktree is removed only when its session is archived, never because it is old. A session's folder is fixed for its life, so removing its worktree early would kill the session. The branch always stays.
