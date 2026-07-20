# Batch C scrub log — research pipeline agent prompts

Source: personal vault `research-runner/`, `research-worker/`, `research-deep/`,
`research-distiller/`, `research-filer/`, and `research/*example-session*.md`
(read-only). Destination: `skeleton/agents/research-runner/`,
`skeleton/agents/research-worker/`, `skeleton/agents/research-deep/`,
`skeleton/agents/research-distiller/`, `skeleton/agents/research-filer/`,
`skeleton/agents/research-examples/`, plus a new overview doc
`skeleton/agents/research-README.md`. Copy, not move; vault untouched, no
git run.

Placeholder legend: `<OWNER_NAME>` (the person the pipeline serves, marked
literal + `PLUG-IN(OWNER_NAME)`), `<VAULT_DIR>` (absolute path to the
personal data vault — replaces every absolute vault-path occurrence),
`<SKELETON_DIR>` (absolute path to this skeleton checkout — replaces every
absolute skeleton-checkout-path occurrence). These match the placeholders
already established in batch A's `deploy/crontab.template.txt`, which the
research-dispatcher/research-doctor cron lines in that same file already use.

**Note on this log itself:** entries below name the *kind* of value that was
scrubbed and never repeat the actual value, consistent with the instruction
that this log records kinds, not secrets.

## agents/research-runner/CLAUDE.md
Origin: `research-runner/CLAUDE.md`
- Scrubbed: the owner's real given name (1 occurrence, in the opening
  paragraph: "a one-job cricket `<name>` fires from the Research page").
  Placeholder: `<OWNER_NAME>`, marked `PLUG-IN(OWNER_NAME)`.
- Scrubbed: gendered pronouns referring to the owner (she/her/hers, ~8
  occurrences throughout) — genericized to they/their/theirs so the prompt
  reads correctly for any fork's owner, not just the vault's. Same choice
  batch E made for `agents/mailclaude/clerk/CLAUDE.md`.
- Scrubbed: the absolute vault data path (1 occurrence). Placeholder:
  `<VAULT_DIR>`.
- Scrubbed: absolute skeleton paths to the venv interpreter and
  `research_ctl.py` (4 occurrences across the two CLI examples).
  Placeholder: `<SKELETON_DIR>`.

## agents/research-worker/CLAUDE.md
Origin: `research-worker/CLAUDE.md`
- Scrubbed: the owner's real given name via possessive ("`<name>`'s
  Research page fires", 1 occurrence). Placeholder: `<OWNER_NAME>`.
- Scrubbed: gendered pronouns (she/her, ~6 occurrences) — genericized to
  they/their, same as above.
- Scrubbed: absolute vault paths to `data/research.json` and the
  `research/` library (3 occurrences, including the deep-mode report-save
  path). Placeholder: `<VAULT_DIR>`.
- **Judgment call:** the bare relative reference `tulku/context/about.md`
  in the source (no path prefix at all) was made explicit as
  `<VAULT_DIR>/tulku/context/about.md`. The worker's cwd at spawn time is
  `RESEARCH_WORKER_DIR` (a *sibling* of `tulku/`, per `store.py`'s
  `DATA_DIR.parent / "research-worker"`), so the bare relative form in the
  original would not actually resolve to the intended file from that cwd.
  Not treated as a personal-data scrub (nothing identifying in the
  original token) — flagged here as a path-accuracy fix made while
  touching the surrounding text, matching the "keep prompt references
  accurate" instruction for this batch. Same fix applied in
  `research-deep/CLAUDE.md` (its one `tulku/context/about.md` mention).

## agents/research-deep/CLAUDE.md
Origin: `research-deep/CLAUDE.md`
- Scrubbed: the owner's real given name (1 occurrence, opening paragraph).
  Placeholder: `<OWNER_NAME>`.
- Scrubbed: gendered pronouns (she/her/hers, ~20 occurrences — this is the
  longest of the five prompts) — genericized to they/their/theirs.
- Scrubbed: absolute vault paths (`data/research.json`, the `research/`
  library, the report-save path, three `EXOCORTEX_DATA_DIR=` CLI examples,
  and the `tulku/context/about.md` reference — see the worker file's
  judgment call above, same fix applied here). Placeholder: `<VAULT_DIR>`.
- Scrubbed: absolute skeleton paths to the venv interpreter and
  `research_ctl.py` (6 occurrences across three CLI examples).
  Placeholder: `<SKELETON_DIR>`.

## agents/research-distiller/CLAUDE.md
Origin: `research-distiller/CLAUDE.md`
- Scrubbed: the owner's real given name via possessive (1 occurrence,
  opening paragraph). Placeholder: `<OWNER_NAME>`.
- Scrubbed: gendered pronouns (she/her/hers, ~8 occurrences) — genericized
  to they/their/theirs, including "in her voice's register" → "in their
  voice's register" (an instruction to match the owner's own writing
  register — kept as an instruction, just de-gendered).
- Scrubbed: absolute vault paths (`data/research.json`, the `research/`
  library, the `research/edge/<topic-id>.md` note path — appears 3 times
  including inside the note-shape template — and one `<file>` read path).
  Placeholder: `<VAULT_DIR>`.

## agents/research-filer/CLAUDE.md
Origin: `research-filer/CLAUDE.md`
- Scrubbed: the owner's real given name (1 occurrence, opening paragraph).
  Placeholder: `<OWNER_NAME>`. This file had no other gendered-pronoun
  occurrences to genericize.
- Scrubbed: the absolute vault data path (1 occurrence). Placeholder:
  `<VAULT_DIR>`.
- Scrubbed: absolute skeleton paths to the venv interpreter and
  `research_ctl.py` (4 occurrences across the two CLI examples).
  Placeholder: `<SKELETON_DIR>`.

## agents/research-examples/ (from vault research/*example-session*.md)

Per the batch instructions, the vault's `research/` library is personal
data and was skipped wholesale **except** the two `*example-session*` files,
which the owner explicitly saved as "an example of the kind of question I'm
trying to answer with my research sessions" (verbatim, from the first
file's own closing line) — i.e. self-flagged as shareable exemplars, not
private records.

**Read both in full before copying.** Neither contains a name, email
address, or filesystem path (vault or otherwise) — the only owner reference
in either is the single-letter chat-transcript speaker tag `B:` opposite
`Spark:` (the skeleton's own dev-partner persona name, already used
elsewhere in this repo, e.g. `skeleton/CLAUDE.md`'s own title). On that
basis both were judged **clean** and copied **verbatim** (no text changes,
only an added origin header comment):

- `2026-07-14-example-session-mattress-decision.md` →
  `agents/research-examples/2026-07-14-example-session-mattress-decision.md`
- `2026-07-14-example-session-purchase-prioritization.md` →
  `agents/research-examples/2026-07-14-example-session-purchase-prioritization.md`

**Judgment call:** both transcripts do contain other personal *life*
detail that isn't identity-revealing — a real move date range, a named
mental-health-adjacent medical condition (MCAS), real third-party vendor
names/URLs (a futon retailer, its reviews), specific dollar amounts. None
of this resolves to who the owner is (no name/email/handle/address), and
the task's own framing called these files out as "intentionally
shareable," so they were left as-is rather than further redacted — treating
"generic" here as "carries no identity marker," not "carries no specific
life content." If a stricter bar is wanted later (e.g. redacting the
medical-condition mention or the real vendor names), that's a follow-up
edit to these two files specifically, not a re-scrub of the agent prompts.

## agents/research-README.md (new)

Not a migrated file — no vault origin. Written fresh for this batch to
satisfy the "how the pipeline fits together" requirement: agent roles →
`research.json` schema → who spawns what (routes/research.py for
runner/deep/filer, `scripts/research_dispatcher.py` for worker/distiller) →
`scripts/research_doctor.py` as the watchdog → `scripts/populate_research.py`
as the one-shot seed → `deploy/crontab.template.txt` for the cron wiring.
Read against the actual current source of
`scripts/research_ctl.py`, `scripts/research_dispatcher.py`,
`scripts/research_doctor.py`, `scripts/worker_apply_result.py`,
`scripts/populate_research.py`, `store.py` (the `RESEARCH_*_DIR` env vars),
and `routes/research.py` (the `ensure_claude_session`/`send_prompt` spawn
calls) to keep every reference accurate — none of those files were modified,
this batch only reads them. No personal content; carries the same three
placeholders as the migrated prompts.

## Left in vault (not migrated)

- **`research/` (the library itself)** — skipped per explicit instruction:
  personal research corpus (health, product, and life-decision content),
  except the two example-session files handled above.
- **No `.claude/settings.json` sandbox found** in any of the five source
  role directories (`research-runner/`, `research-worker/`,
  `research-deep/`, `research-distiller/`, `research-filer/` each contain
  only a bare `CLAUDE.md` — confirmed via a full recursive listing of all
  five). The batch brief anticipated copying one if present; there was
  none to copy. (Other vault dirs — `person-summary/`, `triage/`,
  `mailclaude/clerk/` — do have one each, but those belong to other
  batches, not this one.)
- **`research/edge/`** (the distiller's per-topic output directory) — not
  present as pre-existing content in the vault at migration time; not
  migrated since there was nothing there to migrate (the distiller prompt
  documents the shape it writes, which is enough for a fresh install).

## Verification

- The mandated case-insensitive de-personalization sweep (real given name,
  the vault's real absolute path, the home-directory path) run over every
  file added in this batch (`agents/research-runner/`,
  `agents/research-worker/`, `agents/research-deep/`,
  `agents/research-distiller/`, `agents/research-filer/`,
  `agents/research-examples/`, `agents/research-README.md`, and this log)
  → 0 hits. The sweep pattern itself isn't reproduced literally in this
  sentence, to avoid this file matching its own verification command (same
  precaution batches A and E took).
