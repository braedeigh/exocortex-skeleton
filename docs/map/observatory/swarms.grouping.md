---
id: swarms.grouping
name: Swarm grouping
kind: module
parent: swarms
sources:
  - swarms.py
links:
  - reads data.mail: Who messaged whom is what links sessions into a swarm.
  - reads data.index: Session states decide which members still work.
  - writes data.swarm-tables: Swarms, members and placements are kept in their tables.
  - depends-on engine.sessions: A swarm's room is the most common room of its members, by the lanes rule.
fingerprint: 57684a83dd62
written: 2026-10-04
---

This module finds the swarms. Two sessions that exchanged a message are linked, and everything linked together is one swarm. A swarm keeps its number, name and helper as it grows.

A swarm is open while at least two lines of work in it still go. Closed is worked out on every read, so a swarm opens again when work starts again. A placement by the room helper overrides older messages.
