---
id: engine.delivery
name: Follow-ups and mailbox delivery
kind: feature
parent: engine
links:
  - reads data.mail: Delivery claims the waiting messages for a session.
  - writes data.mail: A message is marked handed in, read, or put back.
  - writes data.transcripts: The follow-up queue is a file per session, and delivered messages are written into the transcript.
  - calls engine.turns: A waiting message or follow-up starts a turn through begin_turn.
  - calls swarms.continuation: At the end of a turn a Coding session past its cap is asked for a handoff.
  - calls swarms.helper: At the end of a member's turn its swarm helper is nudged.
  - calls helpers.chat: At the end of a helper's turn its card is put back after a silent wake-up.
  - depends-on swarms.mail: The mailbox rules and labels come from the mailbox module.
fingerprint: 
written: 2026-10-02
---

This part brings messages to a session. The follow-up queue holds System messages that the app starts as turns when the session is free, for example a finished job or an approval. The mailbox holds messages from the owner and from other agents.

During a turn, a companion thread hands new messages to the agent between its steps. After a turn, after_turn runs the end-of-turn jobs, and then the queued follow-ups and the waiting mail start the next turn. Mail that waits is sent as one turn, with each message labelled by its sender.
