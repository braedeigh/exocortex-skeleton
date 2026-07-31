---
description: Spin a task from this conversation into its own Claude session in the Observatory
---

The owner wants to hand work from THIS conversation to a fresh session — e.g.
"spin off 1 and 3", "spin off the sharing thing", "send the install fix to a new
tab". Your job here in the sender session has three parts: **distill, brief,
spawn.** The heavy thinking happens now, in you — you're the one holding the
context the new session won't have.

## 1. Distill — figure out what they mean

Resolve their reference from this conversation: numbered items from a list you
gave, a named finding, an entry they pasted, an item from the build/dev TODO
list (its path is in CLAUDE.md / CLAUDE.local.md — read it if they reference it).
If a reference is genuinely ambiguous, ask — a wrong guess spawns an agent
working on the wrong thing.

Multiple references ("1 and 3") default to **one session each**. If two items
are so intertwined that separate sessions would collide in the same files,
say so and propose combining — their call.

## 2. Brief — write the handoff file

For each task, pick a short readable slug (what the tab should be called —
`keeper-chat`, not `item-1`; numbers mean nothing tomorrow) and write
`<data dir>/spinoffs/<slug>/BRIEF.md`.

**The brief is a distilled summary, not a context dump.** The child will do its
own complete pass over the architecture and the owner's dev notes around the
item — that's its job, baked into the Protocol below. What you hand it is:
what the task IS (your distillation of what the owner wants), WHERE to look
(dev-note sections by name, key files), and your read of the ground — marked
as unverified. Anything you assert about the code, the child re-verifies
against the code before believing it. Keep it tight; the child's fresh eyes
are the point.

```markdown
# Spinoff: <one-line title>

## The task
<The item verbatim as the owner referenced it, plus your distillation of what
they actually want. If it came from the dev/build TODO, quote the entry and
name its section so the session can find the surrounding notes.>

## Where to look
<Pointers only: the dev/build TODO sections by name, related dev-note entries,
the key files/dirs. A map, not the territory.>

## Sender's summary (UNVERIFIED — re-verify against the code)
<Your distilled read: constraints, decisions already made by the owner, what
you believe is true of the architecture. Short. The child treats every claim
here as a hint to check, not a fact.>

## Protocol
You are a task executor, but the owner is in the learning phase and this is
their system — you build WITH their input, never around it. In order:
1. **Explore.** Completely review the architecture this task touches — the
   actual routes, stores, frontend features, docs — and read the owner's dev
   notes related to the item, in full. Verify every claim in "Sender's
   summary" yourself; it is a hint sheet from another session, not ground
   truth. No edits during this phase.
2. **Teach.** Explain to the owner how the relevant structures work today —
   where things live, how the pieces connect, why the code is shaped the way
   it is. Cite file paths so they learn the territory. Assume they are
   learning this system — never assume they already know what's going on;
   build the picture from the ground up.
3. **Clarify.** Ask the questions that genuinely fork the design — the ones
   you cannot answer from the notes or the code. Not ceremony; real forks.
4. **Recap, then check.** Before any plan: recap the structure in a few
   sentences — the map of what you found and what the change will touch —
   and ask the owner explicitly: "anything else you need to know before I
   go into plan mode?" Wait for their answer. Only proceed when they say
   they're ready.
5. **Plan mode.** Enter plan mode and present your implementation plan. The
   owner approves it from an informed position because of steps 2–4. Do not
   write code before the plan is approved.
6. **Build.** Execute the approved plan yourself, following this repo's
   CLAUDE.md conventions (tests for behavior, restart/build steps, commit
   when the thing ships). Keep teaching as you go when something surprising
   turns up.
Another session may be working in this same checkout — commit early, name your
commits, and never discard changes you didn't make.

## Result
<Leave empty. Fill in when the work ships: what landed, commits, what's left.>
```

## 3. Spawn — confirm, then stage the session

Show the owner what you're about to spawn — slug + one-line task summary per
session — and **wait for their go**. This starts a real agent doing real work;
never skip the confirm.

On yes, for each task (from the skeleton checkout):

```
EXOCORTEX_DATA_DIR=<data dir> ./venv/bin/python3 scripts/spinoff_open.py <slug>
```

(The env var matters: without it the script resolves the repo's default
`data/` instead of the instance's real data dir, and won't find your brief.)

(Same narrow-door doctrine as `scripts/stage_change.py` — agents shell out to
the script; the app's own UI uses `POST /api/spinoff/open`, both wrapping the
same core in `routes/spinoff.py`.) The JSON reply tells you `newly_spawned`
and `conversation_id`. There is no tmux tab: the endpoint mints an Observatory
conversation (config'd as a builder session) that **fires its own kickoff the
moment she opens it — she does NOT hit send.** If a live (non-archived)
conversation for that slug already exists, the endpoint rejoins it instead of
minting a new one (`newly_spawned: false`) and leaves it untouched.

**Read the reply's two flags together, because they look contradictory and
aren't.** `staged: true` and `autostart: true` both come back on a fresh spawn.
`draft` is only the *carrier* the kickoff text rides in; `autostart` is what
turns "prefill the compose box and wait" into "send it on open". Autostart
wins. Do not report `autostart: true` as a bug or a conflict — it is the
designed behaviour (`routes/spinoff.py`'s module docstring states it outright),
and the first send consumes both fields, which is why an already-fired session
shows `autostart`/`draft` as absent in the index.

Tell the owner the session(s) are waiting in the Observatory and will **start
working by themselves as soon as she opens them** — nothing to send, and no
chance to skim the kickoff first. That matters for her sequencing: if two
spinoffs would edit the same files, tell her to open them one at a time rather
than both at once. If `newly_spawned` came back false, tell her the spinoff
session already exists in the room instead. Done — the child takes it from
there the moment she opens it.
