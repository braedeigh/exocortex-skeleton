---
id: mirror.search
name: Journal search
kind: module
parent: mirror
sources:
  - cardsearch.py
  - routes/journal_search.py
links:
  - reads data.tables: The search runs on the word index over the cards table.
  - calls mirror.cards: Before a search, cards made since the last sync are caught up.
fingerprint: 867675858b77
written: 2026-10-04
---

This is the engine behind the journal's search box. It finds cards that hold the typed words and ranks them by best match, newest or oldest. Each hit is one moment, with a time, a speaker and a short excerpt.

It uses the database's built-in word index. Word endings are folded, so one form of a word finds the others. A search can be limited to the owner's lines or the Keeper's, and to a range of days.
