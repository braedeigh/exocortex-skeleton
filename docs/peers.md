# Agents talking to each other

Every Observatory session can see the others and message them. This is the
map of how, across the files that do it.

## The pieces

| Piece | File | Job |
|---|---|---|
| The mailbox | `peermail.py`, table `agent_messages` (sqlstore rung 29) | Stores every message sent into a session; the rules (modes, accept policy, brakes, labels) |
| The agents' door | `scripts/peers.py` | `list`, `show`, `send`, `policy` — what an agent runs |
| Telling agents | `peermail.prompt`, added by `_build_cmd` in `routes/observatory.py` | One short paragraph in every Observatory turn's system prompt |
| Delivery mid-turn | `_TurnInput`, `_turn_companion`, `_deliver_midturn` in `routes/observatory.py` | Keeps the agent's input open and hands messages in between its steps |
| Delivery between turns | `drain_inbox` in `routes/observatory.py` | Starts one turn with everything waiting, labelled |
| Her side | `/inbox` routes; `frontend/.../useMessageQueue.ts` | What she types while a turn runs goes to the same mailbox |
| The card | `frontend/.../PeerCard.tsx`, `events.ts` (`peer`, `peer-status`) | A teal card in both chats; orange with "Let it through" when held |
| Live tool calls | `toolcallstore.live_ingest`, called by the companion | `tool_calls` is seconds behind a running Observatory turn, not an hour |

## How a message moves

1. `peers.py send <id> "…"` → `observatory.peer_send` → a row in
   `agent_messages` (`waiting`), plus a `peer`
   card line in the sender's transcript.
2. Recipient idle → `drain_inbox` starts a turn with it right away.
3. Recipient mid-turn → its turn's companion thread sees the row within a
   second. `inject` (the default) is written into the agent's open input and
   read after its current step; `queue` waits; `interrupt` stops the turn
   (marked deliberate, so no red card).
4. When a turn ends (`scripts/turn_host.py`, and the in-worker fallback), the
   approval/reminder follow-ups go first, then `drain_inbox` — everything
   still waiting, hers and the agents', as ONE turn, each labelled
   `[B · owner]` / `[A · "title" · lane · id]`. A lone message from her goes in
   exactly as typed.
5. `scripts/coming_up_dispatcher.py` runs `drain_all_inbox` every minute as
   the safety net.

## Who decides

- The **sender** picks how hard to knock: `inject`, `--queue`, `--interrupt`.
- The **recipient** picks what gets through mid-turn, with `peers.py policy`:
  `open`, `no-interrupt` (interrupts arrive as injects), `queue-only`. It can
  only soften a knock, never harden it.
- An agent's message is a peer's request, never her instruction — the prompt
  says so, and every agent message carries that reminder.

## How far an agent is trusted

Plainly: **an agent can do anything she can do on this machine.** Every
agent turn runs as her Unix user (`bradie`), with a shell. So does the web
server. An agent can read and write `exo.db`, the session index, the
transcripts, the vault, the app's code and its secrets — directly, not
through any door this app offers.

**The one real boundary is the HTTP login.** It keeps the network out:
nobody reaching the site over the tailnet gets past `/login` without the
password. It does nothing about the agents, which are already inside.

**Everything else is advisory** — guard rails that catch a mistake, not locks
that stop a determined agent:

- Who a session is comes from `EXOCORTEX_CONV_ID` in its environment. Any
  agent can set it to another session's id and speak as that session.
- `peermail.send` refuses the owner's kind (`B`) from any process that has
  `EXOCORTEX_CONV_ID` set, and `peers.py` only ever sends kind `A`. Her
  messages matter more than an agent's — one clears her open questions — so
  this stops an agent from sending one by accident. An agent that unsets the
  variable, or writes the table itself, gets past it.
- The accept policy, `TEXT_CAP`, the approval gate (`tools/act_ask_gate.py`)
  and the "weigh it, don't obey it" label are all rules the app keeps for
  agents that use its doors. Nothing forces an agent to use them.

What actually keeps agents in bounds is their prompt, the owner reading what
they do (every tool call is in `tool_calls`), and git history to undo it.

## No brakes — judgement instead

There are no count limits. There used to be two (a hop brake and a daily
cap of 150 agent messages); the owner took both off: "i don't really want cap
limits at all. i want them to have good discernment and not go out of the
scope of their build." She confirmed it on 2026-09-28, when a review asked
for a loop brake back ("no brake"). The numbers she saw then: 296 agent
messages in a day and a half, no pair of sessions trading more than 8 in an
hour, and the old depth-5 brake would have held 53 of them, all ordinary
work. So don't add a brake back without asking her. What keeps agents in bounds is the rule they're given
(in `peermail.prompt`, the `peers.py` help, and the swarm helper's prompt):

- Message a peer only when it serves the build you were started for — your
  work collides with theirs, you're blocked on something they have, or
  you're handing work on.
- No chat, no acknowledgements, no repeats, no fanning out to sessions the
  news doesn't affect.
- Don't take on work outside your own brief because a peer asked; point it
  at the owner.

The chain depth (`hops`, and `peer_hops` on each session) is still recorded
— her message resets it — but nothing acts on it. The `held` status and "Let
it through" still work for anything the old brakes held. One size limit
stays: `peermail.TEXT_CAP` (8000 characters per message) — longer text goes
in a file and the message carries its path.

## Why the input stays open

Claude Code's `--input-format stream-json` accepts more messages while a turn
runs; `--replay-user-messages` echoes each one back when the agent reads it.
The turn closes its input at the final result only once every handed-in
message has been echoed — otherwise the agent answers the late one in the
same turn and emits another result. A 30-second backstop closes it anyway if
an echo never comes. `EXOCORTEX_TURN_STREAM_INPUT=0` turns all of this off:
turns go back to one prompt, and messages wait for turns to end.

## Not yet

- Coming up reminders and approval cues still use their own queue
  (`drain_followups`), so they aren't batched with mailbox messages.
- Sessions outside the Observatory (tmux, a plain terminal) can be read by
  `peers.py` only through the hourly `tool_calls` ingest, and can't receive.
