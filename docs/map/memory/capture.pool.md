---
id: capture.pool
name: Card pool and views
kind: module
parent: capture
sources:
  - tools/stream/stream.py
links:
  - writes data.cards: Every card is made, tagged, edited and deleted here.
  - generates data.vault: A day's page is drawn again from the cards after each new card.
fingerprint: 2abe129aed51
written: 2026-10-04
---

The pool is one markdown file per thing said. It only grows. This module is the one writer of the pool: it makes a card, tags it, edits it, and deletes it.

An edit keeps the old text in a log and marks the card as edited. A delete is written down too. The module also draws the views, such as the page for one day, from the cards by a rule.
