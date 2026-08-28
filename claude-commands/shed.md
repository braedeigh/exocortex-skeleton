---
description: The Shed — attended, reversible molting of neglected code; scope chosen per run (whole codebase → feature → file → section), evidence from usage telemetry, the commit/session tables, and git; the cut is moved whole into `shed/<id>/` with a plain-English SHED.md — inactive in the app, readable by the owner. `/shed restore <id>` brings it back.
model: claude-fable-5
---

# The Shed — reversible molting of neglected code

**Antlers, not ash.** A deer sheds antlers and grows them back; a snake leaves a whole skin
behind, intact. Nothing is destroyed — it's set down, whole, somewhere it can be picked up
again. That is the entire difference from `/burn`: **burn deletes, shed stores.** Same
owner-on-the-line discipline, opposite reversibility.

And the shed is a real shed: a folder the owner can open. Not a git tag, not a ledger only
a programmer can read — **a place with things in it and a note on each thing.**

| Practice | Scope | What happens to the code | Undo |
|---|---|---|---|
| `features.py` gate | one feature | stays in the tree, switched off | flip one line |
| **`/shed`** | **anything the owner scopes** | **moved whole into `shed/<id>/`, inactive** | **`/shed restore <id>`** |
| `/burn` | one feature | deleted | git archaeology |

Shed is the middle rung, allowed to be broader than burn *because* it's reversible. A wrong
burn costs a rebuild; a wrong shed costs one restore.

## Runs on Fable 5 (`claude-fable-5`)

Same reasoning as burn: the hard part is proving what reaches what across a large tree while
the owner cannot check the code herself. Pinned; nothing else inherits the pin. Turns are
long during the survey — that's the survey working.

## Why it's attended

**Nobody watching, nothing shed.** It's reversible, but "reversible" is only true if someone
notices the thing is gone — and the person who notices is the owner reaching for it. She has
to know what was set down. No unattended invocation, ever.

## Scope — she picks the grain

`/shed` with no argument surveys the **whole codebase** at feature grain and presents the
coldest units. With an argument it narrows:

```
/shed                          whole skeleton, feature grain — survey only, then pick one
/shed features/car             one feature: frontend dir + SPA route + routes/car.py + its tests
/shed routes/money.py          one file
/shed routes/money.py:budget   one section — the functions/components/endpoints matching "budget"
/shed restore <id>             bring a shed folder back (see Restore)
/shed list                     read shed/README.md aloud and stop
```

Whatever the grain, **one cut per session.** A whole-codebase survey *presents* many
candidates; it does not *cut* many. Pick the cold one, cut it, note it, stop.

## The evidence — three signals, reported separately

Traffic alone cannot tell *unreachable* from *unvisited* (burn's "cold is not dead"). Shed
adds two more signals, but they are **never merged into one score** — each is named, and a
candidate is presented with all three.

1. **Used?** — `feature_usage.json` via the pulse:
   `EXOCORTEX_DATA_DIR=… venv/bin/python3 scripts/usage_doctor.py`
   Per-feature API reads/writes, per-collection store ops (per caller), tab visits + hours,
   and the two **zero-traffic lists** (route modules, collections). Say when collection
   started — "no traffic in 28 days" is only as strong as the window.
2. **Modified?** — the code-history tables in `exo.db`, checked against git:
   - `commits` ⋈ `commit_files` ⋈ `files` — last `authored_at` per path, commit count in
     the last 90/365 days.
   - `session_files` ⋈ `files` — which **agent sessions** last read/wrote a path and when.
     Say plainly *who* touched it: the owner, or the crew. Machines grooming a file is not
     the same as it being alive — that's sap flowing in, not growth.
   - `git log -1 --format=%ad --date=short -- <path>` — git is the source of truth if the
     DB disagrees.
3. **Reachable?** — static, by hand: what imports it, what routes to it, which SPA route
   mounts it, which nav entry shows it, which `features.py` flag already gates it, what
   tests cover it. This is the intelligence-sensitive part. **Anything you cannot trace is
   not a candidate.**

The **database is a signal, never a target.** `exo.db` holds her life. Shed touches code
only; a "neglected collection" is evidence about the code that reads it, not something to
export or drop. If a cut leaves a collection orphaned, say so and leave the rows where they
are — the code that reads them comes back beside them if she ever restores it.

## Present, teach, then she marks

Assume the owner doesn't read code. For each candidate, plainly: what this is, where it
lives (paths, so she learns the territory), what each of the three signals says, **what goes
dark if it's shed**, and how it comes back. Then she marks each one:

| Mark | Meaning |
|---|---|
| **Keep** | Leave it. Cold on purpose, or you're not sure enough. |
| **Shed** | Move it to the shed with a note. |
| **Refugium** | Never propose it again. Lives in `burn_units.json` — one spared-list both practices honor. |

Item by item. No batch-confirm, no assent from silence. Refugium is written into the record
*immediately* with her reason.

## The shed — what a cut actually is

```
skeleton/shed/
  README.md                       the index — one line per shed, newest first
  car-2026-08-27/
    SHED.md                       the note (template below)
    frontend/src/features/car/…   the files, moved with `git mv`, tree shape preserved
    frontend/src/routes/car.tsx
    routes/car.py
    tests/test_car_routes.py
```

**Everything in `shed/` is inactive in the app. That is a guarantee, not a hope**, and it
holds by construction — nothing scans that directory:

- `pytest.ini` → `testpaths = tests tools/stream`
- `frontend/tsconfig.json` → `"include": ["src", …]`
- `frontend/vite.config.ts` → TanStack Router reads only `./src/routes`
- `server.py` imports each `routes/` module by name; nothing imports from `shed/`

Every cut re-proves it anyway (step 5). If any of those four facts ever changes, this
skill's guarantee is broken and must be re-established before the next cut.

The cut, in order:

1. **Branch, never the live checkout.** `git worktree add ../shed-<id> -b shed/<id>` from
   `main`. All edits happen there.
2. **Move, don't delete.** `git mv` each scoped path into `shed/<id>/` at the same relative
   path. History follows the file. For a **section**, the removed code goes into
   `shed/<id>/<path>.<section>.<ext>` and a one-line plain-English note stays at the cut
   site naming the shed id — a scar that says something was here.
3. **Unwire, and write down every wire.** The `register(app)` line in `server.py`, the SPA
   route file, the nav/tab entry, the feature flag if it's now meaningless, any import that
   dangles. Each one goes into `SHED.md` under *Unwired* — restore needs the exact list.
4. **Write `SHED.md`** (template below) and add the index line to `shed/README.md`.
5. **The firebreak, run by the harness — never claimed by an agent.**
   `./venv/bin/python3 -m pytest` and `cd frontend && npm run build`, both green, plus the
   inactivity check: `grep -rn "shed/" server.py routes/ frontend/src/ tests/` must return
   nothing but the scar notes from step 2. Red means the cut isn't clean; fix or abandon.
6. **Commit on the branch** — `shed(<id>): …` naming what was set down and why. **Nothing
   merges. The owner merges** (`git merge shed/<id>` on main, then reload / build). Until she
   merges, the live site hasn't changed.

### `SHED.md` — the note on the thing

```
# <id>  —  shed <date>

## What this was
Plain English. What the owner saw when it was alive, what it did, which page it lived on.

## Where it lived
- frontend/src/features/car/         (the page)
- routes/car.py                      (the API behind it)
- tests/test_car_routes.py

## Why it was set down
Her reason, in her words.

## What the signals said
- Used:      zero API hits in 28 days (collection since 2026-07-20); tab never visited
- Modified:  last commit 2026-05-14 by the owner; crew touched it 2026-08-02 (a rename sweep)
- Reachable: mounted at /car via src/routes/car.tsx; nav entry in TopTabs; no flag

## Unwired
- server.py: `car.register(app)` line removed
- frontend/src/shell/TopTabs.tsx: the "Car" tab entry removed
- (anything else, exactly)

## Data it read
- collections car_maintenance, car_notes — left in place, untouched

## To bring it back
/shed restore car-2026-08-27
```

## Restore

`/shed restore <id>` reads `shed/<id>/SHED.md` and, in a worktree:

1. `git mv` every file back to the path recorded under *Where it lived*.
2. Re-add every wire listed under *Unwired*. For a section, merge the saved chunk back into
   the current file by hand — say plainly if the file has drifted enough that this needs
   her eyes.
3. Same firebreak: pytest + build, green.
4. Commit `restore(<id>): …` on a branch; **she merges.**
5. Move the index line in `shed/README.md` to a *Restored* section with the date. Leave the
   now-empty folder's `SHED.md` in place with a `Restored <date>` line at the top — the
   scar stays readable.

Something she reached for once is evidence it's seed bank: **mark it Refugium in
`burn_units.json` unless she says otherwise.**

## Hard rules

- **Nobody watching, nothing shed.** No unattended invocation, no autonomous cuts.
- **One cut per session.** Survey may be wide; the cut is narrow.
- **Everything in `shed/` is inactive.** Nothing imports, mounts, bundles, or tests it. Every
  cut re-proves this (step 5). Never put a live path into the shed to "keep it handy."
- **Code only. Never data.** `exo.db`, the JSON mirrors, and everything under
  `EXOCORTEX_DATA_DIR` / `EXOCORTEX_CONTENT_DIR` are read for evidence and never touched.
- **Three signals, reported separately.** Never collapse used/modified/reachable into one
  verdict; never dress a guess as a determination.
- **Never shed what you cannot survey.** Untraceable reach means it stays.
- **No note, no cut.** A folder without a `SHED.md` is a delete with extra steps.
- **Refugium is permanent and sticky**, shared with burn.
- **Nothing merges without her.**

## When to reach for burn instead

A shed with thirty folders is thirty features carried under a roof instead of on the tree —
same fuel, different pile. So the handoff matters: **`/burn` surveys `shed/` first.** A folder
that has sat a full season un-restored is cured fuel; burn's job is to ask her whether it's
time. Shed is how a thing proves it's dead. Burn is what you do once it has.
