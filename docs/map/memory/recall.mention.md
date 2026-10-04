---
id: recall.mention
name: Mention hook
kind: script
parent: recall
sources:
  - tools/mention_context.py
links:
  - reads data.vault: The names and aliases come from the people and thread files.
  - reads data.tables: The cards about a name come from the cards, tags and word index tables.
  - depends-on recall.names: It asks which names are too risky to match as a bare word.
  - calls recall.record: It skips what the session already has and writes down what it loads.
  - depends-on threads.files: Thread names and aliases are read with the thread reader.
fingerprint: 33583cd540fc
written: 2026-10-04
---

This hook runs on every message the owner sends, in any session. It looks for the name or alias of any person or thread in the vault. For each one not yet loaded in the session, it reads her newest twenty cards about them from the database and prints them. What it prints lands in the agent's context.

Only the owner's own cards are loaded. A name that cannot be trusted as a bare word loads only cards the taggers filed under that person.
