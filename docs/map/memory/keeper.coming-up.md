---
id: keeper.coming-up
name: Coming up
kind: feature
parent: keeper
sources:
  - comingup.py
  - routes/coming_up.py
  - scripts/coming_up_propose.py
links:
  - calls gate: A Keeper's proposed item waits in the approval queue.
fingerprint: 027ed165349f
written: 2026-10-04
---

Coming up is a short list of dated things: events that happen on a day, and topics the owner wants raised on a day or at a time. Each item says who made it, the owner or a Keeper.

A new Keeper reads the list when it wakes. The minute tick sends a reminder into the Keeper's chat when a timed item is due. A Keeper can only propose an item, and the owner approves it.
