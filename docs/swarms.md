# Swarms, self-continuing sessions, and token accounting — the plan

Built on the agent mailbox ([`peers.md`](peers.md)). This file is the design
and the decisions behind it; each stage links back here as it lands. Status
lines say what exists *now*.

## Decisions (from the owner)

- **Soft context caps, per model.** Opus 120k tokens, Fable 250k; Sonnet
  150k and Haiku 100k (chosen modestly, no owner number yet). A session that
  crosses its cap is **not interrupted** — it finishes the work it's on, and
  the handoff happens when that turn ends.
- **Only the Coding room continues itself unsupervised.** Other rooms never
  auto-continue.
- **A swarm is defined by interaction, not assignment.** Two or more sessions
  where each has messaged at least one other member (a connected group in the
  `agent_messages` graph). Not everyone has to have talked to everyone.
- **One helper per swarm**, running Sonnet. It names the swarm (its own
  "project"), keeps one current summary per member and one for the swarm,
  notices where members' work differs or collides, and coordinates. Its
  summaries are **replaced, not accumulated**: each update is a fresh call that
  sees only the latest summaries plus what's new, so its context never grows.
- **Visible everywhere.** A swarm card in its room on the Observatory (summary,
  counts of working / silent / needs input; tap in for the member cards in the
  usual orange / purple / grey), a swarm on the Terrain map, and a helper page
  showing what the helper read, the messages between members, and its
  summaries — with an input box to talk to the helper.

## Stages

1. **Token accounting per model call** — a `model_calls` table: one row per
   call to the model, with input, cache and output tokens and the context size
   at that call, plus which tool calls it made. Per-tool cost is *derived*
   (the output of the call that asked for it; its result's size as the next
   call's input growth) because the API reports usage per call, not per tool.
   The transcripts record input and context exactly but only a partial output
   count, so the turn loop writes one `call-usage` line per call with the
   final numbers from the live stream.
2. **Self-continuing Coding sessions** — at the end of a turn over the cap,
   the app asks the agent (an `[S]` message) to write its handoff; the handoff
   opens a fresh session that starts on its own, seeded with the handoff, the
   files the old session touched, and its swarm helper's summary. The old one
   is closed and linked as the new one's parent (the spinoff lineage in
   `docs/spinoff-lineage.md`).
3. **Swarms** — computed from `agent_messages`; a swarm card per room, the
   member drill-in, a swarm on the Terrain map.
4. **The helper** — one Sonnet per swarm, woken (debounced) when a member's
   turn ends; per-member and swarm summaries stored in SQL; `peers.py swarm`
   for agents; the helper page with its inputs and an input box.

## Where each piece lives

| Piece | Files |
|---|---|
| Token accounting | `model_calls` table (sqlstore rungs 30–31); `toolcallstore.py` parses it; `_note_model_call` in `routes/observatory.py` writes the `call-usage` lines and keeps `context_tokens` / `context_model` on each session |
| Continuation | `continuation.py`; `after_turn` in `routes/observatory.py` (called by `scripts/turn_host.py` when a turn ends); `peers.py handoff`; caps in `config.CONTEXT_CAPS`, rooms in `config.CONTINUE_LANES` |
| Swarms | `swarms.py` (grouping, `swarms` / `swarm_members` tables); `routes/swarms.py`; `SwarmCard.tsx` in each room via `SessionLane.tsx`; `SwarmPage.tsx` at `/observatory/swarm/<id>`; the network of rings and talk-lines in `SwarmNetwork.tsx` (on the swarm page and under the Worktrees plots); the outline + name around member orbs on Terrain in `terrain/terrainSwarms.ts` (drawn by `terrainCanvas.ts`) |
| Helper | `swarm_helper.py` (one tool-less Sonnet call per run, structured answer, every run in `swarm_helper_runs`); runs after member turns (debounced by `config.SWARM_HELPER_MIN_SEC`), on the minute tick, when a swarm forms, and straight away when messaged |

## Status

- Mailbox, token accounting, continuation, swarms and the helper: built and
  tested.
- Swarms on the Terrain map: a faint accent outline around the member orbs
  that are on the map, with the swarm's name above it. Owner only.
