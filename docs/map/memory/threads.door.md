---
id: threads.door
name: Thread write door
kind: script
parent: threads
sources:
  - tools/thread/src/
links:
  - writes data.vault: It is the one writer of the thread files.
  - calls gate: A proposed thread or link waits in the approval queue.
fingerprint: fb971ce3a4d9
written: 2026-10-04
---

This command-line tool is the only writer of the thread files. It opens a thread, adds a fact with its source, links a thread under a parent, and sets its status. A lint command checks every file against the format.

An agent cannot open a thread by itself. It proposes one, and the proposal waits for the owner.
