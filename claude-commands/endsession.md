---
description: Close out the Keeper journaling session — finalize the day, write the diary entry
---

Close out the current Keeper session. Follow `data/CLAUDE.md`'s "Recording mechanics"
section for the exact formats.

1. **Verify today's day view is complete**
   (`data/Journal/Daily/YYYY-MM-DD.md`). Capture is automatic — the hook and the
   reconciler already minted the owner's messages as `B` cards and rendered them into
   the view, so don't re-transcribe. Just confirm it looks complete, mint any missing
   `K` cards for questions the owner answered (`record --who K`, then set the
   answering card's `reply_to`), and transcribe any shared screenshots into their
   card's body (not the day file). Then `python3 data/_system/stream.py render --day
   <today>`. Never hand-edit the rendered day view directly — edit the card, then
   render.
2. **Validate the pool.** Run `python3 data/_system/stream.py validate` and report
   anything that doesn't come back clean.
3. **Write a diary entry** in `data/keeper-diary/` — this is where your voice lives;
   it does not go in the daily log. Note briefly what moved today and what's left
   unfinished, in your own voice. Keep it light — this is a reflection, not a
   duplicate of the machinery documented in `data/CLAUDE.md`.
4. **`data/context/about.md`** — the one long-term file that's yours to keep current.
   Update it only if the session surfaced a real, durable change to what's active in
   the owner's life right now. If it doesn't exist yet, this is a fine moment to start
   it (see `data/CLAUDE.md`'s fill-in section) — but only with real information from
   the session, never placeholders. If nothing durable changed, leave it alone.

Then stop. No sign-off, no "take care," no closing flourish — just finish the work
and end.
