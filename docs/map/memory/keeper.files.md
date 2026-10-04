---
id: keeper.files
name: Memory files page
kind: feature
parent: keeper
sources:
  - routes/keeper.py
  - frontend/src/features/keeper/
links:
  - reads data.vault: The page lists and opens the memory files.
  - writes data.vault: The owner can edit a memory file in place.
  - depends-on page.day: A memory file is drawn with the journal page's markdown and name highlighter.
fingerprint: e86a173ae889
written: 2026-10-04
---

The Keeper's long memory is markdown files in the vault: its standing notes about the owner, her threads, her people, and the diary. This page shows that whole tree and lets the owner read and fix any file.

Only markdown files inside the vault can be reached. The page is the owner's alone.
