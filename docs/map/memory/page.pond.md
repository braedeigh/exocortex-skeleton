---
id: page.pond
name: Pond
kind: feature
parent: page
sources:
  - routes/pond.py
  - frontend/src/features/terrain/pond/
links:
  - reads data.tables: The cards and their tags come from the mirror.
  - depends-on people.index: It reuses the people index's file parser.
  - depends-on threads.files: Thread names and states come from the thread reader.
  - depends-on page.day: A card opened in the Pond is drawn with the journal page's parts.
fingerprint: 7a181467388b
written: 2026-10-04
---

The Pond draws the whole journal at once: every card at its own day and hour, with the threads running through them. Threads are ranked by how many days they touch, not by how many cards they have.

It reads only the mirror. Nothing here is new data.
