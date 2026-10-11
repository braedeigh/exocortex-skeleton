<!-- Origin: none — new file written for this migration batch, no personal content. -->
# Cricket swarm

A roster of small, single-job nightly agents ("crickets") that read the journal day
that just sealed and file the one kind of thing each of them owns — to-dos, food,
contacts, card tagging, and so on — into this app's data, either writing directly
through a validated tool/endpoint or staging a proposal for approval. A separate
weekly "housekeeper" pass closes out the week (summary, people-file judgment calls,
thread lifecycle).

This is the prompt-and-roster half of the system, versioned in this repo. The runner
scripts that actually spawn each cricket live in `scripts/` (`cricket_swarm.sh`,
`cricket_housekeep.sh`); see `deploy/crontab.template.txt` for the cron wiring.

## How it composes

```
agents/crickets/
  roster          — id, model, on/off, one-line summary. The swarm's run list.
  _base.md        — shared field guide every cricket reads first (target-date rule,
                    read-only discipline, the staged-approval protocol).
  _template.md    — copy this to start a new cricket.
  todos.md, food.md, contacts.md, cards.md, thread-scout.md, memory-scout.md
                  — the active, generic crickets (ship `on` in roster).
  front-health.md — a "front tender" cricket, ships `off`; a worked example of the
                    pattern for a different kind of cricket (see PLUG-IN(FRONT) note
                    inside).
  examples/       — complete worked examples that ship `off` because their content
                    is inherently personal (a symptom-tracking schema, real contact
                    names) — copy and adapt rather than run as-is.
  README.md       — this file.
```

`scripts/cricket_swarm.sh` reads `roster`, and for every row marked `on` spawns a
headless Claude Code session per cricket: "read `_base.md` and `<id>.md`, then do your
one job for the target date." Each cricket file only has to describe its own job and
its own door — the shared mechanics (which date is "the target," how to read the
roster, logging, sequencing) live once in the runner and in `_base.md`.

## The staged-approval flow

This is the architecture's centerpiece, not an afterthought. A cricket has exactly two
ways to file what it finds (see `_base.md` for the full contract):

1. **Direct** — call a validated write tool or endpoint. Only for unambiguous,
   factual extractions (e.g. the `people` tool used by `examples/people.md`).
2. **Stage** — append one object to `data/pending_changes.json`'s `pending` array.
   Use this for anything inferred or uncertain — **when in doubt, stage.**

The dashboard polls `GET /api/pending` and pops a modal for whatever's waiting; the
owner taps Approve or Deny. Approve is handled entirely by `routes/pending.py`, which
is the **single writer** on the approval side — it dispatches on the staged object's
`kind` to a small `_commit()` handler (todo tool, thread CLI, etc.) and only removes
the item from the queue if the commit succeeds, so a failed commit stays queued for a
retry instead of silently vanishing. If you add a cricket with a new `kind`, add a
matching case in `routes/pending.py`'s `_commit()` — that's the only place a staged
proposal turns into a real write.

## Writing a new cricket

1. Copy `_template.md` to `agents/crickets/<id>.md` and fill in Job / Door / What to
   do / Don'ts. Keep it to one job and one door — don't repeat `_base.md`'s shared
   rules.
2. Decide staged vs. direct. If staged, either reuse an existing `kind` (see
   `routes/pending.py`) or add a new one plus its commit handler.
3. Add a row to `roster`: `<id>  <model>  off  # what it files`. Leave it `off` until
   you've dry-run it.
4. Test it in isolation without touching the real roster state:
   ```
   CRICKET_DRY_RUN=1 scripts/cricket_swarm.sh 2026-07-03 <id>   # print, spawn nothing
   scripts/cricket_swarm.sh 2026-07-03 <id>                     # actually run it
   ```
   Single-cricket mode (the third argument) runs by id regardless of the roster's
   on/off state — that's also how the weekly `thread-scout` and `memory-scout` crickets are invoked,
   each from its own cron line rather than the nightly swarm loop.
5. Flip the roster row to `on` once you're happy with what it stages/writes.

## Cron wiring

Not part of this module — see `deploy/crontab.template.txt` for the actual cron lines
(nightly swarm at 2 AM, weekly housekeeper Monday 4 AM, thread-scout Sunday 5 AM, memory-scout Sunday 5:20 AM) and
`deploy/README.md` for the placeholder substitutions.
