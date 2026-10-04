---
id: recall.names
name: Name risk
kind: module
parent: recall
sources:
  - namerisk.py
links:
  - reads data.tables: The count of cards with the word is set beside the count tagged with the person.
  - reads data.vault: The names and aliases come from the people files.
  - depends-on people.index: It reuses the people index's file parser.
fingerprint: 8c9ddc39a65a
written: 2026-10-04
---

Finding cards about a person by their name goes wrong in two ways. A name can be an ordinary word. And two people can share a first name.

This module works out which names have one of those problems. A name is weak when the word is in many cards and the night taggers filed almost none of them under the person. A name is shared when more than one person file lists it. No word list is used; the taggers' own verdicts are the evidence.
