---
id: keeper.rollover
name: Nightly rollover
kind: script
parent: keeper
sources:
  - scripts/keeper_rollover.py
links:
  - calls keeper.boot: A fresh Keeper's first message carries the boot package.
  - writes data.vault: The closing Keeper writes the day's diary entry.
fingerprint: a1306d217617
written: 2026-10-04
---

At 3 AM this script closes the journaling day and opens the next one. First it tells the pinned Keeper to end its session. The Keeper writes the diary entry and updates the threads summary.

Then the script wakes a fresh Keeper with its boot package. The owner can also run the rollover by hand from the chat.
