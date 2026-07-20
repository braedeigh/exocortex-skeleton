# Batch B scrub log — cricket swarm

Source: `personal vault scripts/{cricket_swarm,cricket_housekeep,cricket_run}.sh` and
`personal vault prompts/{crickets/*,cricket_housekeep.md,cricket.md}` (read-only).
Destination: `skeleton/agents/crickets/`, `skeleton/scripts/`. Copy, not move; vault
untouched, no git run, no services restarted.

Placeholder legend (prompts/docs): `<OWNER_NAME>`, `<VAULT_DIR>`, `<SKELETON_DIR>`
(literal tokens, per the shared contract). Shell scripts use env vars with
overridable defaults instead: `EXOCORTEX_VAULT_DIR` (default
`/opt/exocortex/vault`), `EXOCORTEX_SKELETON_DIR` (default
`/opt/exocortex/skeleton`), `CLAUDE_BIN` (default `$HOME/.local/bin/claude`),
`EXOCORTEX_OWNER_NAME` (default `the owner`).

**Note on this log itself:** entries below name the *kind* of value that was scrubbed
(a real given name, a real absolute vault path, a real Linux home directory, real
contact-example names, a real city/university) and never repeat the actual value —
consistent with the instruction that this log record kinds, not secrets, and never
real people's names.

## agents/crickets/ (prompts)

### roster
Origin: `prompts/crickets/roster` → Dest: `agents/crickets/roster`
- Scrubbed: directory reference `prompts/crickets/<id>.md` → `agents/crickets/<id>.md`
  (the prompts now live in the skeleton repo, not the vault — see script changes
  below).
- Changed `long-covid` and `people` rows from `on` to `off`, with a comment pointing
  at `examples/` — both carry personal schema/names in their prompt bodies (see the
  two entries under `examples/` below) and ship as inert worked examples rather than
  live crickets. `front-health` was already effectively personal-context-dependent
  (assumes a "health" front thread exists); its row comment now says so explicitly
  and it ships `off`.
- No personal values were present in the roster file itself (id/model/on-off/comment
  columns only) — the scrub here is structural (paths, on/off state), not PII removal.

### _base.md, _template.md
Origin: `prompts/crickets/_base.md`, `prompts/crickets/_template.md` → Dest: same
filenames under `agents/crickets/`.
- Scrubbed: possessive references to the owner by their real given name (e.g. "<the
  owner>'s swarm," "her journal," "she taps Approve/Deny," "Judgments are hers") →
  reworded to "the swarm," "the owner's journal," "the owner taps," "Judgments are
  the owner's." No literal path token existed in either file — this was
  pronoun/possessive genericization, not a `<PLACEHOLDER>` substitution, following
  the same approach the mailclaude batch used for its clerk persona file.
- Added an explicit `PLUG-IN(PENDING_HANDLER)` note in `_base.md` pointing at
  `routes/pending.py` as where a new staged `kind` gets its commit handler — the
  original assumed the reader already knew this; the skeleton copy needs to say it.
- `_template.md`'s worked-example door line originally pointed at "the todo cricket's
  `add-todo --stage`" — but the actual `todos.md` cricket (both original and migrated)
  stages directly because the `add-todo` tool can't set Focus/Category, so that
  cross-reference was already stale in the source. Repointed the example to the
  `people` cricket's validated-CLI-tool pattern instead (accurate in both the
  original and the migrated copy). Not a personal-data scrub — a factual correction
  made in passing.

### todos.md, food.md, contacts.md
Origin: `prompts/crickets/{todos,food,contacts}.md` → Dest: same filenames.
- Scrubbed: every reference to the owner by their real given name, plus every "she" /
  "her" pronoun → "the owner" / neutral phrasing throughout all three files (e.g.
  "tasks she named for herself" → "tasks named for themself"; "people she actually
  talked to" → "people actually talked to").
- `food.md`'s door description cited a stale path
  (`static/js/approvals/food.js`) that predates this app's move to the React
  frontend; corrected to the real current file
  (`frontend/src/features/approvals/FoodApprovalEditor.tsx`), confirmed against
  `routes/health.py`'s actual `/api/food/set` route. Not a scrub — a staleness fix
  made in passing, called out here since it changes file content beyond
  de-personalization.
- `todos.md`'s Focus/Category taxonomy (health/job/move/admin/life/exocortex,
  body/kitchen/money/car/inventory/meditation) is this app's real, already-generic
  field vocabulary (matches `routes/todos.py`), not personal data — left as a
  concrete worked example but wrapped in a `PLUG-IN(THEMES)` note inviting
  replacement, since it's still one specific taxonomy choice a new owner may not
  want verbatim.

### cards.md
Origin: `prompts/crickets/cards.md` → Dest: `agents/crickets/cards.md`
- Scrubbed: a literal absolute vault filesystem path to the stream-cards engine
  script (3 occurrences) → `<VAULT_DIR>/tulku/_system/stream.py`. This was the one
  hit in this batch that the finish-gate's real-vault-path pattern would have caught
  directly.
- Scrubbed: a personal, date-stamped attribution in the job description naming the
  owner directly as the sole tagger as of a specific date. Reworded to a
  `PLUG-IN(TAGGER)` comment explaining that who tags cards (sole tagger vs.
  backfill-only) is a per-vault choice, without repeating the name or date.
- Scrubbed: a specific migration-cutover date (a "pre-cutover" daily-file cutoff) —
  not personal-identifying on its own, but a piece of the original owner's specific
  migration history with no generic meaning. Genericized to "if the vault has any
  plain-markdown daily files predating adoption of the stream-cards engine," with a
  `PLUG-IN(CUTOFF_DATE)` note for anyone who wants to name an exact date for their
  own vault.
- Pronoun cleanup ("her words" → "their words"; "for <the owner> or the keeper" →
  "for a human").

### front-health.md
Origin: `prompts/crickets/front-health.md` → Dest: `agents/crickets/front-health.md`
- Scrubbed: literal absolute paths to the `thread` CLI binary and its
  `--content-dir`/`--data-dir` vault paths → `<SKELETON_DIR>/tools/thread/...` and
  `--content-dir <VAULT_DIR>/tulku --data-dir <VAULT_DIR>/data`.
- Per the migration's special-case instruction: genericized into a "front tender"
  template — added a `PLUG-IN(FRONT)` note up top explaining this copy is wired for
  `health` as a worked example and how to retarget it at a different front. Left
  `health` as the concrete example throughout the body (rather than a `<FRONT>`
  token everywhere) since the roster ships this cricket `off` specifically because it
  assumes a "health" front exists — per the brief, "front-health ships off with a
  note."
- Scrubbed: a reference to a specific chronic-illness thread slug as "the usual
  health hub" parent thread — the owner's actual health-condition thread, i.e.
  personal health information, used as a throwaway example. Reworded to "a standing
  hub thread is the usual parent, if this vault has one."
- Pronoun cleanup ("her words" → "their words", etc.) throughout.

### thread-scout.md
Origin: `prompts/crickets/thread-scout.md` → Dest: `agents/crickets/thread-scout.md`
- Scrubbed: same CLI-binary/vault-path pattern as `front-health.md` →
  `<SKELETON_DIR>`/`<VAULT_DIR>` placeholders.
- Pronoun cleanup only otherwise; no personal names or schemas in this file.

### housekeep.md
Origin: `prompts/cricket_housekeep.md` → Dest: `agents/crickets/housekeep.md`
(renamed from `cricket_housekeep.md` to match the short, prefix-free filename
convention already used by the other files in this directory; judgment call, see
below).
- Scrubbed: the owner's literal real given name (2 occurrences — once describing who
  the Keeper reflects with, once describing who approves staged retirements at the
  gate) → `<OWNER_NAME>`, each with an inline `PLUG-IN(OWNER_NAME)` comment. This is
  the second hit in this batch that the finish-gate's real-name pattern would have
  caught directly.
- Scrubbed: the same CLI-binary/vault-path pattern as above, plus a standalone
  `people` validator invocation using the same absolute paths → `<SKELETON_DIR>`/
  `<VAULT_DIR>` placeholders.
- Scrubbed: the weekly people-tagging section's worked tag examples — the owner's
  actual city, the owner's actual PhD institution, and a specific real agency name —
  these are personal-identifying details, not generic illustrations, even though
  none of them are on the strict finish-gate string list. Replaced with abstract
  descriptions of the tag *categories* (place / circle / role / relationship)
  instead of concrete personal values.
- Added a `PLUG-IN(WEEKLY_PROTOCOL)` note up top: this cricket assumes a
  `tulku/SUNDAY.md` protocol file, `tulku/people/`, and the `thread`/`people` CLIs —
  all extensions layered on top of the base `content-scaffold/`, not present out of
  the box. Flagged so a new owner doesn't wire this cron job up against a
  `SUNDAY.md` that doesn't exist yet.
- Pronoun cleanup throughout ("She witnesses..." → "The Keeper witnesses...", etc.).

### examples/long-covid.md
Origin: `prompts/crickets/long-covid.md` → Dest:
`agents/crickets/examples/long-covid.md`
- Per the migration's special-case instruction: the whole file's job *is* a personal
  health-tracking schema (a specific long-COVID symptom taxonomy), so it moves to
  `examples/`, ships `off` in `roster`, and the field table is now presented under an
  explicit `## PLUG-IN(SYMPTOMS)` heading with a "replace with the fields YOU track"
  instruction, rather than presented as this cricket's fixed, only behavior. The
  symptom field names and 0-3 scoring convention are kept verbatim as the worked
  example, per instruction — this is a health-tracking *pattern*, not the owner's
  actual health data, and contains no name/contact/location information.
- Scrubbed: a stale door reference (a pre-React-frontend static JS path) → reworded
  to "the dashboard's symptoms approval editor" without asserting a specific (and
  wrong) file path, since the current React equivalent wasn't confirmed to exist
  under that name.
- Pronoun cleanup throughout.

### examples/people.md
Origin: `prompts/crickets/people.md` → Dest: `agents/crickets/examples/people.md`
- Per the migration's special-case instruction: moved to `examples/`, ships `off`.
  The `people` CLI tool this cricket drives is itself generic and already lives in
  `tools/people/` in this repo — the reason for demoting this cricket to an example
  is entirely that its illustrations used the owner's real contacts.
- Scrubbed: real example names throughout (a first-name file example, its
  disambiguated-qualifier variants, and two "new person" introduction examples) →
  invented neutral names not drawn from the vault's actual `tulku/people/` roster
  (verified by cross-checking the replacement names against that directory's real
  filenames — no collision).
- Scrubbed: a location-tag example (the owner's actual real-world city, per the
  vault's own `CLAUDE.md`) in the frontmatter-tags worked example → replaced with an
  invented placeholder city name. Judgment call: not one of the strict finish-gate
  strings, but a real personal-identifying detail found via cross-reference with the
  vault's own context file, so scrubbed on the same principle as the fake-name
  sweep.
- Scrubbed: `people`-binary and `--content-dir` absolute paths →
  `<SKELETON_DIR>`/`<VAULT_DIR>` placeholders.
- Minor: one "new person" example's flavor detail (a specific dating-app brand name)
  was dropped as unnecessary specificity, keeping the same shape of example.

### README.md
New file — not sourced from the vault, written fresh for this batch (what the swarm
is, how roster+`_base.md`+prompts compose, the staged-approval flow through
`routes/pending.py`, how to write a new cricket from `_template.md`, and a pointer to
`deploy/crontab.template.txt` for cron wiring). No personal content to scrub.

## scripts/ (runners)

### cricket_swarm.sh
Origin: `scripts/cricket_swarm.sh` → Dest: `scripts/cricket_swarm.sh`
- Scrubbed: a hardcoded absolute vault filesystem path (the `VAULT=` assignment) →
  `VAULT="${EXOCORTEX_VAULT_DIR:-/opt/exocortex/vault}"`.
- Scrubbed: a hardcoded absolute path under the real Linux home directory (the
  `CLAUDE_BIN` default) → `CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"` —
  this was the one hit in this batch the finish-gate's home-directory pattern would
  have caught directly.
- Scrubbed: the owner's real given name in the header comment ("run <owner>'s
  cricket swarm") and in the spawned-agent prompt text ("You are one cricket in
  <owner>'s swarm") → uses the new `OWNER_NAME="${EXOCORTEX_OWNER_NAME:-the owner}"`
  env var instead.
- **Architectural change (not a placeholder swap):** the original computed the
  cricket-prompts directory as a subpath of the vault — the prompt files lived in
  the vault. Since this batch moves those prompts into the skeleton repo
  (`agents/crickets/`), the migrated script adds
  `SKELETON="${EXOCORTEX_SKELETON_DIR:-/opt/exocortex/skeleton}"` and computes
  `CRICKETS="$SKELETON/agents/crickets"` instead. The script still `cd`s into
  `$VAULT` before spawning each cricket, so the relative paths inside the prompt
  files (`tulku/Journal/Daily/...`, `data/pending_changes.json`) keep resolving
  against the vault's data — only the *prompt-file lookup* moved. The spawned-agent
  instruction text was updated to say "operating in the vault at ${VAULT}" so a
  cricket reading its own prompt file (now outside its cwd) still knows where its
  data lives.
- Log path left at `$VAULT/scripts/cricket_swarm.log` (not moved into the skeleton
  checkout) — consistent with Batch A's judgment call that runtime logs shouldn't
  land inside a repo whose own `CLAUDE.md` says it "carries no personal data."

### cricket_housekeep.sh
Origin: `scripts/cricket_housekeep.sh` → Dest: `scripts/cricket_housekeep.sh`
- Same vault-path/home-directory scrub as `cricket_swarm.sh` above (this file had no
  literal owner name in its comments — only the two hardcoded absolute paths).
- Same architectural change: added `SKELETON` and a
  `HOUSEKEEP_PROMPT="$SKELETON/agents/crickets/housekeep.md"` variable, replacing
  the original's vault-relative prompt-file reference. `cd`s into `$VAULT` before
  running, same reasoning as above.
- Log path left at `$VAULT/scripts/cricket_housekeep.log`.

### cricket_run.sh
Origin: `scripts/cricket_run.sh` → Dest: `scripts/cricket_run.sh`
- Kept **as historical reference only**, per the migration brief — this is the
  single-agent predecessor to the swarm. Added a prominent `DEPRECATED` banner at
  the top explaining it isn't wired into any cron in this repo and won't fully
  function as-is.
- Same vault-path/home-directory scrub as the other two scripts (this file had no
  literal owner name either — mechanics-only comments).
- The prompt file it invoked (the legacy monolith prompt) is explicitly **not
  migrated** in this batch (see "Left in vault," below) — the script's
  `PROMPT_FILE`/`CRICKET_LEGACY_PROMPT` variable defaults to the same vault-relative
  path the original used, so the script's *shape* is preserved, but it will fail to
  find that file unless a user supplies an equivalent of their own or points the env
  var elsewhere.

## Left in vault (not migrated)

- **The legacy monolithic cricket prompt** (`prompts/cricket.md`). Explicitly out of
  scope per the migration brief ("skip, note in log"): every job it did (food/sleep/
  symptoms/exercise extraction, contact logging, the weekly close, the to-do roll)
  has since been split out into the swarm's individual crickets plus `housekeep.md`,
  so nothing is lost by skipping it — it would just be redundant, stale, and
  re-introduce the owner's specific health/food/contact examples embedded in its
  prose. Referenced only from `cricket_run.sh`'s deprecation banner, not treated as
  present.
- **The legacy prompt's referenced "tomes"** (a grocery-receipt-processing prompt
  and a receipt-OCR prompt) — not in this batch's source file list at all
  (receipt/grocery processing is a different subsystem); not referenced by any
  migrated file since the legacy monolith itself isn't migrated.
- **`*.log` files** (the swarm, housekeeper, and legacy-run logs) — runtime
  artifacts and personal operational history, not source. Never migrated,
  consistent with Batch A's precedent; a fresh instance produces its own.
- **`tulku/SUNDAY.md`, `tulku/people/`, `tulku/Threads/`, `tulku/context/about.md`,
  `tulku/WORRIES.md`, `tulku/THREADS.md`** — vault *content*/extensions that several
  crickets read or write, referenced only via `<VAULT_DIR>/tulku/...`-relative paths
  with `PLUG-IN` notes where the assumption is load-bearing (`housekeep.md`,
  `front-health.md`). These are content-layer, not this batch's scripts/prompts
  scope, and several of them (`SUNDAY.md`, the `Threads/` architecture, `people/`)
  are the *original owner's own* extensions on top of the base
  `content-scaffold/` — a new owner would need to write or adapt equivalents, not
  just fill in a placeholder.
- **A vault-side Threads design doc** that `front-health.md`, `thread-scout.md`, and
  `housekeep.md` all cite as "the design of record" for the `thread` CLI / Threads
  system (`docs/threads-architecture.md` in the vault's own `docs/`). **This doc
  does not currently exist anywhere in the skeleton repo** (confirmed: the
  skeleton's `docs/` has no matching file) — it's outside this batch's touch-list
  (`docs/` in general, only `docs/scrub-log/B-crickets.md` is authorized), so it
  could not be migrated here. Flagging this as a **cross-batch gap**: the three
  files above reference a doc a reader of this repo cannot currently find. Whoever
  owns the `docs/` migration (or a follow-up batch) should bring that design doc
  over; until then, treat those citations as pointing at something you'd need to
  write yourself alongside the `thread`/Threads extensions noted above.
- **`tools/thread`, `tools/people`, `tools/add-todo`** — the Rust CLI binaries these
  crickets shell out to. These already exist in the **skeleton** repo (not the
  vault) and were out of scope for this batch either way — referenced only via the
  `<SKELETON_DIR>/tools/...` placeholder paths per the migration brief.

## Judgment calls

1. **The prompt-file lookup path moved from vault-relative to skeleton-absolute in
   both runner scripts** (`cricket_swarm.sh`'s `CRICKETS`, `cricket_housekeep.sh`'s
   `HOUSEKEEP_PROMPT`) — a real behavioral/architectural change, not a mechanical
   placeholder swap. This is the batch's core "modularize" instruction made
   concrete: the prompts are now a versioned module living in the shareable repo,
   while the vault stays pure data/content. Both scripts still `cd` into `$VAULT`
   before spawning a cricket so relative in-prompt paths keep resolving correctly;
   only where the *prompt files themselves* are found changed.
2. **`housekeep.md` was renamed from `cricket_housekeep.md`** to match the
   prefix-free naming already used throughout `agents/crickets/` (`todos.md`,
   `food.md`, not `cricket_todos.md`). The brief's "keep filenames" instruction
   named `roster`, `_base.md`, `_template.md`, and the individual per-domain
   crickets explicitly by their existing short names; it didn't name
   `cricket_housekeep.md`, so this rename was treated as in scope for consistency.
   `cricket_housekeep.sh` was updated to reference the new path.
3. **`front-health.md` keeps `health` as a concrete worked example throughout**,
   rather than replacing every occurrence with a `<FRONT>` token. The brief's own
   framing for this file ("ships off with a note... assumes a 'health' front
   thread") reads as: keep it concrete and clearly labeled as an example, don't
   template-ify every sentence. The `PLUG-IN(FRONT)` note up top carries the
   "how to retarget this" instruction instead.
4. **Two stale cross-references were corrected in passing** (`_template.md`'s
   `add-todo --stage` example; `food.md`'s pre-React frontend path) — both were
   already inaccurate in the vault source relative to this app's current shape (the
   todos cricket actually stages directly; the frontend moved to React). These
   aren't de-personalization scrubs, but leaving a freshly-migrated file pointing at
   a path that doesn't exist felt worse than fixing it, so they're called out
   explicitly here rather than silently changed.
5. **A few personal-but-not-on-the-strict-grep-list details were scrubbed anyway**:
   a chronic-illness thread-slug example in `front-health.md`, and city/university/
   agency tag examples in `housekeep.md` and `examples/people.md`. None of these
   match the finish-gate's literal string list, but all are real, checkable
   personal facts about the vault's owner (cross-referenced against the vault's own
   top-level `CLAUDE.md`) used as throwaway illustrations. Scrubbing them follows
   the stated *spirit* of "de-personalized and modular" even where the letter of
   the grep gate wouldn't have caught them.
6. **`examples/long-covid.md`'s symptom schema was kept, not removed or invented
   from scratch** — per the brief's explicit instruction to turn it into an
   explicit PLUG-IN schema section. This is a health-tracking *pattern* (field
   names + a 0-3 severity convention), not a health *record* — no dates, no actual
   logged values, no name. Treated as the one case in this batch where "personal
   schema" content is the deliberate, instructed deliverable rather than something
   to scrub away.

## Verification

- The finish-gate name/path sweep (real given name, alternate personal identifier,
  email-shaped variant, real absolute vault path, real absolute home directory) over
  `agents/crickets/` and the three migrated scripts, **and this log file** → 0 hits.
  (The exact pattern isn't quoted literally in this sentence, to avoid the log
  matching its own verification command.)
- A second sweep for the vault's real `tulku/people/` example names referenced in
  the source `people.md` cricket (a landlord example, two other first-name
  examples, two disambiguated-qualifier examples, and the two "new person"
  introduction names) over the same file set, **including this log** → 0 hits; all
  replaced with invented names not drawn from that roster.
- `bash -n` on `scripts/cricket_swarm.sh`, `scripts/cricket_housekeep.sh`,
  `scripts/cricket_run.sh` → all three pass.
- Roster parses correctly under the runner's actual `read`/`awk` logic (multi-line
  wrapped comments on the `long-covid`/`people`/`front-health` rows were verified
  to be skipped as comment lines, not misread as extra roster rows).
