---
id: people.door
name: People write door
kind: script
parent: people
sources:
  - tools/people/src/
links:
  - writes data.vault: It is the one safe writer of the person files.
fingerprint: ede92d9eb9d3
written: 2026-10-04
---

Night agents do not edit a person file by hand. They go through this small command-line tool, which adds a dated reference, an alias, or a new person in the exact shape the reader expects. Every write is added to a changelog.

A validate command reads every file and reports any line the reader would drop.
