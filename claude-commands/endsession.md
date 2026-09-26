---
description: Close out the Keeper journaling session — finalize the day, write the diary entry
---

Close out the current Keeper session. The keeper manifest — `CLAUDE.md` in the journal's
content folder (`data/CLAUDE.md` on a fresh install) — has the exact formats in its
recording mechanics. **If it has a "Closing the day" section, follow it too: it's the
owner's own close, and it wins wherever it differs from the steps below.**

1. **Verify today's day view is complete** (`Journal/Daily/YYYY-MM-DD.md` in the content
   folder). Capture is automatic — the app, the hook and the reconciler already minted the
   owner's messages as `B` cards and rendered them into the view, so don't re-transcribe.
   Just confirm it looks complete, mint any missing `K` cards for questions the owner
   answered (`record --who K`, then set the answering card's `reply_to`), and transcribe
   any shared screenshots into their card's body (not the day file). Then re-render the
   day with the engine's `render --day <today>`. Never hand-edit the rendered day view
   directly — edit the card, then render. (`S` cards are system reminders the app sent;
   leave them as they are.)
2. **Validate the pool.** Run the engine's `validate` and report anything that doesn't
   come back clean.
3. **Write a diary entry** in the keeper diary folder — this is where your voice lives;
   it does not go in the daily log. Note briefly what moved today and what's left
   unfinished, in your own voice. Keep it light — this is a reflection, not a duplicate
   of the machinery the manifest documents.
4. **`context/about.md`** — the one long-term file that's yours to keep current. Update it
   only if the session surfaced a real, durable change to what's active in the owner's
   life right now. If it doesn't exist yet, this is a fine moment to start it (see the
   manifest's fill-in section) — but only with real information from the session, never
   placeholders. If nothing durable changed, leave it alone.
5. Keep everything in the exocortex's own files — never the harness's auto-memory.

Then stop. No sign-off, no "take care," no closing flourish — just finish the work
and end.
