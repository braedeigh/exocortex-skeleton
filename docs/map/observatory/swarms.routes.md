---
id: swarms.routes
name: Swarm routes
kind: feature
parent: swarms
sources:
  - routes/swarms.py
links:
  - reads swarms.grouping: The routes list every swarm and its members.
  - calls swarms.helper: A refresh runs the swarm helper now, and a swarm's page shows its runs and closings.
  - reads helpers.room: The room view shows the room helper and its last moves.
  - calls helpers.chat: The context page reads a helper's seed and saves its standing rules.
  - reads data.mail: A line of the swarm drawing opens into the messages it stands for.
  - depends-on engine.sessions: A session with no swarm is linked to its room's helper, found by the lanes rule.
fingerprint: 243c2a7e417b
written: 2026-10-04
---

These routes give the page what it shows of swarms. They list the live swarms, give one swarm in full, and give the view of a whole room. They list the messages behind one line of a swarm's drawing, and a swarm's closing summaries.

They also serve a helper's context page. They save the owner's standing rules for a helper, as a whole file or one rule at a time.
