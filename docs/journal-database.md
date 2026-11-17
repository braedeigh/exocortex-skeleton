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
   (The files are still *written*, from the rows, until every reader reads the
   database — see "Compatibility files" below. They are never read back. The
   owner confirmed 2026-11-17: keep writing them until the readers session is done.)
2. **A card can be edited or deleted for 24 hours after it was saved, then
   never.** One clock for everyone — the owner, the Keeper, agents, scripts.
   Enforced in SQLite by triggers, not just by the app: an UPDATE of the
   card's words / speaker / time, or a DELETE, on a card saved more than 24
   hours ago raises an error. The clock runs from `saved_at` (when the row was
   written), not `said_at`: a card that arrives late — a voice listener that was
   offline, a held card drained hours later, a card added to an older day —
   still gets its full day before it locks. (Changed from "said" during the
   foundation build, at the brief author's correction, and confirmed by the
   owner 2026-11-17; `saved_at` itself can never be changed, or rewriting it
   would reopen the window.) Edits inside the window overwrite in place (the raw
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
| saved_at | when the row was written — the 24-hour clock runs from here; never changes. Migrated cards carry `said_at` here, so the old journal locks on schedule |
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

## Decisions made while building the foundation

Recorded here because the sections above left them to the foundation session.

- **Capture facts are columns, not labels.** `voice` → `door = 'voice'`;
  `via:<device>` → `device`. `record` converts those two tags on the way in, so
  routes/ear.py didn't change. `exo-command` is a label of kind `source`. The
  `card_tags` view shows `voice` and `via:<device>` again, first, so the journal's
  source chip keeps working. `door` values: `web` (the web app's send and the
  journal page), `hook`, `reconciler`, `voice`, `cli` (default — the Keeper and
  scripts). Migrated cards have `door` NULL (not recorded back then), except voice.
- **`card_tags` is a read-only VIEW** over `card_labels` (live rows) + the two
  capture facts. It is the only shape the old readers see; nothing can write it.
  `card_labels` is the one writable home for card tags.
- **The universal `tags` table no longer holds journal cards.** It used to keep
  a derived `card:` copy of every card tag for `tools/mention_context.py`; the
  readers session pointed the hook at `card_labels`, dropped backfill source 1,
  and `scripts/backfill_tags.py` deleted the 4,909 derived `card:` rows (it
  removes any that reappear, `source='derived'` only).
- **A slug names exactly one label** (`labels.slug` is UNIQUE), whatever its kind,
  so the view can show it as the plain string the files carried. A new slug is
  classified when first used, in the tags backfill's order: `people/<slug>.md` →
  person, `Threads/<slug>.md` → thread (its `status:`), `Threads-Retired/` →
  thread/retired, a fronts.json id → front, a capture tag → source, else topic.
  A label's status is NOT kept in step with the thread file afterwards — that's
  the nightly filing session's job.
- **`card_labels.weight` is NULL until judged** (the about/touches pass sets it).
  At most one live row per card+label (a partial unique index); marked-off rows
  pile up beside it as history. Rule 7 is enforced in `journaldb.add_label` /
  `remove_label`: `added_by = 'owner'` means her hand; an agent's re-add of a
  label she removed comes back `refused`, as does an agent removing hers. The
  journal page and the approval queue's "approve removal" pass `--by owner`.
- **Two columns beyond the table above:** `deleted_by` (who deleted it — the old
  deletion log recorded it) and `refs` (a ref card's targets, JSON). Plus two
  computed, never-stored columns for old readers: `ts` (= said_at) and
  `missing_since` (always NULL). `card_links` also has `by`.
- **Ids are never reused**, even after a delete (the row stays).
- **Append-only is enforced too:** triggers refuse UPDATE/DELETE on `card_edits`
  and `card_links`, and DELETE on `card_labels`.
- **The old mirror is renamed, not dropped:** `cards_v6_mirror`,
  `card_tags_v6_mirror`. Nothing reads them; a later rung drops them once the
  readers session is done.
- **The app runs its own engine.** routes/cards.py used to run whatever
  `stream.py` sat in the content folder (on the live vault, a shim forwarding to
  the skeleton). It now runs `tools/stream/stream.py` directly with
  `TULKU_STREAM_ROOT` set, because a freshly seeded install's copy can be older
  than the app. **Open:** `content-scaffold/_system/` still ships stale full
  copies of stream.py / keeper_capture.py / reconcile_transcripts.py for new
  installs; they should become shims (logged in the build log).

## What the foundation built

For the readers, nightly-filing and journal-UI sessions. Everything here is live.

**Where things are.**
- `tools/stream/journaldb.py` — the schema (one definition, used by both the
  engine and the ladder), the triggers, and the row operations: `insert_card`,
  `add_label`, `remove_label`, `link`, `record_edit`, `fetch_cards` (rows with
  `tags`, `reply_to`, `edited` filled in), `is_locked(saved_at)`, `locks_at`.
  Standard library only.
- `tools/stream/stream.py` — the engine; every card write goes through it.
- `sqlstore.py` rung 61 — reshapes a database with the old mirror; a brand-new
  database gets the tables at rung 6. `_card_fts_triggers` keeps the word index
  (`cards_fts`) in step.
- `cardstore.py` — compatibility only: `read(cid)` from the rows (old dict shape);
  `sync()` / `sync_one()` / `sync_fresh()` / `rebuild()` only bring in cards that
  exist solely as files (insert-only — never changes a row); `integrity()` is
  always empty.
- `scripts/journal_db_migrate.py` — the one-time move; `--verify-only` re-checks.
- `tools/stream/journal_export.py` — the hourly text export and `load`.

**Tables** (exact columns):
- `cards(id, who, said_at, day, kind, body, refs, fingerprint, door, device,
  session, saved_at, deleted_at, deleted_by)` + computed `ts`, `missing_since`.
  Live cards: `WHERE deleted_at IS NULL`. Fingerprint =
  sha256(`who\nsaid_at\nbody`).
- `card_edits(id, card_id, edited_at, by, before, after)`
- `card_links(from_card, to_card, kind ∈ note|answers, linked_at, by)`
- `labels(id, kind ∈ thread|person|topic|front|source, slug UNIQUE, name,
  status ∈ active|dormant|retired, file, created_at)`
- `card_labels(id, card_id, label_id, added_by, run, reason, weight ∈
  about|touches|NULL, added_at, removed_at, removed_by, removed_why)` — live rows:
  `removed_at IS NULL`.
- view `card_tags(card_id, tag)`.
- Triggers: `cards_locked_update`, `cards_locked_delete`, `cards_saved_at_fixed`,
  `card_edits_append_only_*`, `card_links_never_*`, `card_labels_never_delete`.

**stream.py verbs** (CLI, and the same as functions):
- `record --who B|K|S [--ts] [--tags a,b] [--reply-to ID] [--note-on ID]
  [--door web|hook|reconciler|voice|cli] [--device D] [--by WHO] [--kind]
  [--refs] [--session] [--body-file]` → echoes the id. `record(...,
  note_on=, door=, device=, by=)`.
- `tag ID TAG... [--by WHO] [--run RUN] [--reason "…"] [--weight about|touches]`
  and `untag ID TAG... [--by WHO] [--reason "…"]`. Default `--by` is
  `$STREAM_TAG_BY`, else `cli`. A refused change prints `refused: …` to stderr
  and exits 0; the functions return the card with `.outcomes` per tag.
- `link FROM TO --kind note|answers [--by]` → `link_cards()`.
- `edit ID [--by]` / `delete ID [--by]` — refused with a pointer to `--note-on`
  once the card is locked.
- `drain` — move held cards in. `render --day|--view|--all`. `validate` —
  fingerprints, well-formedness, links, cycles, held cards, view drift.
- Readers: `read_card`, `card_exists`, `load_all_cards`, `load_day_cards`,
  `load_month_cards`, `load_edit_log`, `held_cards`. `Card` gained `door`,
  `device`, `saved_at`, `deleted_at`, `outcomes`.

**Finding the database:** `TULKU_STREAM_DB` (tests) → `EXOCORTEX_DATA_DIR/exo.db`
→ `<content root>/../data/exo.db`. Tests: `tools/stream/conftest.py` and
`tests/conftest.py` give each test its own database; `tests/journal_seed.py`
seeds a card through the real table code.

**Holding file:** `CONTENT_DIR/_system/data/holding_cards.jsonl` (inside the vault,
so held cards are in the hourly commit). Drained by the next successful
`record` and every minute by the reconciler's cron. A held card's echoed id is
provisional; it keeps its time, and is recognized by fingerprint so it never
lands twice.

**Compatibility files — retired.** stream.py used to rewrite each card's old file
`CONTENT_DIR/_system/data/cards/<id>.md` from the row and append edits to
`edited_cards.jsonl`, for readers that still opened files. Once every reader read
the database (see "What the readers built"), `stream.card_files_enabled()` began
defaulting to off (`STREAM_CARD_FILES=1` turns the writer back on, for a test or a
rescue), and the folder and the edit log were removed from the vault (owner,
2026-11-16: "Keep writing copies until the readers session is done"). Tars are in
`/var/tmp/`: `journal-cards-before-db-*.tgz` (cutover),
`journal-cards-retired-20261117-0048.tgz` (all 5,007 files at removal). The words
are also in the vault's git history and the hourly export. `deleted_cards.jsonl` is
no longer written either.

**Hourly export:** `personal/scripts/exo_db_dumps.py` calls
`journal_export.export` before each backup commit: `personal/data/journal/days/
<day>.jsonl` (a card per line, every column), `filing.sql` (labels, card_labels,
card_links, card_edits), `schema.sql`. `exo_db_dumps.py --load` puts them back.

**Retired:** `scripts/update_cards.py` (a pointer now; its cron line is gone) and
the missing-card alarm — replaced by fingerprints + triggers + the holding file.

**Not done here, by design:** nightly filing still writes through `tag`/`untag`
with the old flags only (nightly session). The journal page's reads and notes
were the UI session's — see the next section.

## What the readers built

**Nothing reads the card files any more** — and they're gone (see "Compatibility
files" above). Every reader below asks exo.db.

- **`journalcards.py`** — the app side's one door for reading cards: `live_cards`
  (through `journaldb.fetch_cards`), `read`, `labelled(slug)` → `{card_id: weight}`,
  `cards_labelled(slug, who=, since=)` ranked `about` → `touches` → unjudged (oldest
  first inside each), `tags_for(ids)` (capture facts first, then live labels),
  `editable` / `locks_at` from `saved_at`. Live rows only, everywhere: a deleted card
  or a label with `removed_at` set is never returned. Only history views (the
  journal UI's) read marked-off label rows, and they query the table directly.
- **`scripts/journal_cards.py`** — the agents' reader, replacing grep over the card
  folder: `show ID…`, `day YYYY-MM-DD [--who]`, `tagged SLUG [--since] [--who]`,
  `--json`. The Keeper's `STREAM.md` / `CLAUDE.md` / `PROTOCOLS.md`, the `/thread`
  command, and the crickets (nightly session) point at it.
- **Thread page** (`routes/threads.py`): journal and inbox from the rows. Each card
  entry carries `weight` (how it wears this thread's label; null for a card that's
  there by mention or citation), `editable` and `locks_at` (from `saved_at`). The
  inbox ranks `about` first. The journal stays in time order — the page sorts it
  client-side — so how `about`/`touches` shows there is the UI's call.
- **Person page** (`routes/entities.py` `mention_days`): labelled cards counted by
  the people file's stem (`people/sam-okafor.md` → `sam-okafor`), the first-name key
  as a fallback. The page has no card list, so there is nothing to rank there yet.
- **Streak notes** (`routes/streaks.py`), **approval queue** (`routes/pending.py`
  `_read_card`; `card_untag` already marks the row off through `untag --by owner`,
  now tested), **search** (`cardsearch.py`: no file catch-up — a card is findable
  the moment it's saved), **pond** (`routes/pond.py`: live labels; capture facts
  stay off the thread rail; `/api/pond/card/<id>` asked for old mirror columns and
  500'd — fixed), **name risk** (`namerisk.py`), **mention hook**
  (`tools/mention_context.py`: `card_labels` only), **boot package**
  (`scripts/boot_context.py`: no file sync), **new installs**
  (`standalone_journal.py`: a journal is started once `cards` has a row; no card
  folder is made), **voice** (`routes/ear.py`: no mirror echo).
- **The Rust `thread` tool** (`tools/thread/src/journal.rs`): card-id and bare-day
  sources, and `thread inbox`, read `<data-dir>/exo.db` read-only (rusqlite,
  bundled SQLite). A card that exists only as a file is not a source.
- **Engine fix:** `stream.record` raised when the database was busy during the
  view redraw after a save, though the card had landed — a caller told "failed"
  could save it twice. The redraw after a save is best-effort now.
- **Git history classification**: `data/journal/` (the hourly export) counts as
  journal writes on the pond and terrain, beside the old card-folder prefix.
- **Left as is:** the `card_tags` view (handy in the SQL console; no app code reads
  it now), `cardstore.py` (compatibility: `read`, and `sync*`/`rebuild` that insert
  any card existing only as a file — with no files, they find nothing), the
  `cards_v6_mirror` tables (a later rung drops them).
- **Fixed on the way:** the retired `scripts/update_cards.py` pointer exited 1 (it
  couldn't import `runtime_sensor`), and a new install's hourly job list still ran it.

## What the journal UI built

**`routes/cards.py` reads exo.db** (no card files, no `edited_cards.jsonl`): day
cards via `journaldb.fetch_cards`, history and the "✎ edited an entry from …" rows
from `card_edits`. Its old `_echo_mirror` into the hourly mirror is gone.

**Every card in the API carries its window:** `editable` (inside its 24 hours from
`saved_at`, by the server's clock) and `locks_at`. Plus `note_on` (the card it's a
note on, or null). The day GET adds `notes` — `[{id, date, ts, snippet}]`, live
notes on this card, oldest first — and `reply_context` now covers notes too:
`{id, date, snippet, link: 'note'|'answers'}` (a note wins if a card has both).

**Refusals:** `update` / `delete` on a locked card answer **409** `{error, locked:
true, locks_at}` with a sentence ("This entry locked at 7:34 AM on Jul 9, so it
can't be edited any more. Add a note to it instead.") before the engine is even
run; a lock the engine or trigger catches later is a 409 too. A missing card is a
404. `tag` / `untag` work on any card — labels aren't under the 24-hour rule.

**New endpoints:**
- `POST /api/cards/note {on, body, tags?}` → `record --who B --door web --by owner
  --note-on ON` (said now, so it lands on today's page). Returns the new card.
- `POST /api/cards/meta {ids}` → `{cards: {id: {editable, locks_at, note_on,
  notes}}}` for cards shown off their own day. The thread page uses it, so the
  window and the note links don't depend on the thread route's payload.
- `add` and `note` answer `{id, held: true}` when the card went to the holding
  file instead of a full card.

**What she sees** (`EntryCard.tsx`, `RefCard.tsx`, `ThreadJournalPage.tsx`):
- Inside the window: the pencil, and in the edit box "Can be changed or deleted
  until it locks at 8:47 PM tomorrow." After it: no pencil, no delete.
- A locked entry shows "+ note" where the pencil was. It opens a note box (saved
  today, linked as a `note`) beside the same tag editor, since labels don't lock.
  A locked ref card is simply read-only.
- A note wears "↪ Jul 14: '…'" (the reply chip, extended), tappable to the card.
- An old card with notes shows "N notes added later · Nov 16", opening to the notes;
  each jumps to its own day.
- Thread page: "+ note" makes a real `note` link (tagged into the thread). Notes in
  the thread nest under their card; notes outside it show as "N notes added
  later". The edit window comes from `/api/cards/meta`.
- Person page: it lists day-level mentions, not cards, so there is no card there to
  hang notes under. When it grows card rows, they can ask `/api/cards/meta`.


## What the nightly filing built

For anyone touching the nightly agents. Everything is in `scripts/thread_tending.py`
(its top block walks the night step by step); the prompts are in the crickets folder
(`agents/crickets/` here, the vault's `prompts/crickets/` on a live install).

- **Who signs a label.** Session verdicts are filed `added_by = 'thread-tending'`;
  a person found by plain name matching is filed `'people-cricket'`. `run` is the date
  tended (`YYYY-MM-DD`), so `added_by` + `run` undoes one night. `reason` is the
  session's sentence (`belongs` entries are now `{card, reason}`), or `names "<word>"`
  for a plain match.
- **People: plain code first.** Every name a person file lists is whole-word matched
  on the day's cards (links ignored) unless `namerisk` calls it risky. For this caller
  `namerisk.classify(..., untagged_counts=True)` also calls a common word risky when it
  names someone never tagged — a new "Will" is not trusted on "will" until someone has
  judged one. (`mention_context` keeps the old rule.) Risky names keep their own person
  sessions. A card where plain matching finds **two or more** people goes to one Sonnet
  name-check session (`person-matches.md`) that reads the people files and drops the
  wrong matches; one name on a card is filed by code (owner, 2026-11-17: "use the code
  to do it but send off a sonnet if there's more than one to do the judgement"). The
  main session still sees every surviving match as a tag and can stop it. The 2 AM `cards` cricket
  no longer tags at all: it validates, re-renders and flags.
- **Nothing is written until every session has spoken.** Verdicts are gathered as
  claims; the **overlap session** (`card-overlap.md`, replacing the old reconcile)
  sees each card that will carry two or more weighable labels (thread, person, topic,
  front — never `source`) with the new claims marked, may drop a new claim (never a
  label already on), and picks the one `about`; the rest are `touches`. One label →
  `about`, no session. A failed overlap session leaves every claim standing and those
  cards unweighed (NULL). Labels already on get their weight in place
  (`journaldb.set_weight`); an owner's label keeps a weight once it has one.
  Older labels are weighed once by `thread_tending.py --backfill-weights` (owner,
  2026-11-17): one label → `about` by code, two or more → overlap sessions in batches.
- **Never put back, never questioned.** A claim on a card where that label was ever
  taken off is dropped before it is written (stricter than the engine, which refuses
  only the owner's removals). A removal is proposed only for a live label an agent
  added and not already in the queue.
- **"Asked once, ever" stays a list.** Every removal put to the owner is remembered
  in `state.json`'s `untag_proposed` ("card|tag") and never asked again, whatever she
  answered. Turning one down changes nothing on the card: the label stays the agent's
  (owner, 2026-11-17: "just remember it was asked"; a first build made a turned-down
  label hers, and was undone the same night — the 8 labels it had converted were put
  back as the migration's, their history rows kept). The 3 removals she approved before
  the move got a row marked off by her, so nothing re-adds them. The untag backlog
  file is a waiting line; one already asked, gone, or hers is dropped.
- **Notes.** `load_cards` gives each card `note_on` (the older card's id, time, text,
  tags) from `card_links` kind `note`; every session gets it beside the note. A note
  whose older card carries a thread counts as activity for that thread, so a dormant
  thread gets a session the night a note lands on it.
- **Label status keeps step.** Each night every thread label takes its thread file's
  status (`journaldb.set_label_status`).
