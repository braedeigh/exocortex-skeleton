---
id: people.index
name: People index
kind: module
parent: people
sources:
  - routes/entities.py
links:
  - reads data.vault: Every person file is parsed on each request.
fingerprint: 1c3bf88d7f87
written: 2026-10-04
---

This module reads every person file into a person with many dated entries. It also finds loose mentions of a name elsewhere in the vault. The journal page uses the roster of names and aliases to highlight people in the text.
