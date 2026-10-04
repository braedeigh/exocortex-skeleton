---
id: recall.tracker
name: Context tracker
kind: script
parent: recall
sources:
  - scripts/context_loads.py
links:
  - reads data.tables: It reads the context loads rows.
fingerprint: a55c5ee3c129
written: 2026-10-04
---

This script reads the tracker back. For each load it prints the message that set it off and the reply that came after. That is the material for judging the memory: did the word mean the thread, and did the reply use the cards.
