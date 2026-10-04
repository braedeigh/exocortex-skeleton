---
id: recall.record
name: Load record
kind: module
parent: recall
sources:
  - loadrecord.py
links:
  - writes data.tables: Each load is one row in the context loads table.
fingerprint: 180a7dc62764
written: 2026-10-04
---

A session is handed cards from two places: the boot package and the mention hook. This module keeps one record per session of the names loaded, the cards handed over, and a short fingerprint of each card's words.

It also writes one row to the context loads table for every load. That table is the tracker of what the memory did.
