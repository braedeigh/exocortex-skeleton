---
id: night.swarm
name: Cricket swarm
kind: script
parent: night
sources:
  - scripts/cricket_swarm.sh
  - agents/crickets/
links:
  - calls capture.pool: The cards cricket tags cards with the pool's own tag command.
  - calls night.tending: Thread tending runs after the last cricket.
  - calls gate: A cricket's to-do is staged for the owner to approve.
fingerprint: aa811ccaa4ab
written: 2026-10-04
---

A cricket is a small agent with one job and one short prompt. The swarm runner reads a roster, works out which day to file, and starts each cricket that is switched on. One cricket files to-dos, one files food, one files who the owner saw, and one tags the day's cards with people.

After the last cricket, the runner starts the thread tending.
