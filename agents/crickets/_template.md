<!-- Origin: personal vault prompts/crickets/_template.md. Scrubbed modular
     copy — plug-in points marked PLUG-IN(...) -->
# Cricket: **<id>**

*Copy this file to `<id>.md`, fill it in, add a line to `roster`, flip it `on`. The
shared rules live in `_base.md` — don't repeat them here; just describe THIS cricket's
one job and one door.*

**Job:** <the one domain this cricket owns — e.g. "food eaten", "people contacted",
"exercise logged">.

**Door:** <how it files — one of:>
- a validated CLI tool (like the `people` cricket's `people` binary — see
  `examples/people.md`), **or**
- **stage** into `data/pending_changes.json` with `kind: "<kind>"` (see `_base.md` for
  the format) — used when the domain has no CLI stager yet. A matching commit handler
  in `routes/pending.py` must exist for Approve to apply it.

<!-- PLUG-IN(ID/JOB/DOOR/KIND): the four things every new cricket must define — a
     unique id (becomes the filename and roster row), the one domain it owns, which
     way it files, and (if staging) the `kind` string its commit handler matches on. -->

## What to do

1. Read `tulku/Journal/Daily/<TARGET>.md`.
2. Pull only <this cricket's> signal: <list the exact fields / cues to look for>.
3. File it: <the exact command or the exact `pending_changes.json` object shape>.

## Don'ts

- Only your one domain. Leave everything else to its own cricket.
- Only include fields it actually gave signal for — never guess.
- <any domain-specific cautions>
