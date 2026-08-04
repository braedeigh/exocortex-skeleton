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
7. **Report.** As your LAST act, write `<data dir>/spinoffs/<slug>/REPORT.md`
   — the teaching document described below. Not a changelog: the owner
   doesn't read code, and this is how they find out what now exists in their
   app. Write it even if you parked or failed; especially then.
An Orchestra session works in its OWN copy of the checkout (a git worktree, see
worktrees.py) on branch `agent/<slug>-<date>`, so it can't collide with anything
else running — but it also can't see its change in the running site, and its
work reaches the app only when the owner merges that branch. Commit to it early
and name your commits.

## Result
<Leave empty. One line at the end — outcome plus a pointer to REPORT.md, which
is where the real account goes.>
```

### The REPORT.md the child writes back

`/spinoff` hands work OUT as a brief; this is the same handoff coming home.
Tell the child to write these sections, in this order:

- **What I built** — plain English, at the register `CLAUDE.md` sets for the
  in-file layer: readable by someone who doesn't live deep in code.
- **How it fits** — which existing seams it plugs into, which files and
  functions, and *why there* rather than somewhere else.
- **What it could affect** — blast radius. What else reads this data, what
  calls this function, what breaks if it's wrong. This is the section the
  owner most needs and the one an agent is likeliest to skimp: it means
  looking *outward* from the change rather than admiring it.
- **What I chose against** — the forks it hit and how it ruled, so the owner
  doesn't inherit decisions without knowing they were decisions.
- **What I'm unsure about** — named, so uncertainty has somewhere to go other
  than being smoothed over.

**Tell it not to claim its work passes.** The report exists to TEACH, and it is
the most persuasive thing an agent can produce about code the owner can't check
— a beautiful explanation of broken code reads exactly like a good outcome. The
numbers (commits, files, diffstat) are read from git by `worktrees.evidence()`
and served beside the prose by `GET /api/observatory/conversation/<id>/report`,
deliberately kept apart from the agent's telling. Same doctrine as the night
crew's "this script runs the tests, not the agent."

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

**The room comes along by itself — don't name one unless they did.** A spinoff
lands in the room THIS conversation is in: spun off from a Personal session it's
Personal, from an Orchestra session it's Orchestra. That's inherited from your
own session id, so the plain command above is the right one almost always. Two
cases where you say it outright, with `--room personal` / `--room orchestra`:

- **They specified.** "put it in personal", "that one should be orchestra."
- **You're not in a room at all** — a terminal session, not an Observatory one.
  Then there's nothing to inherit and it falls to `orchestra`, the room that
  stops and asks. If the work is really vault-side or hers-in-real-time, pass
  `--room personal`; otherwise let it default.

The room isn't cosmetic: it sets where the child is rooted (Orchestra = the app
checkout, Personal = the parent of both repos, where it sees code and vault as
peers) and whether it stops to ask before irreversible work (Orchestra asks,
Personal acts). The reply's `lane` is the room it actually landed in — tell her
which room each session went to when you report back.

(Same narrow-door doctrine as `scripts/stage_change.py` — agents shell out to
the script; the app's own UI uses `POST /api/spinoff/open`, both wrapping the
same core in `routes/spinoff.py`.) The JSON reply tells you `newly_spawned`,
`conversation_id`, `lane` and `started`. There is no tmux tab: the endpoint
mints an Observatory conversation (config'd as a builder session) and hands the
kickoff to a detached `scripts/spinoff_runner.py`, which posts it through the
real send route. **`started: true` means the session is already working** — she
doesn't have to open it, doesn't have to be at the machine, and gets no chance
to skim the kickoff first. If a live (non-archived) conversation for that slug
already exists, the endpoint rejoins it instead of minting a new one
(`newly_spawned: false`), leaves it untouched, and does NOT re-fire it — a
rejoin reply carries no `started` at all.

**`staged`/`autostart` on the reply are the FALLBACK, not the mechanism.** Both
come back true on a fresh spawn, and they describe the kickoff still sitting on
the entry as `draft` in case the runner never started (a bad interpreter path, a
box under memory pressure) — then opening the session fires it the old way. Do
not report them as a bug or a conflict, and do not read them as "it's waiting
for her". They can't double-fire: whichever send lands first pops both fields,
and a second send into a running conversation is refused with a 409. A
`started: false` is the one case where she really does have to open it.

Tell the owner the session(s) are **running now**, which room each went to
(`lane`), and what each is working on. Her sequencing decision is therefore
YOURS, made before you spawn, not hers made at the door: if two spinoffs would
edit the same files they must not be spawned together — propose combining them
into one session, or spawn the first and hold the second until it ships. If
`newly_spawned` came back false, tell her the spinoff session already exists in
the room and was left alone. Done — the child is already taking it from there.
