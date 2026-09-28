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

**The brief is a distilled summary, not a context dump — and it is the child's
first message.** The whole file is posted into the new chat as-is, so the owner
reads it there too; write it for both of them. What you hand the child is: what
the task IS (your distillation of what the owner wants), WHERE to look (files),
and your read of the ground — marked as unverified. Anything you assert about
the code, the child re-verifies before believing it. Keep it tight; the child's
fresh eyes are the point.

**"Where to look" is a strict list: one file per line, nothing else.** Every
file listed is pasted into the child's hidden instructions before it starts (a
session merely *asked* to read its files skipped about one in eight — mostly
the tests). Absolute paths, or relative to the room's working folder (Coding =
the app checkout, Personal = the parent of both repos). A line range narrows a
big file: `path:120-180`. After the path, a space and a short note is fine.
Files only — no folders, no prose lines; put dev-note sections and "search for
X" hints in the summary instead. **A path that doesn't exist refuses the whole
spawn** — `spinoff_open.py` / the Go button reports which one, so fix it and
offer again. Very large files aren't pasted; the child is told to read those
itself.

Don't write a Protocol — the general one (explore, teach, questions only if
real ones exist, build, say it in the room) is attached to the child's instructions
automatically, from `claude-commands/spinoff/protocol.md`. Write a
`## Protocol` section only when this job genuinely needs a different one; if
the brief has one, it replaces the general one.

```markdown
# Spinoff: <one-line title>

## The task
<The item verbatim as the owner referenced it, plus your distillation of what
they actually want. If it came from the dev/build TODO, quote the entry and
name its section so the session can find the surrounding notes.>

## Where to look
- routes/example.py — the route in question (relative: a Coding-room child)
- tests/test_example_routes.py
- <absolute path to the dev/build TODO>:40-75 — the section this came from

## Sender's summary (UNVERIFIED — re-verify against the code)
<Your distilled read: constraints, decisions already made by the owner, what
you believe is true of the architecture. Short. The child treats every claim
here as a hint to check, not a fact.>

## Result
<Leave empty. One line at the end — the outcome, plainly.>
```

### No written report — say it in the room instead

There used to be a REPORT.md here: the child wrote ~2,000 words of prose to
`spinoffs/<slug>/REPORT.md` as its last act, and the branches room showed which
branches had one. **Removed 2026-08-22, on her call, from a measurement.** Of 42
spinoffs, 8 had ever produced a report, and she had read none of them — about
15,000 words with no reader. Meanwhile the same information reliably reached her
in the closing chat message, which she does read.

So the account is a MESSAGE now, not a document, and it's short. What the long
form was actually good for — "what could break", "what I'm unsure about" — is
what the closing message must still carry; the parts that died with it were the
ones the agent most enjoyed writing ("what I built", "how it fits"), which is
usually the tell.

The doctrine that outlived it: **an agent's account of its own work is a claim,
never a result.** The numbers — commits, files, diffstat — are read from git by
`worktrees.branch_evidence()` and surfaced on the branch cards by
`routes/branches.py`, and they remain the only part that isn't the agent's word
for it. Same reason `scripts/nightcrew_run.py` runs the tests itself rather than
believing the worker. Don't reintroduce a prose artifact that sits beside the
evidence pretending to be it.

## 3. Offer — a Go button, not a question

Show the owner what you'd spawn: the slug and a one-line task summary per
session. Then, instead of asking "go?", **offer it** (from the skeleton
checkout), with every slug in one call:

```
EXOCORTEX_DATA_DIR=<data dir> ./venv/bin/python3 scripts/spinoff_offer.py <slug> [<slug> ...]
```

(The env var matters: without it the script resolves the repo's default
`data/` instead of the instance's real data dir, and won't find your brief.)

That puts a **Go** card at the bottom of her chat, listing each brief's title.
End your turn there: one short line saying the Go button is up. Don't ask
"shall I?" too. Her tap on Go IS the confirm. It starts the sessions, takes her
to the first one, and that session asks whether to close this chat. You don't
spawn anything yourself, and you won't see the tap.

She can also ignore the card and keep talking. If what she says changes the
plan, edit the brief (same slug) or write a new one, and run
`spinoff_offer.py` again; a new offer replaces the old card. If she says "go"
in words instead of tapping, spawn directly with `spinoff_open.py <slug>`, the
same door the button uses.

**Not in an Observatory session** (a terminal, where there's no chat to put a
button in): `spinoff_offer.py` refuses with "no EXOCORTEX_CONV_ID". Then fall
back to the old way: ask in words, **wait for their go** (this starts a real
agent doing real work, so never skip the confirm), and on yes run
`scripts/spinoff_open.py <slug>` for each.

**The room comes along by itself — don't name one unless they did.** A spinoff
lands in the room THIS conversation is in: spun off from a Personal session it's
Personal, from a Coding session it's Coding. That's inherited from your own
session id, so the plain commands above are the right ones almost always. Two
cases where you say it outright, with `--room coding` / `--room personal` (both
scripts take it):

- **They specified.** "put it in personal", "that one's coding."
- **You're not in a room at all** — a terminal session, not an Observatory one.
  Then there's nothing to inherit, so always name one: `--room coding` for app
  work, `--room personal` if the work is vault-side or hers-in-real-time.

The room isn't cosmetic: it sets where the child is rooted (Coding = the app
checkout, Personal = the parent of both repos, where it sees code and vault as
peers). The reply's `lane` is the room it actually landed in — tell her which
room each session went to when you report back.

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

When YOU spawned (the terminal path, or she said "go" in words), tell the owner
the session(s) are **running now**, which room each went to (`lane`), and what
each is working on. Either way, the sequencing decision is YOURS, made before
you offer, not hers made at the door: if two spinoffs would
edit the same files they must not be spawned together — propose combining them
into one session, or spawn the first and hold the second until it ships. If
`newly_spawned` came back false, tell her the spinoff session already exists in
the room and was left alone. Done — the child is already taking it from there.
