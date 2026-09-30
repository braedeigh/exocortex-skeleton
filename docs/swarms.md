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
- **A swarm is at least two sessions still working, plus its helper.** Her
  words: "i don't necessarily want a swarm to be just 1 agent and the helper.
  i want a swarm to be a minimum of 2 sessions and a helper." Counted in
  *lines of work*: a session and its continuations are one, finished members
  (done, archived, handed on) and helpers don't count (`swarms.live_lines`).
  Below two, the swarm is closed (below) and its one working session stands
  in the room as working alone. The room helper won't form a swarm from
  fewer than two working lines; a split or release that leaves one behind
  closes the old swarm, says so in the move, and tells that session.
- **One helper per swarm**, running Sonnet. It names the swarm (its own
  "project"), keeps one current summary per member and one for the swarm,
  notices where members' work differs or collides, and coordinates. Its
  summaries are **replaced, not accumulated**: each update is a fresh call that
  sees only the latest summaries plus what's new, so its context never grows.
- **One helper chat for the swarm's whole life.** The owner's chat with the
  helper is never handed off or archived while the swarm is active. Each turn
  in it is a fresh model session, seeded with the helper's instructions, the
  swarm's current summaries (the swarm's and each member's, written by the
  Sonnet summarizer), the **chat summary** (what it last told her, her
  decisions word for word, promises, open threads — rewritten by Sonnet after
  every turn, replaced not appended) and her own last `HELPER_CHAT_MESSAGES`
  messages verbatim (default 20). Its own replies, agents' mail and system
  notices are not replayed. Its instructions say the view is shaped this way
  and where to search the rest (every transcript, `peers.py show`,
  `exo_query.py` over `agent_messages` / `tool_calls`, git). Only what the
  model is handed rolls; the full transcript stays on disk. The chat is
  exempt from the context cap.
- **Finished members drop out of the helper's view after a day.** Her ask: "drop
  off done/retired sessions from your checking after 24 hours." A member that
  is finished (the same rule as retiring, below) and whose last activity, done
  mark or archiving is over `config.SWARM_HELPER_FORGET_HOURS` (24) old is left
  out of the summarizer's runs and the chat seed (`swarms.in_helper_view`). It
  stays a member: the pages, the network drawing and the closing check still
  count it, and the chat seed names it in one line so it can still be looked up.
- **Old helper sessions are out of the helper's view entirely.** Her ask: "for
  the helper session, i don't want it to read and receive summaries from the
  retired helpers anymore." A helper could once be handed off, and its
  successor ("Swarm helper · … (cont.)") has no role, so an agent messaging it
  made it a member. `swarms.is_helper_session` recognises a helper or any
  continuation of one; `in_helper_view` leaves those out (not even named), and
  the summarizer's "Messages between members" leaves out their messages. They
  stay members for the pages and the closing check.
- **A closing check when the swarm retires.** A swarm is *retired* when fewer
  than two of its lines of work are still going — the rest done (`done_at`),
  archived, handed on to a continuation, or gone from the index, and none of
  them mid-turn (`swarms.retired`). The helper then
  posts one last message built from git and the session records, not the
  agents' word: commits it made (as git announced them, checked against the
  repo), files written but not committed, members closed without saying they
  were done (or are still working, on their own now), questions still
  waiting on her, detached jobs still running. Then it marks itself done;
  the usual two-hour countdown closes it. If two lines of work are going in
  the swarm again, the helper comes back. A closed swarm's helper isn't
  poked by member turns (`swarm_helper.poke`).
- **A swarm closes when its work is over.** Her ask: "closes swarms on the
  UI when all agents within it are closed", then the two-session minimum
  above. Closed is the retired rule above (fewer than two lines of work
  still going; the swarm's own helper doesn't count), worked out fresh on
  every read, never stored (`swarms.is_closed`) — so a second line of work
  going again, a member or a new session messaging or joining, opens the
  same swarm again by itself.
  `swarms.overview` marks each card `closed`. The rooms, the room map,
  Worktrees and Terrain hide closed swarms unless the shared "Show closed
  swarms" switch is on (`swarmApi.shownSwarms`); a hidden closed swarm's
  members stand in the room as ordinary cards — its finished ones as done
  cards until they close, its one working session as working alone.
  The room helper reads only open swarms and can't join or split into a
  closed one (`room_helper.open_swarms`).
- **Visible everywhere.** A swarm card in its room on the Observatory (summary,
  counts of working / silent / needs input; tap in for the member cards in the
  usual orange / purple / grey), a swarm on the Terrain map, and a helper page
  showing what the helper read, the messages between members, and its
  summaries — with an input box to talk to the helper.

## The room helper

A layer above the swarm helpers: one helper per room (the Coding room only,
for now — `config.ROOM_HELPER_ROOMS`), in `room_helper.py`. Her ask: "a helper
in the coding room at large … reads just the summary of what's going on with
the swarm and the summaries of the single agents and determines if they
should be designated as a swarm … or placed into an existing swarm. It also
can separate out swarms if a cluster is not talking to other clusters anymore
or move solo sessions out of a swarm into the layer above."

- **What it reads.** Summaries only: each swarm's and its members', each
  swarm's *clusters* (worked out in code: who messaged whom within
  `config.ROOM_HELPER_QUIET_HOURS`, plus handoffs, and when each cluster last
  messaged another), and each session working alone (its own summary of it,
  kept in `session_summaries`, plus what's new). And its last ten moves.
- **What it does.** Four moves — **form** a swarm from sessions working alone,
  **join** sessions to a swarm, **split** a cluster out of a swarm into its
  own, **release** sessions to work alone. It acts on its own (her decision,
  2026-09-27), conservatively: never splitting clusters that talked within the
  quiet window, never redoing a move she undid.
- **Placements override messages.** Her words: "look at who's connected in
  the current swarm and you'll see what I mean. Spins could lead to
  disconnected swarms." A move is stored as a placement (`swarm_pins`): the
  messages a session exchanged at or before it no longer link it; newer ones
  do, so a released session that starts talking again is pulled back in
  naturally. A session's continuations always move with it.
- **Every move is visible and undoable.** Posted in the room helper's chat
  with its reason and undo line, stored in `room_moves` with what it
  replaced; `scripts/room_moves.py undo <id>` (and `list`, and the four moves
  by hand). Each moved session gets one message, queued for the end of its
  turn — never an interrupt.
- **When it runs.** At the minute tick, at most every
  `config.ROOM_HELPER_MIN_SEC`, only when something in the room happened since.
  One tool-less Sonnet call; every run in `room_helper_runs`.
- **Its chat** works like a swarm helper's (helper_chat.py): fresh every turn,
  seeded with the room overview instead of one swarm.
- **The room from above** (`RoomMap.tsx`, at the head of any room with a room
  helper). Her ask: "a display on the front with circles for each swarm and
  the generated helpers in the middle and extra agents in rows below that."
  The room helper on top with its last move, each swarm in a circle drawn as
  on its page (`SwarmNetwork.tsx`, its helper in the middle), and the
  sessions working alone in rows beneath. Data: `GET /api/swarms/room/<room>`.

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
| Swarms | `swarms.py` (grouping, `swarms` / `swarm_members` tables); `routes/swarms.py`; `SwarmCard.tsx` in each room via `SessionLane.tsx`, coloured from the roster and ordered with the sessions (orange first, longest wait on top; retired members left off) by `roomOrder.ts`; `SwarmPage.tsx` at `/observatory/swarm/<id>`; the network of rings and talk-lines in `SwarmNetwork.tsx` (on the swarm page and under the Worktrees plots); the outline + name around member orbs on Terrain in `terrain/terrainSwarms.ts` (drawn by `terrainCanvas.ts`) |
| Helper | `swarm_helper.py` (one tool-less Sonnet call per run, structured answer, every run in `swarm_helper_runs`); runs after member turns (debounced by `config.SWARM_HELPER_MIN_SEC`), on the minute tick, when a swarm forms, and straight away when messaged |
| Helper chat | `helper_chat.py` — the rolling seed (`write_seed`, called by `begin_turn`, which never resumes a helper; the latest seed is kept at `bot_chats/helper_seed/<conv>.md`) and the running notes (`rewrite_notes`, called by `after_turn`; the chat summary, stored as `helper_notes` on the helper's index entry); `config.HELPER_CHAT_MESSAGES`; exempt in `continuation.due` |
| Room helper | `room_helper.py` (runs, moves, undo, the room overview); placements in `swarms.py` (`place`, `unplace`, `new_swarm`, `line_of_work`; `links` cuts pre-placement messages); `swarm_pins`, `room_moves`, `session_summaries`, `room_helper_runs` (sqlstore rung 37); `scripts/room_moves.py`; ticked by `scripts/coming_up_dispatcher.py` |
| Closing check | `swarms.retired`; `swarm_helper.watch_retirement` / `close_out` / `closing_report`, run by `swarm_helper.tick` on the minute tick |

## Status

- The room helper: built and tested (`tests/test_room_helper.py`, placements
  in `tests/test_swarms.py`), and the room map above the Coding room. Undo is
  through the chat or `scripts/room_moves.py` (no undo button on the room map
  yet).

- Mailbox, token accounting, continuation, swarms and the helper: built and
  tested.
- The helper chat's rolling context and the closing check: built and tested
  (`tests/test_helper_chat.py`). The swarm page doesn't show the chat
  summary yet; it's on the helper's index entry and in its seed file.
- Swarms on the Terrain map: a faint accent outline around the member orbs
  that are on the map, with the swarm's name above it. Owner only.
