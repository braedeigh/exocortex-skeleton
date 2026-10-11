---
id: threads.page
name: Threads page
kind: feature
parent: threads
sources:
  - frontend/src/features/threads/
links:
  - calls threads.files: The tree and each thread's facts come from the thread reader.
  - depends-on page.day: A thread's cards are drawn with the journal page's own card and markdown parts.
fingerprint: bc96753aede4
written: 2026-10-04
---

The page draws the threads as a tree: roots at the top, their children under them, and a thread with two parents shown under each. Sleeping threads fold away at the bottom. Opening a thread shows its fact cards, each with chips that lead to the source.
