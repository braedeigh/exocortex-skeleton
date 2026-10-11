# orchestra-2026-09-25  —  shed 2026-09-25

## What this was
The last live piece of the Orchestra room: every spinoff that landed in Orchestra
was given **its own private copy of the app code** (a git worktree on a new
`agent/<slug>-<date>` branch) instead of working in the shared checkout. The idea
was that unwatched sessions couldn't trip over each other's half-finished files.
The cost was that such a session couldn't see its change on the live site, and
its work only arrived when the owner merged its branch.

The Orchestra *room* had already left the Observatory page on 2026-08-12. What's
set down here is the copy-per-spinoff machinery, plus `/spinoff` no longer
offering Orchestra at all (that half was edited in place on main, commit
`dd4e4c1` — `claude-commands/spinoff.md` is live instruction text, not code to
store).

## Where it lived
- `routes/spinoff.py`, inside `open_spinoff()` — the room check and the
  `worktrees.mint()` call → `routes/spinoff.py.worktree-mint.py`
- `tests/test_spinoff_routes.py` — the worktree-mint tests →
  `tests/test_spinoff_routes.py.worktree-mint.py`

## Why it was set down
Her call, 2026-09-25: "Archive my orchestra ability and change the /spinoff
skill to no longer include it."

## What the signals said
- Used: 56 spinoffs in the index. 22 landed in Coding and 11 in Personal, but only
  1 in Orchestra (`keeper-boot-inject`, 2026-09-25), and it is the only live
  entry holding a minted worktree.
- Modified: the mint arrived 2026-08-04, and `worktrees.py` was last changed
  2026-08-09 (stewards). Both are crew commits.
- Reachable: from `open_spinoff()` only, when the room was `orchestra` and no
  `branch` was given. It was reached through `/api/spinoff/open` and
  `scripts/spinoff_open.py`, both of which remain.

## What stays (on purpose)
- **The Orchestra lane itself** (`routes/observatory.py` `_LANES`,
  `_DEFAULT_LANE`). It's the ask-first room. Night-crew workers run in it, and
  any session the app can't place falls into it, so a wrong guess costs a tap
  and not a mistake. Removing it would widen the autonomy of everything
  unplaced.
- **`worktrees.py`**. Night crew (`scripts/nightcrew_run.py`) and the steward
  door both still use it.
- **Steward adopt-mode**: `open_spinoff(branch=…)`, called by
  `routes/branches.py`. Waking a steward on an existing `agent/*` branch still
  stands it in a worktree on that branch.
- **The branch cards** on the Night Crew page. The branches already minted
  (`coil-tip-curve`, `food-sql`, `keeper-boot-inject`, `research-sql`,
  `terrain-active-scale`) still need merging or dropping, and that happens
  there.
- **Terrain's "Orchestra" agent filter**, because night-crew sessions live
  there.

## Unwired
- `routes/spinoff.py`: `open_spinoff()` lost its `worktree` argument. The mint
  branch is gone, and so are `worktree_failed` on the entry and in the reply.
  The worktree block now runs only for `branch` (adopt). Its refusal message
  changed from "needs the orchestra room and its worktree" to "needs the
  orchestra room".
- `routes/spinoff.py` route: the `worktree: false` request field is ignored.
- `scripts/spinoff_open.py`: `--no-worktree` is removed, and `--room` usage no
  longer lists `orchestra`. It's still accepted, because the steward needs it.
- `tests/test_spinoff_routes.py`: five mint tests shed and one adopt test shed
  (it tested `worktree=False`). One new test says no room mints a worktree.
- `docs/worktrees.md`: the "who stands where" table now names night crew and
  steward instead of Orchestra.

## Data it read
- `bot_chats/index` entries keep their `worktree` / `branch` /
  `worktree_failed` fields untouched. `sweep()` still reaps a worktree when its
  conversation is archived.

## To bring it back
/shed restore orchestra-2026-09-25. Put the mint block back into
`open_spinoff()`, restore the `worktree` argument, the route field and
`--no-worktree`, move the tests back, and revert the `docs/worktrees.md` table.
Re-adding Orchestra to `/spinoff` is a separate edit to
`claude-commands/spinoff.md` (undo `dd4e4c1`).
