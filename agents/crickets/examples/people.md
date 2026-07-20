<!-- Origin: personal vault prompts/crickets/people.md. Scrubbed modular
     copy — plug-in points marked PLUG-IN(...) -->
# Example cricket: **people** (a worked example of a validated-CLI-tool cricket)

*Ships `off` in `roster` and lives in `examples/` rather than alongside the active
crickets. Not because the pattern is personal — the `people` tool it drives is a real,
generic tool in this repo (`tools/people/`) — but because every illustration below used
the original author's actual contacts as examples. All names below are invented
placeholders (alex/sam/jordan/…), not real people. To use it: copy this file to
`agents/crickets/people.md`, adjust anything vault-specific, add a roster row, and flip
it `on`.*

**Job:** for everyone mentioned in the day's journal, add a dated reference to their
people file — so `tulku/people/` stays current *daily*, not just weekly. This is what
makes the people cross-reference live: click a name, see every day it came up.

**Door:** the **`people` tool** — the one narrow, validated write path into
`tulku/people/`. You do **not** edit those markdown files by hand anymore. You call the
binary; it validates the date/format, appends atomically in the exact shape the database
parses, and records every write in `_system/cricket_changelog.md`. The model fills the
slots; the code does the write.

```
PEOPLE=<SKELETON_DIR>/tools/people/target/release/people
```

The tool reads `$EXOCORTEX_CONTENT_DIR` for the vault. If that isn't set in your shell,
add `--content-dir <VAULT_DIR>/tulku` to every command.

## What to do

1. Read `tulku/Journal/Daily/<TARGET>.md`.
2. List `tulku/people/` to see who already has a file. Files are named by first name,
   lowercased (`alex.md`, `sam.md`, `jordan.md`); some carry a qualifier to
   disambiguate (`alex-b.md`, `sam-k.md`, `jordan-t.md`).
3. Find every **person** named that day — someone talked to, seen, texted,
   thought about, or told a story about. Match each to a people file (by first name /
   obvious alias). One person may be referred to by role, not name (e.g. "my landlord"
   → `alex.md`) — match those you can be confident about; skip the ones you can't.
4. For each matched person, **add one dated reference** by calling the tool:

   ```
   $PEOPLE add-ref --person <slug-or-name-or-alias> --date <TARGET> \
       --note "short parenthetical — what happened, in their words where you can"
   ```

   - `--person` resolves by slug, first name, or an existing alias, so
     `--person alex`, `--person "my landlord"` all land on the same file.
   - Keep `--note` to a phrase or two: the gist plus a short quote if something pointed
     was said. The tool wraps it as `- [[<TARGET>]] (your note)` for you —
     **don't** type the brackets or parens yourself, just the note text.
   - **Idempotent for free:** if a line for `<TARGET>` already exists, the tool says
     "already present" and does nothing. You never create a duplicate.
   - If the person has no file yet, use `new-person` (below) instead of `add-ref`.

   **Never touch the top summary/blurb or `**bold arc**` paragraphs** — that's the
   weekly housekeeper's judgment work. The tool only appends references; keep it that way.

## Aliases — keep the frontmatter current (factual bookkeeping, yours)

People files carry a YAML **frontmatter** block at the top:

```yaml
---
tags: [riverbend, housing, landlord]
aliases: [landlady, housemate, my landlord]
---
# Alex
```

The `aliases` list is **how the journal refers to that person in prose besides their
name** — roles, nicknames, epithets ("my landlord," "the recruiter," "housemate"). It's
what lets the app light up "my landlord" and know it means Alex. Maintaining it is
**factual and yours** (tags are the weekly housekeeper's judgment — **don't touch
`tags`**).

When a mention is matched to a person **via a role/nickname** (step 3), record it:

```
$PEOPLE add-alias --person <slug> --alias "my landlord"
```

The tool lowercases it, skips it if already present (case-insensitive), and adds a
`tags: []` frontmatter block if the file had none — all without disturbing `tags`. Only
add an alias you're **confident maps to that person** — a role actually used to *find*
them. Don't invent aliases, don't add first names (those aren't aliases), don't add
one-off descriptions ("the guy from the party") that won't recur.

## New people — create a stub (conservatively)

If someone **new** is clearly introduced with enough context to say who they are (a
name + who they are — "my new coworker Taylor," "met someone named Morgan on a dating
app"), create their file with the tool:

```
$PEOPLE new-person --name "Taylor" \
    --blurb "one-line who-they-are, in plain prose — how they enter the journal; quote them" \
    --date <TARGET> --note "how they came up today" \
    --alias coworker
```

- `--slug` defaults to the lowercased first name; pass `--slug alex-b` when you
  need to disambiguate from an existing `alex.md`.
- Leave off `--alias` unless they were introduced by a clear role you'd expect to recur
  ("my new coworker Taylor" → `--alias coworker`). `tags` is always left empty — that's
  the weekly housekeeper's judgment.
- The tool refuses to clobber an existing file, so if a stub already exists it errors —
  in that case just `add-ref` to the existing file.
- **Only for a genuinely named, placed person.** A passing stranger ("the barista,"
  "some guy on the bus") gets **no file** — skip it.
- If unsure whether they're new vs. an existing file under a different name, **skip
  creating** and just `add-ref` to the existing file if you find a confident match.

## Before you finish — validate

Run the validator and confirm your writes parse cleanly:

```
$PEOPLE validate --quiet
```

`--quiet` prints only files with problems. If it flags anything **you** just wrote
(a bad reference line, unclosed frontmatter), fix it and re-run. If it flags
*pre-existing* drift in files you didn't touch, **note it in your end report** but don't
silently rewrite someone's authored history — that's for a human to decide. A clean run
(exit 0) means every reference you added is a reference the database will show.

## Don'ts

- **Don't converse, reflect, or edit the narrative summary.** References + new stubs only.
- **Don't invent** references — only people actually in the target day's journal.
- **Don't hand-edit** `tulku/people/*.md` — every write goes through the `people` tool.
- **Don't touch** `tags:`, the narrative, `THREADS.md`, `WORRIES.md`, or earlier journal
  entries. Aliases + references + stubs are your whole job.
- **Silence is fine** — if no people are named, do nothing.
