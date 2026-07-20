# Batch D scrub log — agent workspaces

Source: `personal vault person-summary/`, `triage/`, `receipts/`, `recipes/`,
and `personal vault prompts/receipt_scanner.md` + `prompts/grocery_agent.md`
(read-only). Destination: `skeleton/agents/person-summary/`,
`skeleton/agents/triage/`, `skeleton/agents/receipts/`,
`skeleton/agents/recipes/`. Copy, not move; vault untouched, no git run.

These four vault dirs are workspaces the running app opens a headless/
interactive Claude Code session in: `routes/triage.py`, `routes/person.py`,
`routes/kitchen/receipts.py`, and `routes/kitchen/recipes.py` each call
`routes/kitchen/shared.py`'s `ensure_claude_session(name, cwd, dirs)`, which
`mkdir`s the workspace and spawns a named tmux session running `claude` with
that dir as its cwd (so it boots with the dir's `CLAUDE.md` as its skill);
`shared.send_prompt(name, text)` then types a task into the pane after a
settle delay. `routes/triage.py` and `routes/person.py`'s sessions are
conversational (the frontend deep-links to a live terminal pane); the kitchen
ones are one-shot parse tasks. This spawn code lives in the routes above —
read but not modified in this batch, per the migration brief.

Placeholder legend: `<OWNER_NAME>` (the person the workspace serves — used as
a literal inline token in these docs, `(or "the owner")` in flowing prose
where less awkward), `<VAULT_DIR>` (the vault root each workspace is a
sibling directory under).

**Note on this log itself**, same convention as `docs/scrub-log/
A-deploy-ops.md` and `E-mailclaude.md`: entries below name the *kind* of
value that was scrubbed (the owner's real given name, the vault's real
absolute path, a real third party's name) and never repeat the actual value
— this file has to pass the same de-personalization sweep as the migrated
files themselves.

## Files

### person-summary/CLAUDE.md
Origin: `person-summary/CLAUDE.md` → Dest: `agents/person-summary/CLAUDE.md`
- Scrubbed: the owner's real given name (3 occurrences: opener, title intro,
  "role/relationship to"). Placeholder: `<OWNER_NAME>`, literal inline, with
  a `PLUG-IN(OWNER_NAME)` comment after first use.
- Scrubbed: gendered pronouns referring to the owner ("she"/"her"/"hers",
  ~10 occurrences throughout) — normalized to "they"/"their"/"theirs" so the
  doc doesn't bake in the original owner's gender. See judgment call 1.
- Scrubbed: two absolute vault paths (the person-file path and the daily-
  journal path, both under the vault's `tulku/` tree). Placeholder:
  `<VAULT_DIR>` + subpaths, with a `PLUG-IN(VAULT_DIR)` comment.
- Scrubbed: a real third party's given name, used as a worked example, plus
  the literal vault path to her file cited as "the approved example."
  Rewritten to describe the same design decision (facts-first over
  feelings-first) without naming her or pointing at her file — see judgment
  call 2.
- "exocortex app" reworded to "the app" (generic; this repo's own name isn't
  personal, but the phrase reads better without it in a doc meant to
  describe *any* deployment).
- Reference to "the people cricket and Sunday keeper" (sibling automation
  that also touches a person's file) left as architecture description, not
  scrubbed — no name/path, just describes what shares file ownership.

### person-summary/.claude/settings.json
Origin: `person-summary/.claude/settings.json` → Dest:
`agents/person-summary/.claude/settings.json`
- Scrubbed: the vault's real absolute path in `additionalDirectories`.
  Placeholder: `<VAULT_DIR>/tulku`, used as the literal JSON string value
  itself — see judgment call 9 for why this departs from "JSON keeps
  concrete default paths."
  Plug-in: replace `<VAULT_DIR>` with your vault's actual absolute path
  before first use — Claude Code will otherwise treat the bracketed string
  as a literal, nonexistent directory and the sandbox grant will silently
  do nothing.

### person-summary/README.md (new)
Dest: `agents/person-summary/README.md` — not a migrated file, written fresh
per the batch brief (what the workspace is, where to copy it, what it reads/
writes, pointer to its settings sandbox). No scrubbing applicable.

### triage/CLAUDE.md
Origin: `triage/CLAUDE.md` → Dest: `agents/triage/CLAUDE.md`
- Scrubbed: gendered pronouns referring to the owner ("she"/"her", ~8
  occurrences) — normalized to "they"/"their", same as person-summary.
- Scrubbed: the owner's real given name, possessive, 1 occurrence in the
  opening line ("<name>'s todo prioritizing partner"). Placeholder:
  `<OWNER_NAME>`, literal inline, `PLUG-IN(OWNER_NAME)` comment.
- Scrubbed: three absolute vault paths (`data/todos.json`, `reminders.json`,
  `activity_log.json`, each originally prefixed with the vault's real
  absolute root). Placeholder: `<VAULT_DIR>` + subpaths, `PLUG-IN(VAULT_DIR)`
  comment.
- Changed the example todo item's `text` field from `"Call dermatologist"`
  to `"Call the dentist"` — a health-specific example swapped for a more
  neutral one; schema/shape unchanged. See judgment call 3.

### triage/.claude/settings.json
Origin: `triage/.claude/settings.json` → Dest:
`agents/triage/.claude/settings.json`
- Scrubbed: the vault's real absolute path in `additionalDirectories`.
  Placeholder: `<VAULT_DIR>/data`, same literal-JSON-value treatment as
  person-summary's, same judgment call 9.
  Plug-in: replace `<VAULT_DIR>` with your vault's actual absolute path
  before first use.

### triage/README.md (new)
Dest: `agents/triage/README.md` — new, generic, same shape as
person-summary's. No scrubbing applicable.

### receipts/CLAUDE.md
Origin: `receipts/CLAUDE.md` → Dest: `agents/receipts/CLAUDE.md`
- Scrubbed: the owner's real given name (5 occurrences, all "summarize for
  <name>" / "flag that to her"-type lines). Placeholder: `<OWNER_NAME>`,
  literal inline, `PLUG-IN(OWNER_NAME)` comment near the top.
- Scrubbed: gendered pronouns in the one Money-tab flag-it-to-her sentence
  ("her ... she" → "them ... they").
- No absolute vault paths were present in this file (all data references are
  relative — `../data/...`, `grocery/...`) — nothing to placeholder there.
- Reworded "the exocortex dashboard" → "the dashboard" and "through
  store.py" → "through the app's data layer" (generic; `store.py` is a
  skeleton-internals name this doc shouldn't assume the reader kept).
- Two prompt-file cross-references updated from `../prompts/
  receipt_scanner.md` to `receipt_scanner.md` (this batch relocates it into
  the same folder as this CLAUDE.md, not a vault-wide shared `prompts/`
  dir — see judgment call 4) — 3 occurrences.
- Preserved verbatim: the "Why never write the data files directly"
  doctrine section (the strong "never write SQL-mirror JSON directly" rule
  the migration brief called out to keep) — only the `store.py`-name
  reference above it was genericized, the doctrine's substance is unchanged.
- A stale date reference ("As of 2026-07-13 there's no Money-tab button...")
  reworded to "If no Money-tab button is wired up yet (check the app's
  current state)" — the original hardcoded a date-conditional fact about
  one specific deployment's history, which won't stay true and isn't
  something a fresh clone can verify. See judgment call 5.

### receipts/receipt_scanner.md
Origin: `prompts/receipt_scanner.md` → Dest:
`agents/receipts/receipt_scanner.md`
- Near-verbatim per the batch brief (it's generic OCR guidance, no personal
  content found — confirmed via the de-personalization grep, zero hits on
  the un-migrated file).
- Only change: the "Where to Save" section, which told the reader to write
  straight to `data/grocery_trips.json` — a direct write this same batch's
  `CLAUDE.md` documents as forbidden (SQL-mirror doctrine). Rewritten to
  point at the sibling `CLAUDE.md`'s staging-file convention instead, with a
  `PLUG-IN(SAVE_PATH)` comment explaining the change for standalone use. See
  judgment call 6.
- Added one line noting `sips` is macOS-only with a pointer to the sibling
  CLAUDE.md's Linux tool list (that list already existed in `receipts/
  CLAUDE.md`, not duplicated here).

### receipts/grocery_agent.md
Origin: `prompts/grocery_agent.md` → Dest: `agents/receipts/grocery_agent.md`
- Scrubbed: the owner's real given name, possessive, 1 occurrence in the
  opening line. Placeholder: `<OWNER_NAME>`, literal inline,
  `PLUG-IN(OWNER_NAME)` comment.
- Scrubbed/placeholdered per the batch brief ("placeholder the paths"): all
  four data-file paths, originally `build/data/*.json` and `build/
  receipts/`. `build/` is called out in the vault's own top-level `CLAUDE.md`
  as "a leftover husk" (a stale symlink, not the real data location) — kept
  literally it would mislead a fresh deployment, so these were mapped to
  `<VAULT_DIR>/data/...` and `<VAULT_DIR>/receipts/` instead, with a
  `PLUG-IN(VAULT_DIR)` comment explaining the substitution. See judgment
  call 7.
- Updated the `## Invocation` example's file reference from `prompts/
  grocery_agent.md` to `grocery_agent.md` (this file now lives in `agents/
  receipts/`, not a vault-wide `prompts/` dir).
- Added a short `PLUG-IN` comment on the `## Invocation` section noting this
  headless `claude -p` pattern is a standalone alternative to the live app's
  tmux-session spawn pattern used elsewhere in this batch — not itself part
  of the routes read for this migration, kept for reference since the
  source file documented it.
- "Cricket" (the vault's own overnight-automation name, mentioned as an
  alternate invoker) left as-is — architecture description, not a personal
  identifier.
- "the owner manages it" (originally "user manages it") — reworded to match
  the `<OWNER_NAME>` framing used elsewhere in this file; no information
  change.

### recipes/CLAUDE.md
Origin: `recipes/CLAUDE.md` → Dest: `agents/recipes/CLAUDE.md`
- Scrubbed: the owner's real given name (3 occurrences, all "summarize for" /
  "reviews your parsed output" lines). Placeholder: `<OWNER_NAME>`, literal
  inline, `PLUG-IN(OWNER_NAME)` comment near the top.
- No absolute vault paths were present (all references relative — `urls/`,
  `images/`, `parsed/`, `data/recipes.json`) — nothing to placeholder there.
- No gendered pronouns referring to the owner appeared in this file.

### recipes/README.md, receipts/README.md (new)
Dest: `agents/recipes/README.md`, `agents/receipts/README.md` — new,
generic, same shape as the other two. Both note there's no `.claude/
settings.json` for these two workspaces (the vault has none — receipts/ and
recipes/ instead rely on `chmod_for_claude()` loosening directory
permissions before spawn, since Flask and the Claude process can run as
different Linux users). This is factually accurate to the source, not a
migration omission.

## Left in vault (not copied — personal data, skipped per the brief)

- `receipts/grocery/*.jpg,*.jpeg,*.HEIC` — raw receipt photos.
- `receipts/grocery/*.parsed.json`, `*.parsed.imported` — parsed grocery
  line items (real purchase data) and their import-status markers.
- `receipts/2026-03-24-heb.HEIC` — a raw Money-tab receipt photo.
- `recipes/urls/*.url.json` — real submitted recipe URLs.
- `recipes/images/`, `recipes/parsed/` — present as folders in the pipeline
  design but empty in the vault at migration time; not copied regardless
  (would be personal recipe data if populated).
- Everything the workspaces' `CLAUDE.md` files *read but don't live next to*
  — `<VAULT_DIR>/tulku/people/*.md`, `tulku/Journal/Daily/*.md`,
  `<VAULT_DIR>/data/todos.json`, `reminders.json`, `activity_log.json`,
  `expense_receipts.json`, `grocery_trips.json`, `data/recipes.json` — none
  of these live inside the four migrated dirs, so none were touched; they're
  named here only because the migrated `CLAUDE.md`s reference them.

## Judgment calls

1. **Gendered pronouns for the owner ("she"/"her") were normalized to
   "they"/"their"** in `person-summary/CLAUDE.md` and `triage/CLAUDE.md`,
   beyond the explicit `<OWNER_NAME>` name-scrub. The batch brief's
   placeholder contract only names `<OWNER_NAME>`/`<VAULT_DIR>`/
   `<SKELETON_DIR>` explicitly, but a shareable template that still narrates
   the deploying owner's gender throughout reads as only half de-
   personalized, and it's a one-word swap with no loss of meaning (these
   docs never depend on the owner's gender). `receipts/CLAUDE.md`'s one
   incidental "her ... she" got the same treatment for consistency.
2. **`person-summary/CLAUDE.md`'s worked example (a real third party's given
   name, and a literal path to her file) was rewritten to preserve the
   design rationale without the name or path**, rather than replaced with a
   placeholder token. There's no `<PERSON_NAME>` slot in this batch's
   contract, and inventing one for a single illustrative aside felt like
   more ceremony than the sentence needed — the underlying fact worth
   keeping (facts-first drafts, decided after a rejected feelings-first
   draft) survives the rewrite; the identity of who it happened to doesn't
   need to.
3. **`triage/CLAUDE.md`'s example todo text was swapped from "Call
   dermatologist" to "Call the dentist."** Not a placeholder-contract item
   (todo text isn't a path/name), but a schema-illustration example that
   happened to carry a specific personal-health flavor; a shareable template
   reads more neutrally with a generic errand instead. The schema and every
   other field in the example are untouched.
4. **`receipts/CLAUDE.md`'s cross-references to `receipt_scanner.md` were
   changed from `../prompts/receipt_scanner.md` to `receipt_scanner.md`**
   because this batch places the prompt file directly inside `agents/
   receipts/` (per the brief), not in a vault-wide `prompts/` sibling dir —
   the relative path had to change to still resolve correctly in the new
   layout. Same reasoning applies to `grocery_agent.md`'s self-reference in
   its own `## Invocation` section.
5. **`receipts/CLAUDE.md`'s "As of 2026-07-13, no Money-tab import button is
   wired up" was reworded to a conditional check** rather than migrated as a
   dated fact. A specific date tied to one deployment's build state will
   silently go stale the moment someone fixes it in their own fork, and
   nothing in this file could re-verify it — turning it into "check the
   app's current state" keeps the useful behavior (flag it if true) without
   asserting something that may already be false by the time this is read.
6. **`receipt_scanner.md`'s original "Where to Save" step (write straight to
   `data/grocery_trips.json`) was replaced, not just placeholdered**, because
   it directly contradicts this same batch's `receipts/CLAUDE.md` doctrine
   (which the brief explicitly says to preserve: "never write SQL-mirror
   JSON directly"). Migrating the OCR prompt "near-verbatim" while leaving in
   an instruction its own sibling file calls a mistake that "bit us for
   real" would ship a real self-contradiction into the shared repo. The fix
   points at the sibling file's convention instead of asserting a save path,
   and flags the change inline with a `PLUG-IN(SAVE_PATH)` comment for
   anyone using this prompt outside that pipeline.
7. **`grocery_agent.md`'s `build/data/...` and `build/receipts/` paths were
   mapped to `<VAULT_DIR>/data/...` and `<VAULT_DIR>/receipts/`**, not left
   as literal `build/`-prefixed relative paths. The vault's own top-level
   `CLAUDE.md` explicitly warns `build/` is "a leftover husk" (a stale
   symlink, not real data) — carrying that quirk into a shareable template
   as if it were the intended layout would actively mislead a fresh
   deployment. This reads as within the brief's explicit instruction to
   "placeholder the paths" for this specific file, just resolving what the
   placeholder should point *at* using the vault's own documentation of what
   that path actually means.
8. **No `<APP_USER>`/`<SKELETON_DIR>`-style placeholders were needed in this
   batch** — unlike batch A/E, nothing here touched a Linux service account,
   an install path, or a checkout location; every workspace's own concrete
   defaults are vault-relative (`<VAULT_DIR>/<name>`), which is also what
   each README.md states as the drop-in instruction.
9. **The two `.claude/settings.json` files use the literal bracketed token
   `<VAULT_DIR>/...` as the actual JSON string value**, rather than keeping
   the vault's real absolute path as a "concrete default path" the way batch
   E kept its `/srv/...`-style install path in `clerk/.claude/settings.json`.
   Those aren't the same situation: that install path was already a generic,
   non-personal path *convention* invented by that architecture, so leaving
   it literal cost nothing. Here, the only "concrete default" that actually
   exists is the real vault's real absolute path on this specific
   deployment — the exact string this batch's own finish-gate grep is
   required to return zero hits on. Keeping it literal, even just in JSON,
   would fail that gate outright; inventing some *other* concrete-but-fake
   absolute path (e.g. `/home/you/vault`) would be a made-up default no more
   real than a placeholder, while looking functional enough that someone
   might not think to edit it. Using
   `<VAULT_DIR>` as the literal value instead follows the precedent already
   set elsewhere in *this same migration* — `deploy/exocortex.service.template`
   and `deploy/crontab.template.txt` (batch A) both use bracketed
   `<VAULT_DIR>`/`<SKELETON_DIR>` tokens directly as config values in
   formats that, like JSON, have no comment syntax at the point of use — so
   this isn't a new pattern invented for this batch, just the same one
   applied to `.claude/settings.json`. Both README.md files spell out that
   the token must be replaced before first use, since an unresolved
   `<VAULT_DIR>` looks like a real (nonexistent) path to Claude Code rather
   than erroring loudly.

## Verification

- The required de-personalization sweep (owner name/handle/email, vault
  absolute path, home dir — the exact pattern isn't quoted literally in this
  sentence, to avoid the log file matching its own verification command, same
  as `E-mailclaude.md`'s note) run over `agents/person-summary/`,
  `agents/triage/`, `agents/receipts/`, `agents/recipes/`, and this log file
  → **zero hits**, no exceptions (re-run after the settings.json fix
  described in judgment call 9 — the first draft of this batch had kept the
  two settings.json defaults literal per a naive reading of "JSON keeps
  concrete default paths," which failed this exact sweep; both now use the
  `<VAULT_DIR>` token instead).
- `python3 -m json.tool` on both `.json` files written
  (`person-summary/.claude/settings.json`, `triage/.claude/settings.json`)
  → both valid.
