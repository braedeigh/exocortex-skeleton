---
id: night.tending
name: Thread tending
kind: script
parent: night
sources:
  - scripts/thread_tending.py
links:
  - reads data.tables: The candidate cards for each thread come from the mirror.
  - depends-on recall.names: A risky name gets a session of its own.
  - calls capture.pool: A tag is added with the pool's own tag command.
  - calls gate: A tag removal waits in the approval queue.
  - depends-on threads.files: The list of threads and their states comes from the thread reader.
fingerprint: 343cc2633279
written: 2026-10-04
---

Thread tending checks that cards are filed under the right threads and people. A main session reads the day and says which threads it touched. Then each active thread gets a session of its own, with only that thread's cards, so no other thread colours its judgment. A name that is risky as a bare word gets its own session too.

The sessions only read a job file and write a report. The script makes every write. It adds a tag itself. A tag it wants to remove is staged for the owner.
