---
name: Broken Thread
charter: "A deliberately broken fixture. Out: anything that lints clean."
aliases: []
fronts: [nope]
parents: [ghost-parent]
kind: standing
status: retired
opened: 2026-07-01
retired:
distilled:
---

## Missing source
This statement has no source line at all.

## Four line statement
Line one of the statement.
Line two of the statement.
Line three of the statement.
Line four of the statement, over the limit.
→ `2026-07-08.1841b`

## Duplicate section
First occurrence of this heading.
→ `2026-07-08.1841b`

## Duplicate section
Second occurrence of this heading — the file has it twice.
→ `2026-07-08.1841b`

## Body metadata
**Opened:** 2026-07-01 — this line duplicates frontmatter and shouldn't be here.
→ `2026-07-08.1841b`

## Frozen casefile source
A claim that dead-ends at the frozen, PAUSED casefile.
→ `tulku/THREADS.md`
