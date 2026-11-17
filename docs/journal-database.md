# The journal in the database — design of record

**What this is.** The plan for moving the journal (the card pool) out of
one-markdown-file-per-card and into exo.db, with tags, links and filing
history as real rows. Every session building a piece of it reads this first.
Agreed with the owner 2026-11-16; this file is the contract between the
sessions that build it. If the build forces a change, change this file in the
same commit and say why.

Prompts, distilled: "i don't want [tags] in the cards themselves" · "i'm
wondering if cards shouldn't be written straight into the database with all
the information associated with them" · "a database with a unique ID per card
and then another where they are linked" · "cards can't be edited after 24
hours … cards can be deleted only within the past 24 hours, and this should be
reflected in the UI" · "i can add notes to old cards that go on my new daily
log … 'reply to' or 'linked to' a certain one".

## Why

Today the card files (`CONTENT_DIR/_system/data/cards/<id>.md`) are the truth
and exo.db holds an hourly copy (`cardstore.py`). Every tag the nightly agents
add rewrites a card file; tags carry no record of who added them or why; the
copy lags up to an hour; and a missing-card alarm exists only because there
are two copies to drift apart. One writer on one machine doesn't need files
as the truth (the file design came from a multi-writer, serverless system —
see the top of `tools/stream/stream.py`).

## The rules

1. **The database is the truth for cards.** No card files after cutover.
2. **A card can be edited or deleted for 24 hours after it was said, then
   never.** One clock for everyone — the owner, the Keeper, agents, scripts.
   Enforced in SQLite by triggers, not just by the app: an UPDATE of the
   card's words / speaker / time, or a DELETE, on a card older than 24 hours
   raises an error. Edits inside the window overwrite in place (the raw
   prompt also survives in the Claude transcripts); every edit also appends
   one before/after row to `card_edits`, because voice cards never pass
   through a transcript.
3. **Later thoughts on a locked card are new cards that link to it** (a
   "note"), written today, shown on today's journal page with a quote of the
   old card, and shown under the old card as "N notes added later".
4. **Saving a card must never fail because of the database.** If the write
   can't happen (locked, busy past the timeout, broken), the card goes to an
   append-only holding file and is loaded in on the next write or by cron.
5. **Every word stays in git.** Each hour, before the vault backup commits,
   cards are written out as text, one file per day, append-only in practice
   (a day file only changes inside its 24-hour window). Plus a fingerprint per
   card so a rewrite that went around the triggers is detectable.
6. **Agents propose; code writes.** No agent edits rows directly.
7. **The owner's hand outranks agents.** An agent never removes a label she
   added and never re-adds one she took off.

## The tables

```
cards          one row per utterance          editable 24h, then frozen
card_edits     before/after of each edit      append-only
card_links     note → old card, answer → q    a row is never changed
labels         threads, people, topics, …     the vocabulary
card_labels    card ↔ label, with history     rows are marked off, never deleted
```

**`cards`** — the readable id stays (`YYYY-MM-DD.HHMM` + speaker letter +
optional counter).
| column | holds |
|---|---|
| id | `2026-11-15.2315b` |
| who | B owner · K keeper · S system |
| said_at | the moment it was said (today's `ts`) |
| day | the journal day |
| kind | line, context, … (today's `kind`) |
| body | the words |
| fingerprint | sha256 of body (+ who + said_at) |
| door | how it came in: `web`, `hook`, `reconciler`, `voice`, `keeper`, `system`, … |
| device | which machine heard it (voice) |
| session | conversation it came from |
| saved_at | when the row was written — the 24-hour clock runs from `said_at` |
| deleted_at | set by a delete inside the window (row kept, hidden) |

Capture-time "how it came in" tags (`voice`, `via:<device>`, `exo-command`)
become `door` / `device` columns or labels of kind `source` — the foundation
session picks one and records it here. The `/thread <slug>` capture tag
becomes a `card_labels` row with `added_by` = the capture door.

**`card_links`**
| column | holds |
|---|---|
| from_card | the newer card |
| to_card | the card it points at |
| kind | `note` (her later note on an old card) · `answers` (her reply to a Keeper question — today's `reply_to`) · more later |
| linked_at | when |

**`labels`**
| column | holds |
|---|---|
| id | integer |
| kind | thread · person · topic · source · … |
| slug, name | `dating-and-romance`, "Dating and Romance" |
| status | active · dormant · retired |
| file | the thread/person markdown file it belongs to, if any |

**`card_labels`**
| column | holds |
|---|---|
| card_id, label_id | the link |
| added_by | owner · keeper · capture · `thread-tending` · `people-cricket` · … |
| run | which nightly run (so one night can be undone at once) |
| reason | the agent's one sentence — shown only where it helps (a removal, a "why is this here?") |
| weight | `about` (mainly this) or `touches` (it comes up) |
| added_at | |
| removed_at, removed_by, removed_why | set when taken off; the row stays as the "don't put it back" memory |

How this sits beside the universal `tags` table (`docs/tags-architecture.md`):
the foundation session decides whether `card_labels` replaces the `card:`
rows there or the backfill keeps mirroring into it, and writes the answer
here. Don't leave two writable homes for card tags.

## The nightly filing agents

- **People:** plain code matches names first; only ambiguous names (shared by
  two people, or also an ordinary word — `namerisk.py`) go to a small model.
- **Threads:** one isolated session per active thread (as now, in
  `scripts/thread_tending.py`), each proposing rows with a reason.
- **Overlaps:** a final pass sees every claim on a card and marks one `about`
  and the rest `touches`. Thread pages rank `about` first.
- **Notes:** a note card is judged with the card it points at as context; a
  note on an old card can wake a dormant thread.
- Additions apply automatically (undoable per run). Removing a label someone
  else added still goes to the owner's approval queue.

## Build order

1. **Foundation** (one session): schema + triggers + migration of every card
   and tag, `stream.py` reads/writes the database, holding file, hourly text
   export into the vault backup, retire the hourly mirror and its alarm,
   cutover at a quiet hour.
2. Then, in parallel:
   - **Readers** — every route/script that reads card files or `card_tags`.
   - **Nightly filing** — thread tending + the people cricket write
     `card_labels`; the about/touches pass; vault prompts updated.
   - **Journal UI** — the 24-hour edit/delete with "locks at …", "Add a
     note", the quote on a note, "N notes added later" under old cards.
