---
id: night.weekly
name: Weekly close
kind: script
parent: night
sources:
  - scripts/cricket_housekeep.sh
links:
  - calls people.door: The people files are tended through the people tool.
  - calls threads.door: New threads are proposed through the thread tool.
  - calls recall.tracker: The memory review reads the week's context loads.
fingerprint: 6d301416aea8
written: 2026-10-04
---

Once a week, after the week has ended, one agent does the housekeeping. It writes the weekly summary, tends the people files, prunes the Keeper's notes about the owner, and puts finished threads away.

Two more weekly agents run on Sunday. One looks across the week for new threads to propose. The other reviews the week's context loads and writes a report on which were meant and which were used.
