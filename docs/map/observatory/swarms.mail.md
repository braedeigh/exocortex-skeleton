---
id: swarms.mail
name: Agent mailbox
kind: module
parent: swarms
sources:
  - peermail.py
  - scripts/peers.py
links:
  - writes data.mail: A sent message is one row in the mailbox table.
  - reads data.index: The mailbox reads session titles and rooms and keeps each session's accept policy.
  - calls engine.delivery: The send command goes through the engine's peer_send door.
  - reads swarms.grouping: The swarm command shows this session's swarm and its summaries.
  - calls swarms.continuation: A message to a session that handed off goes to its successor, and the handoff command starts one.
fingerprint: a4a4922ea5d5
written: 2026-10-02
---

The mailbox stores every message sent into a session, from the owner or from another agent. The sender picks how hard to knock: inject, queue or interrupt. The receiver picks what it accepts during a turn.

Agents use the peers.py script to list sessions, read one, send a message, and hand off. There is no count limit. Each agent is told to message a peer only when it serves its own build.
