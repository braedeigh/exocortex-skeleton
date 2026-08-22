# Worktrees — who works where, and how work comes home

Plain English: several Claude sessions can be building in this app at once. This
is the rule for which folder each one stands in, so they stop editing each
other's files, plus how their work gets back into the running site.

Cross-file by nature — the parts live in `worktrees.py`, `routes/spinoff.py`,
`routes/observatory.py` and `claude-commands/spinoff.md`, so the decision lives
here and those files just point at it.

## The problem this solves

Twice, two sessions sharing this one checkout mixed their work. On 2026-07-14
commit `8edf77b` swept another session's uncommitted backend edits into a commit
whose message mentioned neither. On 2026-07-31 commit `9318140` did it again
with a half-written `routes/spinoff.py`. Nothing was lost either time — luck,
both times. The bad version is a broken half-file committed under someone else's
message, or a `git checkout --` discarding edits nobody can recover.

It isn't carelessness. `CLAUDE.md` says "deliberate, named commits" and never
says *how to stage*, so the sweeping session was following the rules as written.
Prose can't fix it. A session that doesn't physically have your files can't
commit them.

## Who stands where

| Room | Ground | Why |
|---|---|---|
| **Personal** | the parent of both repos | hers; sees code and vault as peers |
| **Coding** | the real checkout | hers; gunicorn serves this folder, so she edits and refreshes |
| **Orchestra** | its own git worktree | unattended; nobody is watching it |

Only Orchestra moves. The two rooms she works in keep the live edit-refresh
loop, because that's the whole reason they exist.

The trade an Orchestra session makes: **it cannot see its change in a browser.**
Gunicorn serves the real checkout, not the copy. Its proof is a test run.

## The topology is a hub, not a chain

```
              ┌──  her sessions      (the real checkout)
main ─────────┤
 (integration)└──  agent/<slug>-<date>   (Orchestra worktrees)
```

Everything is cut from `main` and merged back to `main`.

**The rule: a worktree branch is merged by the owner of the integration point,
never *into* a workspace.** Merging an agent branch into a branch somebody is
standing in — with their uncommitted work in the tree — just moves the original
collision one level down. Nothing merges into a live workspace, ever.

A consequence worth knowing: a worktree is cut from the last **commit**, not
from the working tree. So a spinoff can't see work she hasn't committed. The
discipline that keeps agents building on fresh ground is committing often, not
a cleverer branch graph.

## Lifetime — the rule that keeps a session alive

A conversation's `cwd` is fixed at birth. Claude Code stores conversations per
directory and `--resume` from anywhere else fails, which is why the worktree is
minted at session-create time and can't be bolted on later.

It's also why **`sweep()` keys on the conversation being archived, never on
age.** A worktree is a live session's cwd. Deleting one because it looks old
doesn't reclaim a stale copy — it permanently kills a session that was merely
idle, and no amount of disk is worth that. Closing a session is the one moment
the copy can go. The **branch survives**: that's where the work is.

## How work comes home

Not automated yet. Today:

```
git merge agent/<slug>-<date>      # from the real checkout, clean tree
cd frontend && npm run build
sudo systemctl reload exocortex.service
```

The morning ship-it tap (the Foundation's link 4) is what replaces the typing.
When it's built it should merge **and then re-run the gates**, because a clean
auto-merge of two branches that each passed alone produces a file nobody has
ever tested — a rename on one side and a call to the old name on the other both
apply cleanly. `routes/nightcrew.py`'s `nightcrew_merge` is the guard pattern to
copy: ready-only, clean tree required, `--no-ff`, abort on conflict, and never
restart the service on its own.

## What isn't isolated

Worktrees isolate **code, not data**. Every session reads and writes the same
`EXOCORTEX_DATA_DIR`, and it has to — a session writes to `bot_chats/index` just
by existing. `store.py`'s atomic writes and lock are what protect that layer.

`venv/` and `frontend/node_modules/` are **symlinked**, one physical copy shared
by all. Harmless while they're read-only, which is the normal case — but an
`npm install` mid-flight is visible instantly to every live worktree, including
ones built against the old dependency set. It's the one action that reaches into
a running session's ground.

## Two traps, both verified against git rather than assumed

**`venv/` doesn't match a symlink.** A trailing slash in `.gitignore` matches
directories only, and a worktree's venv is a symlink, which git counts as a
file. The root `.gitignore` now spells it both ways.

**`.git/info/exclude` in a worktree is never read.** Git resolves that path to
the **common** git dir, not the per-worktree one — so the exclude file
`scripts/nightcrew_run.py` writes there has never had any effect. Its
`NEVER_OURS` staging filter is what has actually been protecting night branches.
The common file would work, but it's shared with the live checkout, which is why
the fix is a committed `.gitignore` instead.

**And Vite's cache.** `node_modules/.vite` is shared through the symlink, so two
concurrent builds would corrupt each other's optimized deps. `cacheDir` in
`frontend/vite.config.ts` is now project-root-relative, giving each worktree its
own. The night crew never hit this because it runs one job at a time; parallel
sessions are the entire point here.

## Reporting back

`/spinoff` hands work out as a `BRIEF.md`. It comes back as a **message in the
session**, not a document: what changed, what it could break, what the agent
isn't sure about, and what it actually ran.

**There used to be a `REPORT.md`** — ~2,000 words per spinoff, written as the
session's last act, surfaced on the branch cards. Removed 2026-08-22 on her
call, from a count: 8 written across 42 spinoffs, and she had read none of
them. The same information was already reaching her in the closing chat
message, which she does read, so the document was a second copy with no reader.
What died with it was mostly "what I built" and "how it fits" — the parts an
agent enjoys writing. What the closing message still has to carry is the blast
radius and the honest uncertainty.

**The doctrine that outlived it:** an agent's account of its own work is a
claim, never a result. A well-written explanation of code that doesn't work is
the most convincing wrong thing this system can produce. So the numbers —
commits, files, diffstat — are read from git by `worktrees.evidence()` /
`branch_evidence()` and surfaced on the branch cards by `routes/branches.py`,
and they are now the *only* thing those cards say. Same doctrine as the night
crew's "this script runs the tests, not the agent." Don't reintroduce a prose
artifact that sits beside the evidence looking like more of it.

Today that evidence answers *what changed*, not *does it work* — running the
gates belongs with the merge tap, which isn't built yet.
