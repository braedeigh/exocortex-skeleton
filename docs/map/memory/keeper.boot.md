---
id: keeper.boot
name: Boot package
kind: script
parent: keeper
sources:
  - scripts/boot_context.py
links:
  - reads data.vault: The standing rules and memory files come from the vault.
  - calls capture.pool: The recent journal is drawn from the cards by the pool's renderer.
  - calls keeper.coming-up: The package ends with the Coming up list.
  - calls recall.record: The cards it hands over go into the session's record.
  - calls mirror.cards: It brings the card mirror up to date before it gathers the recent journal.
fingerprint: bd8cc9d90877
written: 2026-10-04
---

This script builds the package a new Keeper wakes with. A small manifest in the owner's data folder lists what to load. The script gathers it in a fixed order: the standing rules, then the recent journal, then the Coming up list.

The cards in the package are written to the session's record, so they are not handed over a second time later.
