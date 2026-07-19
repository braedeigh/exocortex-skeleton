# STREAM — the journal's card architecture

What this is, why it's shaped this way, and where it deliberately diverges from its
lineage. This is the doc to hand someone who knows fish's exo system: the vocabulary
is his, on purpose.

This is a **stream-cards** journal: an append-only pool of conversation atoms, with
every readable file demoted to a derived, disposable rendering.

---

## 1. One idea

> Cards are atoms in one pool; everything you actually *read* — the daily log, a
> person's history, the monthly index — is a **view** rendered from the pool by a
> deterministic script. Views can be deleted and rebuilt at any time. Only cards are
> truth.

```
_system/data/cards/<id>.md       ← THE POOL. one file per utterance. append-only.
_system/data/manifests/<name>.md ← MANIFEST. a selection rule (tag=sally) + an output path.
_system/data/index/YYYY-MM.md    ← INDEX. one line per card. derived.
Journal/Daily/YYYY-MM-DD.md      ← VIEW. the day, rendered. derived, disposable.
people/views/<name>.md           ← VIEW. one person's cards, inlined verbatim. derived.
```

A card is one utterance with a five-field header:

```
---
id: 2026-07-06.0843b
who: B                        # B = you, K = keeper
ts: 2026-07-06 08:43:12
reply_to: 2026-07-06.0841k    # or null — what this line was answering
tags: [exocortex, architecture]
kind: line                    # line | context (context = the day's header line)
---
make it such that each entry saves as an individual cell...
```

Anything, anywhere, can now point at *this specific moment* — `[[2026-07-06.0843b]]` —
instead of "somewhere in July 6th."

---

## 2. The deliberate divergence from fish: legible ids, not content hashes

Fish's card ids are `sha256(body_hash, parent)` — the `enc:v2` Merkle-DAG. That
scheme exists to solve *his* problem: multiple people appending to a shared pool from
multiple devices over dumb folder sync, with **no server and no git**. Content-
addressing makes distributed writes merge as set union, makes tampering self-evident,
and dedups by construction. The price: opaque hex links, a `normalize()` function
that must stay byte-stable forever, golden tests pinning it, and cards that can never
be edited (an edit changes the id, which cascades to every descendant).

This vault is **one writer, one machine, committed to git hourly**. Git is itself a
Merkle-DAG already doing that exact job — running enc:v2 here would be a Merkle-DAG
inside a Merkle-DAG, and every guarantee it adds (tamper-evidence, history, identity
of content) is one `git log -p` away. Meanwhile hex ids carry zero information to a
reader — human or LLM — scanning an index.

So ids here are **time-based and self-describing**: `YYYY-MM-DD.HHMM` + speaker
letter (+ a counter when the same speaker mints twice in a minute: `0843b`, `0843b2`).
A link tells you *when it was and who spoke* before you read a byte. Cards are
editable when there's a real reason (a screenshot transcription filled into a captured
line) — git records the edit.

If this vault ever goes serverless-multi-writer (fish-mode: others appending to the
raw folder offline, no app in the middle), the upgrade path is the burn-and-rebuild
fish already ran for his own v1→v2: walk the pool in order, remint under the new
scheme, rewrite the `reply_to` pointers. One migration script, priced and survivable.

Everything else is fish's shape: the pool, manifests, derived views, a stdlib-only
deterministic spine, capture-at-source. One addition he doesn't have: **tags** —
this journal's collections are tag-selections rather than reply-subtrees, because a
person or a worry threads through months of unrelated conversation rather than living
under one root card.

---

## 3. The layers

```
  ┌─ Layer 2  capture hook   _system/keeper_capture.py  (your prompt → B card, at source)
  ├─ Layer 1  the keeper     (LLM judgment: K cards, tags, transcriptions — via Layer 0)
  └─ Layer 0  the spine      _system/stream.py          (pure, deterministic, stdlib)
```

**Layer 0 is the product.** `stream.py` is deterministic — same pool in, same bytes
out, no network, no LLM. Everything with judgment in it (what to tag, which question
a K card should carry, what a screenshot says) happens *above* the spine and enters
the pool *through* it. The fragile smart parts only ever feed the sturdy dumb part.
(Fish runs a daemon and an Obsidian plugin between his layers; this vault needs
neither — the hook and the keeper call the CLI directly.)

### The verbs (Layer 0)

| verb | does |
|---|---|
| `record` | **the primitive.** stdin body + `--who/--reply-to/--tags/--ts/--kind` → mint the card, re-render the day view + month index, echo the id. Every card is born here, exactly once. |
| `render` | rebuild derived files from the pool: `--day YYYY-MM-DD`, `--view <manifest>`, or `--all`. Never touches a day with no cards (pre-cutover history stays untouched). |
| `tag` / `untag` | edit a card's tags; re-render the day, the index, and any manifest that selects an affected tag. |
| `validate` | every card parses, id matches filename, `reply_to` resolves, the reply graph is acyclic; then re-render everything in memory and flag any derived file that drifted from the pool (`DRIFT`). |

### Capture: your line by hook, the keeper's by hand — both through `record`

- **Your prompts → `B` cards.** `keeper_capture.py` (UserPromptSubmit hook) mints a
  card the instant you hit enter, out of the agent's discretion — the fix for "you
  forgot to publish some of my inputs," inherited from fish's capture-at-source
  pattern. The keeper-session arming (the `KEEPER_SESSION_ACTIVE` sentinel latch) is
  unchanged; dev sessions at the same root are never captured.
- **The keeper's questions → `K` cards, minted deliberately.** When you answer a
  question the keeper asked, the keeper mints a K card carrying *that question only*
  (never commentary — the daily-log content rule is unchanged) and sets your B card's
  `reply_to` to it. The exchange becomes a referenceable unit.
- **Screenshots.** The hook can't read images, so an image upload lands as a near-empty
  B card; the keeper edits that card's body with the verbatim transcription and
  re-renders. This is the one sanctioned edit of a captured card.

---

## 4. Views are lenses, not boxes

The day file renders exactly as the journal always looked — header, legend, context
line, gap timestamps, `B:`/`K:` lines — but every line is traceable to a card, and
the file itself is disposable. **Don't hand-edit a view**; edit the card (or mint a
new one) and `render`. `validate` catches a view that drifted.

A **manifest** is a one-line selection rule:

```
---
select: tag=sally
render: inline
out: people/views/sally.md
---
```

`render --view sally` inlines every `sally`-tagged card — your verbatim words, in date
order, each under its `[[id]]` — into `people/views/sally.md`. The hand-curated
summary in `people/sally.md` stays as interpretation; the view underneath it is
receipts. The same machinery is the intended future home of THREADS/WORRIES splitting
(a worry = a tag = a self-rendering view); that phase is not built yet.

**Who tags:** the keeper, live in-session (it's already reading every line);
`/endsession` sweeps the day's untagged cards; a nightly cricket audits and
backfills. Tags are judgment, so they live at the edges — never in the spine.

---

## 5. Where it breaks (known edges, accepted)

- **A card edit is trusted, not detected.** Without content hashes, `validate` can't
  tell an edited card from an original — git history is the audit trail. That's the
  trade taken knowingly (§2).
- **Tags are only as good as the taggers.** An untagged card is invisible to every
  manifest view. The endsession sweep + cricket audit are the safety net; the month
  index (which lists *every* card) is the backstop where nothing can hide.
- **Pre-cutover history is not card-addressable.** Days before the cutover
  (2026-07-06) are plain markdown — searchable, but nothing smaller than a day can be
  linked. Backfill was deliberately deferred; `cutover_cards.py` (which converted the
  cutover day itself, byte-identically) is the parser to extend if it's ever wanted.
- **Same-minute ordering leans on seconds.** Ids carry minutes; the `ts` field keeps
  seconds and the renderer sorts by (`ts`, `id`). Two cards minted the same second
  order by id — stable, if arbitrary.

---

## 6. Provenance

Ported from Ian Fish's exo **stream-cards** vault design: pool/manifest/view split,
capture-at-source, deterministic stdlib spine, derived-never-stored membership.
Divergences: legible time ids for enc:v2 hashes (§2), tags for reply-subtree
manifests (§4), no daemon/plugin layers. Same grounding — log-as-source-of-truth,
materialized views over an event log (Kleppmann, *DDIA*, ch. 11–12).
