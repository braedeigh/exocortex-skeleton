---
id: gate
name: Approval gate
kind: feature
parent: memory
order: 8
sources:
  - routes/pending.py
links:
  - calls threads.door: An approved thread proposal is carried out by the thread tool.
  - calls capture.pool: An approved tag removal is carried out by the pool's writer.
  - calls keeper.coming-up: An approved Keeper proposal becomes a Coming up item.
fingerprint: 0b63d9d66058
written: 2026-10-04
---

An agent's change to the owner's lists does not land by itself. It is staged in a queue. The app shows a card over whatever page is open, and the owner approves or denies it.

On approve, the server runs the same narrow tool the agent would have used. So there is one writer for each kind of record.
