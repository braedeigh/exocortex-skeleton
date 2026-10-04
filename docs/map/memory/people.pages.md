---
id: people.pages
name: People pages
kind: feature
parent: people
sources:
  - routes/person.py
  - frontend/src/features/people/
  - frontend/src/features/person/
links:
  - calls people.index: The pages are assembled from the index's parsed people.
  - depends-on page.day: The pages reuse the journal page's markdown and highlighter.
  - depends-on threads.files: A person's page reads the thread reader's shared helpers.
fingerprint: 982771043bf3
written: 2026-10-04
---

The roster lists everyone with a small chart of how often they come up. One person's page shows their blurb, their impression, a day-by-day timeline of mentions, and the lines behind each one. A button opens a session to redraft the impression with the owner.
