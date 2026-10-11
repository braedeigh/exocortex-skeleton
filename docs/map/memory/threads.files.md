---
id: threads.files
name: Thread reader
kind: module
parent: threads
sources:
  - routes/threads.py
links:
  - reads data.vault: Every thread file is parsed on each request.
  - depends-on people.index: It reuses the people index's file parser.
fingerprint: 9c0f7151821f
written: 2026-10-04
---

These routes read the thread files fresh on each request. They give the list of threads, one thread's facts with their sources, and the cards tagged with it. A button opens a session to talk about one thread.
