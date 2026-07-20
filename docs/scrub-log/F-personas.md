# Batch F scrub log — personas

Source: `personal vault claude-commands/` (read-only) — `thread.md`, `spark.md`,
`thistle.md`, `terra.md`, `gardener.md`. Destination: `skeleton/claude-commands/`
(first three) and `skeleton/claude-commands/examples/` (last two, demoted to
examples — see "Left in vault" and the per-file notes below). Copy, not move; vault
untouched, no git run. Symlinks added in `.claude/commands/` for the three
non-example commands, mirroring the existing `journalstart.md`/`endsession.md`
pattern; no symlinks for `examples/`.

Placeholder legend (same as prior batches): `<OWNER_NAME>` / "the owner"
(they/them), `<VAULT_DIR>` (the private vault checkout), `<SKELETON_DIR>` (this
skeleton checkout). These five files are Claude Code slash-command prompts, run
with cwd at the skeleton repo root — so, following the convention already
established by the migrated `journalstart.md`/`endsession.md`, relative-path
references to the owner's journal/content (`Journal/Daily/`, `context/about.md`,
`CLAUDE.md`) are written as `data/...` (the `EXOCORTEX_CONTENT_DIR`-resolved
convention), not as absolute vault paths.

**Note on this log itself**, same convention as the sibling files in this
directory: entries below name the *kind* of value that was scrubbed (the owner's
real given name, the vault's real absolute path, a real third party's name) and
never repeat the actual value — this file has to pass the same
de-personalization sweep as the migrated files themselves.

## Files

### thread.md
Origin: `claude-commands/thread.md` → Dest: `claude-commands/thread.md`
- Described in the migration brief as "genuinely generic machinery" needing only
  path placeholdering — confirmed on read: no owner name, no gendered gossip, just
  a conversation-opener command with hardcoded absolute paths.
- Scrubbed: the owner's real given name (1 occurrence, "Bradie tapped..."; the
  vault original's frontmatter `description:` also named her) → "the owner" /
  "they", consistent with the rest of this batch. `description:` reworded to drop
  the name without changing what the command does.
- Scrubbed: five absolute vault paths (`/opt/exocortex/personal/tulku/Threads/`,
  `/opt/exocortex/personal/tulku/Journal/Daily/`, two bare-path resolution rules,
  and the `tulku/CLAUDE.md` pointer) → remapped onto the `data/`-relative
  convention (`data/Threads/`, `data/Journal/Daily/`, `data/CLAUDE.md`), per the
  brief's explicit instruction to align with `content-scaffold/`'s layout where
  sensible. See judgment call 1 — this is a structural remap, not just a token
  swap, since the vault's `tulku/`-nested layout and the skeleton's flat
  `data/`-as-content-root layout aren't the same shape.
- Added a `PLUG-IN(THREADS)` comment noting that `data/Threads/` isn't part of
  the base `content-scaffold/` seed (verified by reading
  `content-scaffold/CLAUDE.md` — it has no concept of threads) — it's a
  structure the original author built on top of the journal, so the command is
  inert on a fresh install until someone adds one.
- The example card-id token (`2026-07-08.1841b`) and bare day (`2026-07-08`) were
  left as-is — they're schema-format illustrations, not real personal dates or
  facts, same treatment as similar IDs kept elsewhere in this migration.

### spark.md
Origin: `claude-commands/spark.md` → Dest: `claude-commands/spark.md`
- Persona voice and the "How to Work" bullets kept structurally intact — the
  brief called this "genuinely generic machinery" wrapped in a persona, and nothing
  in that voice or those working rules is owner-specific.
- Scrubbed: the owner's real given name (~9 occurrences) → "the owner", with
  gendered pronouns referring to *the owner* normalized "she/her" → "they/their"
  throughout (same convention as batch D's judgment call 1). Pronouns referring to
  **Spark itself** ("become her") were left as-is — see judgment call 2, same
  reasoning applies to `thistle.md`.
- Scrubbed: `/opt/exocortex/personal` and `/opt/exocortex/skeleton` absolute
  paths (~10 occurrences across the "What They're Building" and "Where everything
  lives" sections) → `<VAULT_DIR>` / `<SKELETON_DIR>`, with a `PLUG-IN` comment
  noting the two checkouts don't need a shared parent directory (the original
  assumed both live under one `/opt/exocortex/` — see judgment call 3).
- Scrubbed: the specific GitHub remote names (`exocortex-skeleton`,
  `exocortex-personal`) — dropped rather than placeholdered, since a fresh fork
  won't share this deployment's remote names and asserting them as fact would be
  actively wrong for anyone else. See judgment call 4.
- Scrubbed: the "self-healing" aside about historical hyphenated paths
  (`/opt/exocortex-personal`, `/opt/exocortex-skeleton`) — this is trivia about
  *this specific deployment's* history, not a generally true fact a fresh clone
  would ever encounter. Kept the underlying advice (verify paths with `ls`,
  don't trust a stale doc) in generic form. See judgment call 4.
- Scrubbed/updated: the "Where everything lives" file listing and the "Build
  loop" section described a **stale architecture** — `static/js/`, `static/css/`,
  `templates/` as "the frontend," and "After static/JS/CSS/template edits: just
  refresh." The live skeleton's own `CLAUDE.md` (read for this batch, not
  modified) documents a React/vite frontend in `frontend/src/` built to
  `frontend/dist/`, requiring `npm run build` before a refresh does anything —
  `templates/` is now only the server-rendered login page. Shipping the old
  instructions into the shared repo would hand a fresh dev-partner session
  actively wrong build instructions. Updated to match `CLAUDE.md`'s current
  "Working here" section, with a hedge for forks still on the older frontend.
  See judgment call 5.
- Scrubbed: the per-tab list for `dev_notes.json` (`today, kitchen, map,
  inventory, body, money, movement, personality, global`) — cross-checked against
  the live `frontend/src/features/ideas/byPage.ts` `IDEAS_TAB_ORDER` constant and
  found already stale (missing/extra tabs relative to the vault copy). Rather
  than migrate a second stale list, reworded to point at that file as the
  current source of truth. See judgment call 5.
- Scrubbed: `/opt/exocortex/personal/dev_todo.md` and `docs/IDEAS.md` — per
  `CLAUDE.md`'s own note (read, not modified) that `dev_todo.md` was moved out of
  the skeleton into the private vault as a personal-context file, and
  `docs/IDEAS.md` is likewise vault-only (`EXOCORTEX_IDEAS_FILE`, per
  `docs/SETUP-FULL.md`) — neither ships with a fresh skeleton clone. Reworded
  both as PLUG-IN-style "if the owner keeps one" pointers rather than asserted
  facts, and added a `PLUG-IN(APP_VISION)` comment on the "What They're Building"
  section since that paragraph describes the original author's own product
  vision, not a universal fact about every fork.
- `dev_notes.json` itself (the per-tab notes JSON) was **not** placeholdered —
  confirmed via `routes/devnotes.py` that this is a real, generic, already-shared
  skeleton feature (not vault-side, not personal), so `data/dev_notes.json` is
  accurate for any fork as written.

### thistle.md
Origin: `claude-commands/thistle.md` → Dest: `claude-commands/thistle.md`
- Persona voice and design-review mechanics ("How you work" bullets) kept intact
  per the brief.
- Scrubbed: the owner's real given name (~15 occurrences) → "the owner",
  gendered pronouns for *the owner* → they/their throughout. Pronouns referring
  to **Thistle itself** ("become her") left as-is — judgment call 2.
- Scrubbed: a real third party's given name (the owner's designer friend,
  credited by name as the source of the UI house rules) → "the owner's designer
  friend" (role only, no placeholder token — per the migration brief's explicit
  instruction for this exact reference). Added a `PLUG-IN(DESIGN_BONES)` comment
  explaining the substitution, same pattern as batch D's third-party-credit
  handling (judgment call 2 there).
- Scrubbed: the Austin-sun theme reference (`time-of-day driven from Austin's
  sun`) → generalized to reference the theme engine's actual current file
  (`frontend/src/theme/solar.ts`, confirmed by reading it — hardcoded Austin
  coordinates, real code, out of scope to modify this batch) with a
  `PLUG-IN(LOCATION)` comment flagging that a fork elsewhere needs to edit that
  file's coordinates, rather than asserting the Auto mode already tracks "the
  local sun" generically. See judgment call 6.
- Scrubbed/updated: `static/css/style.css`, `static/js/sky-theme.js`,
  `templates/*.html` (the vault copy's stale frontend file list, same issue as
  `spark.md`) → updated to the current `frontend/src/theme/`,
  `frontend/src/features/*.module.css`, `frontend/src/**/*.tsx` layout, with a
  `PLUG-IN(FRONTEND_PATHS)` comment giving the old paths as a fallback for forks
  still on the pre-React frontend. See judgment call 5 (same reasoning as
  `spark.md`).
- Scrubbed: `/opt/exocortex/personal` / `/opt/exocortex/skeleton` absolute paths
  and the GitHub-remote-name / historical-hyphenated-path asides → same treatment
  as `spark.md` (judgment calls 3 and 4).

### examples/terra.md
Origin: `claude-commands/terra.md` → Dest: `claude-commands/examples/terra.md`
- Per the migration brief: shipped as an **example of a pattern** (a persona
  whose whole job is holding a values doc the owner writes themself), not a
  ready-to-use command — demoted to `examples/`, no `.claude/commands/` symlink.
- Added an italic adoption preamble (matching the register already used by
  `agents/crickets/examples/*.md` in batch B) explaining what the pattern is,
  why it's an example rather than a live command, and how to adopt it.
- The six-question lens (the numbered "How you judge" list) kept **verbatim** —
  explicitly instructed, and it's the reusable shape the example exists to show.
- Scrubbed: `/opt/exocortex/personal/docs/BEDROCK.md` (the one file this persona
  reads every boot) → `<VAULT_DIR>/docs/BEDROCK.md`, wrapped in an explicit
  `PLUG-IN(BEDROCK)` block per the brief's instruction: "write your own
  `<VAULT_DIR>/docs/BEDROCK.md`; this persona is inert without it." No default
  bedrock content was invented — see judgment call 7.
- Scrubbed: the owner's real given name and gendered pronouns → "the owner" /
  they-them, same as the rest of this batch. Pronouns referring to **Terra
  itself** ("become her") left as-is — judgment call 2.
- Scrubbed: the "You are not the others" cross-references to Spark/Thistle/the
  Keeper/"Tiller" (a job-search persona named in the original) — reworded as
  conditional pointers ("if you've set one up") since `examples/terra.md` may be
  the only persona command a given fork has installed; asserting `/spark` and
  `/thistle` exist would be a broken promise for anyone who only adopted this one
  example. "Tiller" itself — cross-checked against this batch's source list,
  where the corresponding file (`shrike.md`, the job-hunt persona named in the
  migration brief) was searched for and **not found** in the vault's
  `claude-commands/` — see "Left in vault" below.
- Scrubbed: `/opt/exocortex/personal` / `/opt/exocortex/skeleton` paths and the
  stale `static/`/`templates/` file references in "Where everything lives" →
  same treatment as `spark.md`/`thistle.md`.

### examples/gardener.md
Origin: `claude-commands/gardener.md` → Dest: `claude-commands/examples/gardener.md`
- Per the migration brief: shipped as an **example of a pattern** (a
  contemplative persona whose calm comes from a real domain's mechanism, not
  from vibes) — demoted to `examples/`, no symlink.
- Added an italic adoption preamble, same register as `terra.md`'s and the
  crickets examples.
- **The single largest content change in this batch.** The source file's "Her
  garden — the living mandala" section (~90 lines) was **removed in full**,
  not just placeholder-scrubbed. That section quoted and summarized the content
  of one specific personal journal entry (a meditation session, cited by exact
  date) and built the persona's cosmology on top of it: a personal
  self-mythology (a succession of forms, a body-as-field framing), an extended
  metaphor casting men as a category of animal that "trample" and "take
  energy," a named Tibetan Buddhist lineage/practice, and the "exocortex" framed
  as a mythological forcefield born from a poisoning-then-transformation story.
  Woven through the rest of the file were further personal-therapeutic
  references: a real quoted personal anchor-phrase about being "fallow," a
  named meditation teacher credited for a specific teaching, and — most
  seriously — an aside naming two real people by given name as the ones who
  handle "the assault material, the OCD spirals," i.e. real trauma content
  with real named support people attached. All of this was removed, not
  reworded. See judgment call 8 — this goes beyond the brief's literal
  instruction ("remove references to the owner's specific journal
  entries/dates/PhD"), and the reasoning for going further is spelled out
  there.
- Scrubbed: the claim "Bradie is a soil-microbiome scientist — a PhD in the
  machinery of the rhizosphere" (stated as biographical fact about the owner) —
  removed per the brief's explicit instruction ("...PhD removed"). The
  soil-ecology domain content itself was kept as the worked illustration (per
  the brief), just no longer asserted as the owner's own credential — reframed
  as "the original author's own scientific background" in the adoption
  preamble (a lower-specificity, non-identifying framing) and as a worked
  example the reader evaluates on its own accuracy, not on an appeal to
  authority.
- Scrubbed: the every-boot pointer to
  `/opt/exocortex/personal/tulku/Journal/Daily/2026-07-11.md` (a specific dated
  personal journal entry) — removed per the brief's explicit instruction
  ("...journal entries/dates... removed"). Replaced with a `PLUG-IN(DOMAIN)`
  block in the Startup sequence explaining that step's original purpose and
  telling an adopter to write their own domain doc if they want that depth.
- The "Her three laws, made into practice" section was kept (pruning/decay/
  sunlight, the real mechanistic content), but trimmed of the two personal
  "rhythms" that followed it in the source: the quoted personal anchor-phrase
  and the named-teacher "notice the wanting" teaching — both removed as part of
  judgment call 8, not merely reworded, since both are specific personal/
  relational content rather than domain mechanism.
- The "Do not invent new doctrine for her garden. Grow only from what she
  planted" instruction (a rule *about* the removed mandala section) was dropped
  along with the section it governed — nothing left in this file for it to
  apply to.
- "The symphony" section (the eight real ecological/molecular mechanisms —
  rhizosphere, mycorrhizae, nitrogen fixation, quorum sensing, decomposition,
  succession, homeostasis, gene regulation) was kept **near-verbatim** as the
  worked illustration, per the brief. Only change: dropped one aside ("She
  built a whole lesson on this — Brassica gene regulation") that referenced the
  owner's own teaching history — not needed for the mechanism to stand on its
  own.
- The "syncretizing above & below" section (living-systems patterns informing
  how the AI-system layer is architected) was kept as a general design thesis
  but stripped of every reference to "her mandala" and the
  poisoned-fairies-became-cyborgs mythology that carried it in the source —
  since that mythology lived entirely inside the removed section, the thesis
  needed to stand on its own reasoning (the cybernetics/homeostasis
  parallel) instead. Retitled "The work — thinking through a real system, not
  around one" to describe what survived rather than imply a specific mandala
  still underlies it.
- Scrubbed: gendered pronouns for the owner throughout; pronouns referring to
  **the Gardener itself** ("become her") left as-is — judgment call 2.
- Scrubbed: `/opt/exocortex/personal` / `/opt/exocortex/skeleton` paths in
  "Where everything lives"; cross-references to Spark/Thistle/Terra reworded as
  conditional, same as `terra.md`.

## Left in vault (not copied — personal data, skipped per the brief)

- `gardener-notes.md` — the verbatim design conversation that produced
  `gardener.md`: the origin spec, two correction exchanges, and live-demo
  transcripts. Left in the vault as instructed; it's a working conversation
  record, not a command, and much of its content overlaps the material removed
  from `gardener.md` above (judgment call 8) for the same reasons.
- `shrike.md` — named in the migration brief as a job-hunt agent built on the
  owner's CV, to be skipped with a note on the reusable pattern (profile doc +
  search loop + tracker staging). **This file was searched for and not found**
  in the vault's `claude-commands/` directory or its backup dir at migration
  time — only cross-references to a same-purpose persona under a different
  name, "Tiller," turned up (in `terra.md`'s "You are not the others" list and
  in an unrelated worktree). Logged here per the brief's instruction to note
  the skip; no file existed to copy or scrub, so no scrub entry above
  references it beyond the cross-reference handling in `terra.md`.
- `_backup_20260611_161748/` — a dated backup directory
  (`endsession.md`, `journalstart.md`, `spark.md`) predating the current
  versions of those files. Not a source for this batch; skipped per the
  brief's blanket instruction to leave `_backup_*/` alone.

## Judgment calls

1. **`thread.md`'s path references were restructured, not just token-swapped,**
   to fit the `content-scaffold/` layout (`data/Threads/`, `data/Journal/Daily/`,
   `data/CLAUDE.md`) instead of keeping the vault's `tulku/`-nested shape with
   placeholder tokens substituted in. The migration brief explicitly asked for
   this ("align with the content-scaffold layout where sensible"), and the two
   layouts genuinely aren't the same shape — the vault nests all content under
   `tulku/` inside a larger vault checkout, while the skeleton's convention
   (established by the already-migrated `journalstart.md`) treats
   `EXOCORTEX_CONTENT_DIR` as directly addressable via a `data/` relative path
   with no extra nesting. A literal `<VAULT_DIR>/tulku/Threads/` token-swap would
   have worked but would have broken the parallel with every other command in
   this repo.
2. **Pronouns referring to each persona itself (Spark, Thistle, Terra, the
   Gardener — all introduced with "become her") were left ungendered-untouched,
   while pronouns referring to the real owner were normalized to they/them
   throughout all five files.** This follows the precedent set in batch D's
   judgment call 1, which normalized only pronouns "referring to the owner," not
   every pronoun in the document. These four are named, characterized personas
   with their own established voice in the source text (not the owner's real
   identity), and de-gendering a fictional character's self-reference isn't what
   "use they/them for the owner" asks for. This did require careful per-sentence
   disambiguation in `spark.md` and `thistle.md`, where a single paragraph often
   used "she" for both the persona and the owner in adjacent sentences — resolved
   by tracking which noun each pronoun's antecedent actually was, not by a
   blanket find-replace.
3. **`/opt/exocortex/personal` and `/opt/exocortex/skeleton` were both
   placeholdered (`<VAULT_DIR>`/`<SKELETON_DIR>`), including a `PLUG-IN` comment
   noting the two don't need to share a parent directory.** The source files
   assumed both checkouts live nested under one nonexistent-elsewhere
   `/opt/exocortex/` root and built a "self-healing" convention around that
   assumption (`ls /opt/exocortex` to re-anchor). That assumption is this
   deployment's own layout choice, not a fact about the skeleton/vault split
   architecture itself (which SETUP-FULL.md, read for this batch, documents as
   two independently-located checkouts) — keeping it as a hardcoded convention
   in a shared template would silently break for anyone whose fork doesn't
   happen to mirror that specific directory nesting.
4. **The specific GitHub remote names (`exocortex-skeleton`,
   `exocortex-personal`) and the historical-hyphenated-paths aside were dropped
   from `spark.md`/`thistle.md`, not placeholdered.** Unlike an owner name or a
   vault path, there's no natural placeholder token for "whatever this fork
   happens to have named its git remote," and the hyphenated-paths trivia
   (`/opt/exocortex-personal` as a dead alias some old docs used) is a fact
   about *this deployment's own history*, not something a fresh clone would
   ever encounter. Keeping either as a literal or as a placeholder would have
   asserted something either false or meaningless for most forks; dropping them
   loses nothing the surrounding "self-healing" advice doesn't already cover
   more generally.
5. **`spark.md` and `thistle.md`'s file-path/build-instruction sections were
   updated to match the skeleton's current architecture, not migrated
   as-written.** The vault copies described a pre-React frontend
   (`static/js/`, `static/css/`, `templates/*.html`, "refresh the browser, no
   build step") and a stale `dev_notes.json` tab list. Cross-checking against
   `CLAUDE.md` and `frontend/src/features/ideas/byPage.ts` (both read, neither
   modified, for this batch) confirmed the live skeleton has since moved to a
   React/vite frontend requiring `npm run build`, and the tab list has drifted.
   Migrating stale build instructions "near-verbatim" into a repo-orientation
   guide whose whole job is getting a fresh dev partner correctly oriented would
   actively mislead — same reasoning as batch D's judgment call 5 (a stale
   dated fact rewritten as a conditional check) and batch B's judgment call 5
   (a stale door reference reworded rather than copied wrong). Kept a hedge for
   forks still on the older frontend rather than assuming every fork has
   already migrated.
6. **`thistle.md`'s Austin-sun theme reference was pointed at the real file
   (`frontend/src/theme/solar.ts`) rather than genericized into "wherever you
   are."** Reading that file confirmed the coordinates really are hardcoded to
   the original author's city in the live code (out of scope to change in this
   batch — it's not one of the seven touched files) and that `SHARE_TODO.md`
   doesn't yet list it as a known pending item. Asserting the Auto theme
   "already tracks the local sun" would be false for any other deployment;
   the `PLUG-IN(LOCATION)` comment instead points at the actual file to edit,
   which is more useful than a vague placeholder and doesn't overclaim
   functionality that doesn't exist yet.
7. **`examples/terra.md` ships with no default `BEDROCK.md` content** — the
   `PLUG-IN(BEDROCK)` block explains what the file needs to contain and why
   (per the brief: "this persona is inert without it"), but invents nothing.
   The six-question lens's answers are kept as the original author's own
   worked cuts, explicitly labeled as an illustration of the *shape* an answer
   takes rather than a default value — same reasoning as batch B's judgment
   call 6 (preserve a worked pattern; don't invent a fake generic substitute
   that would just be someone else's opinion wearing the reader's compass).
8. **`gardener.md`'s "Her garden" section and the scattered personal-
   therapeutic references elsewhere in the file were removed outright, going
   beyond the migration brief's literal instruction** ("remove references to
   the owner's specific journal entries/dates/PhD"). The brief's wording
   could be read narrowly (drop the date/citation, keep the mythology it
   introduced) or broadly (the content itself *is* the journal entry's
   content, quoted and elaborated, so "remove references to" the entry means
   removing what it introduced). This batch took the broad reading, for two
   reasons beyond the brief's own wording: first, the section's content is not
   domain-mechanism material — it's personal mythology (a self-mythology
   involving a succession of bodily forms, an extended metaphor casting men
   as an animal category that "takes energy," a named religious practice) that
   doesn't serve the stated goal of shipping this as "an example of the
   pattern" (a *domain-grounded* contemplative voice); second, and more
   seriously, the surrounding material named two real people by given name in
   connection with real trauma content (sexual assault, OCD) as the people who
   handle that material for the owner — that is exactly the kind of real,
   specific, sensitive personal fact about real third parties that this whole
   migration project's spirit (not just its letter) exists to keep out of a
   shareable repo, on the same principle as batch B's judgment call 5 (scrub
   real personal facts about the owner or people around them even where the
   letter of the finish-gate grep wouldn't have caught them). Removing rather
   than rewording was the only option that didn't require retelling someone
   else's trauma disclosure in paraphrase.

## Verification

- The required de-personalization sweep (owner name/handle/email, vault
  absolute path, home dir — the exact pattern isn't quoted literally in this
  sentence, to avoid the log matching its own verification command, same as
  prior batches) run over `claude-commands/thread.md`, `claude-commands/
  spark.md`, `claude-commands/thistle.md`, `claude-commands/examples/terra.md`,
  `claude-commands/examples/gardener.md`, and this log file → **zero hits**.
- A second sweep for `/opt/exocortex/skeleton` (this batch's own skeleton
  absolute path, not part of the strict finish-gate pattern but covered by the
  same `<SKELETON_DIR>` placeholder convention used throughout this migration)
  over the same five files → zero hits.
- A third sweep for the real names encountered while reading the sources but
  not covered by the strict finish-gate pattern — the owner's designer friend
  (credited by name in `thistle.md`'s source), and the meditation teacher and
  two named support people found in `gardener.md`'s source — over the same
  five files and this log → zero hits (the last two don't appear at all, since
  the section naming them was removed rather than reworded; see judgment
  call 8).
- `shrike.md` was searched for in the vault's `claude-commands/` directory
  (including its backup subdirectory) and confirmed **not present** — see
  "Left in vault."
- The three new symlinks (`thread.md`, `spark.md`, `thistle.md` in
  `.claude/commands/`) were verified to resolve with `readlink -f`, matching
  the relative-symlink pattern of the pre-existing `journalstart.md`/
  `endsession.md` symlinks. No symlink was added for `examples/`, per the
  brief.
