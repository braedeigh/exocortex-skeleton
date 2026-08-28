---
description: The Shed — attended, reversible molting of neglected code; scope chosen per run (whole codebase → feature → file → section), evidence pulled from usage telemetry, the commit/session tables, and git, then the cut is archived under a restore handle rather than deleted. `/shed restore <id>` brings it back.
model: claude-fable-5
---

# The Shed — reversible molting of neglected code

**Antlers, not ash.** A deer sheds antlers every year and grows them back; a snake leaves a
whole skin behind intact. Nothing is destroyed — it's set down, whole, where it can be
picked up again. That is the entire difference from `/burn`: **burn deletes, shed stores.**
Same owner-on-the-line discipline, opposite reversibility.

Where it sits in the family:

| Practice | Scope | What happens to the code | Undo |
|---|---|---|---|
| `features.py` gate | one feature | stays, switched off | flip one line |
| **`/shed`** | **anything the owner scopes** | **removed from the tree, kept whole in the archive** | **`/shed restore <id>`** |
| `/burn` | one feature | deleted | git archaeology |

Shed is the middle rung, and it is allowed to be broader than burn *because* it's
reversible. A wrong burn costs a rebuild; a wrong shed costs one restore.

## Runs on Fable 5 (`claude-fable-5`)

Same reasoning as burn: the hard part is proving what reaches what across a large tree
while the owner cannot check the code herself. Pinned; nothing else inherits the pin.
Turns are long during the survey — that's the survey working.

## Why it's attended

Same rule as burn: **nobody watching, nothing shed.** It's reversible, but "reversible" is
only true if someone notices the thing is gone — and the person who notices is the owner
reaching for it. She has to know what was set down. No unattended invocation, ever.

## Scope — she picks the grain

`/shed` with no argument surveys the **whole codebase** at feature grain and proposes the
coldest units. With an argument it narrows:

```
/shed                          whole skeleton, feature grain
/shed features/car             one feature (frontend dir + routes/car.py + its store collections + tests)
/shed routes/money.py          one file
/shed routes/money.py:budget   one section — the functions/components/endpoints matching "budget"
/shed restore <id>             bring an archived cut back (see Restore)
/shed ledger                   just read the record and stop
```

Whatever the grain, **one scope per session.** A whole-codebase survey *presents* many
candidates; it does not *cut* many. Pick the cold one, cut it, record it, stop.

## The evidence — three signals, reported separately

Traffic alone cannot tell *unreachable* from *unvisited* (burn's "cold is not dead"). Shed
adds two more signals so the picture is fuller, but they are **never merged into one
score** — each is named, and a candidate is presented with all three.

1. **Used?** — `feature_usage.json` via the pulse:
   `EXOCORTEX_DATA_DIR=… venv/bin/python3 scripts/usage_doctor.py`
   Per-feature API reads/writes, per-collection store ops (per caller), tab visits + hours,
   and the two **zero-traffic lists** (route modules, collections). Note when collection
   started — "no traffic in 28 days" is only as strong as the window.
2. **Modified?** — the code-history tables in `exo.db`, and git as the check:
   - `commits` ⋈ `commit_files` ⋈ `files` — last `authored_at` per path, commit count
     in the last 90/365 days.
   - `session_files` ⋈ `files` — which **agent sessions** last read/wrote a path and
     when (`last`). A file no human *and* no agent has touched in months is a different
     claim from one the crew keeps editing.
   - `git log -1 --format=%ad --date=short -- <path>` to confirm the DB's answer; git is
     the source of truth if they disagree.
3. **Reachable?** — static, by hand: what imports it, what routes to it, which SPA route
   mounts it, which `features.py` flag already gates it, what tests cover it. This is the
   intelligence-sensitive part. **Anything you cannot trace is not a candidate.**

The **database is a signal, never a target.** `exo.db` holds her life. Shed touches code
only; a "neglected collection" is evidence about the code that reads it, not something to
export or drop. If a shed cut leaves a collection orphaned, say so and leave the data where
it is — rows keep, and the code that reads them will be restored beside them if she ever
brings it back.

## Present, teach, then she marks

Assume the owner doesn't read code. For each candidate, plainly: what this is, where it
lives (paths, so she learns the territory), what each of the three signals says, **what
would go dark if it's shed**, and how it comes back. Then she marks each one:

| Mark | Meaning |
|---|---|
| **Keep** | Leave it. Cold on purpose, or you're not sure enough. |
| **Shed** | Cut it to the archive with a restore handle. |
| **Refugium** | Never propose it again. Shared with burn's record — one list, both practices honor it. |

Item by item. No batch-confirm, no assent from silence. Refugium is written into the record
*immediately* with her reason.

## The cut — how archiving actually works

Git is the archive; the ledger is the index. Nothing is copied into the vault (code stays
in `skeleton/`; her files stay in `personal/`).

1. **Branch, never the live checkout.** `git worktree add ../shed-<id> -b shed/<id>` from
   `main`. All edits happen there.
2. **Preserve, then remove.** Before removing anything, tag the pre-cut tree:
   `git tag shed-keep/<id> <main-sha>`. That tag is the whole skin, intact — the restore
   handle. Then delete the scoped paths / sections, unwire the registration (the
   `register(app)` line in `server.py`, the SPA route, the nav entry, the feature flag if
   it becomes meaningless), and fix imports.
3. **Section grain needs a seam.** When shedding a *section* of a file, not the file, the
   removed code is preserved by the tag exactly like a whole file is, and a one-line
   plain-English note at the cut site names the shed id — so the next reader (or Claude)
   knows something was set down there, not that it never existed.
4. **The firebreak is the full test suite, run by the harness, not claimed by an agent.**
   `./venv/bin/python3 -m pytest` and `cd frontend && npm run build` in the worktree. Red
   means the cut isn't clean; fix or abandon, never merge red.
5. **Commit on the branch** with a message that starts `shed(<id>):` and names what was
   set down and why. **Nothing merges. The owner merges** (`git merge shed/<id>` on main,
   then the usual reload / build). Until she merges, nothing has changed on the live site.

## Restore

`/shed restore <id>` reads the ledger entry and does, in a worktree:

```
git checkout shed-keep/<id> -- <each path in the entry>
```

then re-wires the registration the cut unwired (the entry records exactly what it
unwired), runs the same firebreak, and commits `restore(<id>):` on a branch for her to
merge. Restoring a **section** is the same checkout scoped to the file, then a merge of
the old section back into the current file by hand — say plainly if the file has drifted
enough that this needs her eyes.

A restored entry stays in the ledger with `state: restored` and the date. Something she
reached for once is evidence it's seed bank; **mark it Refugium unless she says otherwise.**

## The record

`$EXOCORTEX_DATA_DIR/shed_ledger.json`. The campaign is the file, not the conversation.
Per entry:

```
id            e.g. "car-2026-08-27" (scope slug + date)
scope         the argument as typed, plus the resolved grain (codebase|feature|file|section)
paths         every path removed or edited
unwired       the registrations removed (server.py line, SPA route, nav, flag) — restore needs these
tag           "shed-keep/<id>"
branch        "shed/<id>"
state         proposed | shed | merged | restored
evidence      {used: …, modified: …, reachable: …} as presented to her, in one line each
reason        her words, why she shed it
shed_at / restored_at
```

Refugium lives in **`burn_units.json`** (state `refugium`), not here — one spared-list that
both practices read before proposing anything. Read it first; never re-raise a refugium.

Write the ledger before the session ends, including scopes surveyed and left alone.
An unrecorded pass did not happen.

## Hard rules

- **Nobody watching, nothing shed.** No unattended invocation, no autonomous cuts.
- **One scope cut per session.** Survey may be wide; the cut is narrow.
- **Code only. Never data.** `exo.db`, the JSON mirrors, and everything under
  `EXOCORTEX_DATA_DIR` / `EXOCORTEX_CONTENT_DIR` are read for evidence and never touched.
- **Three signals, reported separately.** Never collapse used/modified/reachable into one
  verdict; never dress a guess as a determination.
- **Never shed what you cannot survey.** Untraceable reach means it stays.
- **Tag before you delete.** No restore handle, no cut.
- **Refugium is permanent and sticky**, shared with burn.
- **Nothing merges without her.**

## When to reach for burn instead

When something has been shed, sat in the archive for a full season, and she never
restored it — that's cured fuel. Say so in the ledger (`state: merged`, age) and let `/burn`
take it from there. Shed is how a thing proves it's dead; burn is what you do once it has.
