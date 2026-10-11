# Spinoff lineage — which session was spun off from which

Every spinoff session remembers where it came from, so the sessions can be
drawn as a family tree: a page in the Observatory, and arrows between agent
orbs on the Terrain.

## The two fields

On a spinoff's entry in `bot_chats/index`:

| field | what it holds |
|---|---|
| `spawned_from` | the conversation id of the parent session. Absent when there is no parent session (a helper button, a terminal). |
| `spawned_via` | how it was born: `skill` (the `/spinoff` script run from a session), `go` (her tap on the Go card), `fork` (the fork button), `helper` (a helper button), `steward` (the branches room), `terminal` (a Claude Code session outside the Observatory), `app` (anything else with no calling session). |

Both are written once, when the conversation is minted, by `open_spinoff` in
`routes/spinoff.py`. A rejoin never rewrites them.

## How the parent is known

- **The script door** (`scripts/spinoff_open.py`, run by `/spinoff` from inside a
  session): every Observatory turn carries its own id in `EXOCORTEX_CONV_ID`,
  and `_sender_conv` reads it — the same signal that decides which room the
  child lands in.
- **Go** (`go_offer`), **fork** (`/api/observatory/conversation/<id>/fork`):
  these arrive as web requests with no such variable, so they pass the parent
  in by name — the offer's own conversation, or the session being forked.
- **Helpers / stewards**: minted by a button, with no parent session.

## Sessions from before the fields

`scripts/backfill_spawned_from.py` worked the links out of the chat logs,
strongest evidence first: the spawn script's reply naming the child's id; a
`spinoff_open.py` / `spinoff_offer.py` command (or a shell loop over slugs)
before the child started; a Claude Code transcript outside the Observatory
(`terminal`); a fork brief naming the session it took over; a helper entry.
Anything it can't place it leaves alone rather than guess. It is safe to
re-run: it only fills entries with no `spawned_via`.

## Where it's read

- `GET /api/spinoff/tree` (`spinoff_tree` in `routes/spinoff.py`) → the
  Observatory's Spinoff tree page (`frontend/src/features/observatory/SpinoffTreePage.tsx`,
  folded by `spinoffTree.ts`), behind a door at the bottom of the roster.
- The Terrain payload's `sessions[].spawned_from` (`routes/terrain.py`) →
  arrows parent → child between orbs (`terrainLineage.ts`, drawn by
  `drawLineage` in `terrainCanvas.ts`). For a visitor a private parent is
  swapped for its opaque handle, the same one its orb carries.
