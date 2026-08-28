---
description: The Burn — attended, one-unit-at-a-time clearing of dead architecture; surveys a feature's fuel, gates every cut behind the owner, records the rotation
model: claude-fable-5
---

# The Burn — attended clearing of dead architecture

**A prescribed burn, not a cron job.** One unit per session, worked *with* the owner,
recorded so the next session can pick up where this one stopped.

## Runs on Fable 5 (`claude-fable-5`)

Pinned in the frontmatter above. The hard part of a burn is not deleting — it's **proving
reachability** across a large codebase, holding many files at once, and being right about
blast radius when the owner cannot check the code themselves. That's long-horizon reasoning,
which is what this model is for.

Two practical consequences:

- **Turns are long.** Single requests on hard tasks can run many minutes. That's the survey
  working, not the session hanging. Don't add scaffolding to make it report progress faster —
  it narrates well on its own.
- **It's the expensive tier**, and that's the right trade here: a burn is *seasonal*, not
  nightly, it's attended, and a wrong deletion costs far more than the run. Nothing else in
  this system should inherit this pin.

Set `output_config.effort` toward the high end for the survey (reachability is the
intelligence-sensitive part); the gate/burn execution itself is mechanical.

## Why this one is attended

Every other automation in this system runs while the owner sleeps — bounded blast radius,
nobody needs to watch. This one deletes code, and the owner may not read code well enough
to catch a bad call after the fact.

In real fire management you never leave a prescribed burn unattended: there is a holding
crew on the line for the whole duration, watching the edges. **The owner is the holding
crew.** That is not a limitation to work around — it is the reason this is a skill you
invoke and not a cron line that fires. If nobody is watching, nothing is lit.

## Why fire and not the usual pruning

Dead code is **fuel load, not litter**. Litter gets processed continuously by the ordinary
maintenance loop. Fuel accumulates *because* nothing processes it — a dead route sits inert
forever and never decays. Fire ecology's hard consequence applies directly: suppressing fire
does not prevent fire, it guarantees a worse one, because fuel keeps accumulating. Not
clearing dead architecture does not keep the system safe; it raises the cost of the eventual
reckoning.

Two disciplines from the same source, both load-bearing here:

- **Cool burn, never a crown fire.** A surface fire moves through accumulated ground fuel
  and the living canopy survives it intact. Same ignition, entirely different outcome —
  what separates them is intensity and conditions, not intent. Every rule below exists to
  keep this a surface fire.
- **Cold is not dead.** Serotinous cones stay sealed until fire opens them; the seed bank
  looks like nothing until its conditions arrive. A feature with zero traffic may be
  **unreachable** (genuinely dead) or merely **unvisited** (working, reachable, the owner
  hasn't grown into it yet). These are different and must never be conflated. Traffic data
  alone cannot tell them apart.

## The unit

**One burn unit = one feature.** `frontend/src/features/<name>/` plus its `routes/<name>.py`,
its store collections, and its tests. Never sweep "the codebase" — real burn programs divide
the land into units and work a rotation, one at a time.

This boundary is already the reporting boundary: `usage_rollup.py` records per-feature
read/write counts and the architecture pulse (`usage_doctor.py --devnote`) files a
zero-traffic list at the same granularity. Use it; do not invent a second map.

## The three states

Every candidate resolves to exactly one. **Gate is the default path to burn — going
straight from keep to burn should be rare and argued for.**

| State | What it means | Reversibility |
|---|---|---|
| **Keep** | Live and in use, or seed bank the owner is holding on purpose. | n/a |
| **Gate** | Flag it off in `features.py` / `features.json`. No code removed. | One line, instant |
| **Burn** | Delete the code, on a branch, behind the tests. | Git only |
| **Refugium** | Permanent keep. Never proposed again, ever. | Sticky by design |

**Gate before you burn.** Turn it off, let one rotation pass, and if nothing broke and the
owner never reached for it, the fuel is cured and safe to light. If it was seed bank, they
will reach for it, find it dark, and un-gate it at trivial cost. This turns an irreversible
guess into a cheap experiment — take it every time it is available.

## The record

State lives outside any session, in `$EXOCORTEX_DATA_DIR/burn_units.json`. **The campaign is
the accumulation of records, not the length of a conversation.** A session dies; the record
does not. Never hold campaign state in context and never ask the owner to keep a session
alive to preserve it.

Per unit: `id`, `paths`, `state`, `last_surveyed`, `last_action`, `interval_days`, and a
`history` array of what happened each pass and why. Refugium decisions carry the owner's
stated reason.

## The session

One unit. The skill refuses to sprawl across units even when it looks easy.

0. **Look in the shed first.** `skeleton/shed/README.md` (see `/shed`) lists what has already
   been set down and when. A folder un-restored for a full season is cured fuel — the most
   honest burn candidate there is, and it's already inactive, so the survey is short.
1. **Read the record.** Report the rotation state in one or two lines: units done, units
   remaining, what is next and why it is next.
2. **Survey the fuel.** For this unit only: pull its zero-traffic entries, then establish
   **reachability** statically — what routes to it, what imports it, whether any path
   reaches it at all. Reachability and traffic are separate signals and must be reported
   separately. Anything you cannot survey is not fuel; leave it standing.
3. **Present with evidence, and teach.** Assume the owner does not read code. For each
   candidate, in plain language: what this thing is, why you believe it is dead, what the
   evidence is, and **what would break if you are wrong.** Cite file paths so they learn the
   territory. A candidate you cannot explain this way is a candidate you do not propose.
4. **They mark.** Keep / gate / burn / refugium, item by item. Refugium goes into the record
   immediately with their reason so it is never surfaced again. Do not batch-confirm; do not
   infer assent from silence.
5. **Execute.** Gates are a config change. Burns happen on their own branch in a throwaway
   worktree, never in the live checkout. **The firebreak is the full test suite, run by the
   harness and not claimed by an agent** — a worker reporting its own smoke is the failure
   this design can least afford. Nothing merges. The owner merges.
6. **Write the record.** Update `burn_units.json` before the session ends, including units
   surveyed and left alone. An unrecorded pass did not happen.

## Hard rules

- **Nobody watching, nothing lit.** No unattended invocation. No autonomous deletion, ever.
- **One unit per session.**
- **Refugium is permanent and sticky.** Re-proposing something the owner already spared is
  the specific failure mode that destroys trust in the whole practice — it reads as pestering
  until something slips through. The record exists mainly to prevent this.
- **Unreachable, never merely unvisited.** If the only evidence is low traffic, the honest
  proposal is *gate*, not *burn*.
- **Never burn what you cannot survey.** Unprovable blast radius means it stays.
- **Uncertainty is reported, not resolved.** "I don't know whether this is reachable" is a
  finding, not a failure. Never dress a guess as a determination.

## The rotation

The **first pass** is finite — a landscape that has never been burned, with a real backlog
and a real end. Say so; it is the honest and encouraging thing.

**After that it does not finish.** Burn programs rotate, because by the time the last unit
is worked the first has grown fuel again. Build the record as a rotation with a return
interval per unit, not a checklist that reaches zero — a completed checklist invites lapse,
and lapse is how the decade of accumulated fuel happens in the first place.

Get the interval wrong in either direction and the community degrades: too rare and the
canopy closes, **too frequent and the seed bank is exhausted.** For this system too-frequent
is the sharper risk, because a burn that keeps re-raising the same cold features will
eventually get one past a tired owner. This is not a nightly job. Seasonal; quarterly at most.

## Open — the owner's cuts still needed

The gate state exists: `features.py` reaches feature granularity, and the first unit
(`research`) has been surveyed, marked, and executed — read `burn_units.json` for what
happened and why. The practice is live; the map it walks is not drawn yet.

- The unit map: ~43 feature directories exist; which are units, which merge, which are out
  of scope entirely. Everything below waits on this.
- Whether the rotation covers `skeleton/` only or reaches `personal/scripts/` too.
- Per-unit return intervals. Only `research` has one (120 days); the rest are unset, and the
  rotation cannot schedule itself without them.
