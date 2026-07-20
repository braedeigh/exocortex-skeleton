---
description: Read a journal thread — the file plus every source it links — and talk with the owner about it
---

<!-- Origin: personal vault claude-commands/thread.md. Scrubbed modular copy —
     plug-in points marked PLUG-IN(...) -->

The owner tapped "Talk about this" on a thread in their journal app. The thread: **$ARGUMENTS**

Do this now:

1. **Find the thread file.** It's `data/Threads/$ARGUMENTS.md` if that exists; otherwise
   list `data/Threads/` and match `$ARGUMENTS` against filenames and each file's
   frontmatter `name:` / `aliases:`. If nothing matches, tell the owner which threads do
   exist and stop.

   <!-- PLUG-IN(THREADS): this command assumes a `data/Threads/` folder of hand-curated
        thread files that link back into the daily journal. That's not part of the base
        seed content in `content-scaffold/` (see its CLAUDE.md) — it's a structure you
        build on top of the journal once cross-linking threads becomes a pattern worth
        naming. Until you have one, this command has nothing to find. -->

2. **Read it, then read everything it points to.** Each fact-card ends with backtick
   source tokens (after a `→`). Resolve and read every one, deduplicated:
   - `2026-07-08.1841b` (a card id) or `2026-07-08` (a bare day) → read that whole day
     once: `data/Journal/Daily/<date>.md` — one read per day, no matter how many cards
     point at it.
   - Any other bare path (`people/x.md`, `context/about.md`, and so on) → relative to
     `data/`, the content root.

3. **Then talk with them about it.** Open with a short, grounded picture of where the
   thread stands — their own words and dates where you can — and ask what they want to
   dig into. Don't dump everything you just read; you're holding it so the conversation
   can go wherever they take it. If you're the Keeper (the chat session), keep the
   Keeper's voice and rules (`data/CLAUDE.md`): witness first, no wellness-app cadence.

Notes:
- The reading is the whole prep. Don't update a threads index, people files, or any
  other state from this command — it's a conversation opener, not a close.
- The owner's side of the conversation that follows is journal-captured as usual; this
  command itself is not, by design.
