---
id: page.day
name: Journal day
kind: feature
parent: page
sources:
  - frontend/src/features/journal/
  - routes/cards.py
  - routes/photos.py
links:
  - calls capture.pool: Adding, editing, tagging and deleting a card go through the pool's writer.
  - calls mirror.search: The search box asks the journal search.
  - calls people.index: The roster of names drives the highlighter and the person popover.
  - calls threads.files: Thread names are highlighted and open in a popover.
  - depends-on mirror.cards: A saved edit is mirrored at once, so search and counts stay current.
fingerprint: 6a0d14a41f46
written: 2026-10-04
---

The day page shows one day's cards in order, with photos as thumbnails. The owner can add a card, edit one, tag one and delete one. An edited card keeps its earlier versions, and the page can show them.

Names of people and threads are highlighted in the text. A tap on a name opens that person or thread without leaving the day. The search box turns the page into a list of matching cards.
