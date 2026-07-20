<!-- Origin: personal vault prompts/crickets/cards.md. Scrubbed modular
     copy — plug-in points marked PLUG-IN(...) -->
# Cricket: **cards**

**Job:** for yesterday's stream-cards, tag every card that clearly touches a person or
thread, repair any view drift, and flag — never fix — anything that looks structurally
wrong in the pool.

<!-- PLUG-IN(TAGGER): who tags cards is a vault-level choice. In the worked
     example this cricket was extracted from, the Keeper had stopped tagging entirely,
     so this cricket became the sole tagger and primary work, not backfill — adjust
     the framing below to match your own setup (sole tagger vs. backfill-only). -->

**Door:** a validated CLI tool (`tulku/_system/stream.py`) — `tag`, `validate`, and
`render --all` are the only writes this cricket makes. No `pending_changes.json` stager
needed.

## What to do

1. List `tulku/_system/data/cards/` for cards whose id starts `<TARGET>.` (yesterday's
   cards), and `tulku/people/` to see who has a file — that's your tag vocabulary.
   `tulku/Threads/*.md` filename stems (e.g. `long-covid`) are tag vocabulary too —
   a card clearly about a thread's topic gets the thread's slug, same
   confidence bar as people. (Thread inboxes derive from these tags.)
   **Use the slug EXACTLY as the filename spells it** — `long-covid`, never
   `longcovid`/`long covid`. The match is literal: a near-miss tag is silently
   invisible to the thread forever. If a card's topic has no thread file yet,
   leave it untagged rather than inventing a slug — the front crickets nominate
   threads, and a tag minted ahead of one just rots.
2. **Tag audit.** For each of yesterday's cards, check its `tags:` field against its
   body. If a card clearly names or is clearly about a person with a `people/` file, or
   touches a recurring topic/thread, and it's untagged (or missing an obvious tag),
   backfill it:
   `python3 <VAULT_DIR>/tulku/_system/stream.py tag <card-id> <tag> [...]`.
   Use `people/` filenames as the tag vocabulary for people. Only tag what you're
   confident about — small-talk cards can stay untagged.
3. **Validate + repair drift.** Run
   `python3 <VAULT_DIR>/tulku/_system/stream.py validate`. If it reports a
   derived file (day view, index, manifest view) has drifted from the pool, repair it
   the sanctioned way — re-render, never hand-patch:
   `python3 <VAULT_DIR>/tulku/_system/stream.py render --all`.
4. **Flag, don't fix.** If `validate` turns up a card that fails to parse, a dangling
   `reply_to` (points at an id that doesn't exist), or you notice suspiciously
   duplicate cards (same timestamp, near-identical body), leave them exactly as they
   are and write them up in your end report for a human to look at by hand.

## Don'ts

- Only your one domain — tags and view-drift on cards from `<TARGET>` onward. Leave
  everything else to its own cricket.
- **Never edit a card's body.** That's the Keeper's one sanctioned edit (screenshot
  transcriptions), not yours.
- **Never touch a pre-cutover daily file** — if the vault has any plain-markdown daily
  files predating adoption of the stream-cards engine, those aren't rendered views and
  are outside this cricket's reach entirely.
  <!-- PLUG-IN(CUTOVER_DATE): if the vault migrated to the card-pool engine on a known
       date, name the exact cutoff here so this cricket knows which daily files are
       pre-engine plain markdown vs. rendered card views. -->
- Only add tags you're confident about — never guess a person or thread from a vague
  reference.
- Structural oddities (parse failures, dangling `reply_to`, suspicious duplicates) get
  flagged in your report, never silently fixed.
