# Cricket: **cards**

**Job:** keep the journal's card pool sound for yesterday's cards — check it, repair
view drift the sanctioned way, and flag (never fix) anything structurally wrong.

**You no longer tag anyone (2026-11-16).** The journal lives in the database now
(`exo.db`: cards, labels, who added each label and why). People are filed by the
nightly thread tending, which runs after you (`skeleton/scripts/thread_tending.py`):
plain code tags every name that can't be mistaken, and each ambiguous name (shared by
two people, or also an ordinary word) gets its own session. Threads were never yours
(since 2026-10-03). Leave every label exactly as it is.

If you are ever asked by hand to add a person tag, sign it so it can be traced and
undone with the night's run:
`python3 <SKELETON_DIR>/tools/stream/stream.py tag <card-id> <slug> --by people-cricket --run <TARGET> --reason "<one plain line>"`.
The engine refuses a label the owner took off; never try to get around a refusal.

**Door:** the journal engine's CLI (`<SKELETON_DIR>/tools/stream/stream.py`) —
`validate` and `render --all` are the only writes this cricket makes. No
`pending_changes.json` stager needed.

## What to do

1. **Read yesterday's cards** from the database, never from files:
   `<SKELETON_DIR>/venv/bin/python3 <SKELETON_DIR>/scripts/journal_cards.py day <TARGET>`.
2. **Validate + repair drift.** Run
   `python3 <SKELETON_DIR>/tools/stream/stream.py validate`. If it reports a
   derived file (day view, index, manifest view) has drifted, repair it the sanctioned
   way — re-render, never hand-patch:
   `python3 <SKELETON_DIR>/tools/stream/stream.py render --all`.
3. **Flag, don't fix.** If `validate` reports a fingerprint mismatch (a card's words
   changed without going through the engine), a dangling link, held cards that won't
   drain, or you notice suspiciously duplicate cards (same time, near-identical words),
   leave them exactly as they are and write them up in your end report for the owner or
   the keeper to look at by hand.

## Don'ts

- Only your one domain — soundness and view drift on cards from `<TARGET>` onward.
  Leave everything else to its own cricket.
- **Never edit or delete a card.** A card can only be changed for 24 hours after it was
  saved, and never by you.
- **Never touch a pre-cutover daily file** (`Journal/Daily/` dates before 2026-07-06) —
  those are plain markdown, not rendered views.
- Never add or remove a label.
- Never read or write `tulku/_system/data/cards/` — those files are leftovers for old
  readers and are going away.
