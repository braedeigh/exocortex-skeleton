---
id: worktrees.branches
name: Agent branches
kind: feature
parent: worktrees
sources:
  - routes/branches.py
links:
  - calls worktrees.copies: Every number on a branch card is read from git through the worktree module.
  - calls spinoffs.door: A reply to a branch card wakes a steward session on that branch.
  - reads data.queue-files: The night crew's branches come from its run records.
fingerprint: 879f4ec1f9ae
written: 2026-10-02
---

These routes list the agent branches that are not merged yet. Each card says what the branch changed and whether anything is left over. All of it is read from git, not from the agent's own words.

The one write is the steward door. It starts a fresh session on the branch, briefed with the evidence and the owner's message. There is no merge button here.
