---
id: engine.turns
name: Starting and running a turn
kind: feature
parent: engine
links:
  - calls turn-host: Each turn is handed to the turn host in a process of its own.
  - hosts agent: When the turn host cannot start, the turn runs in the web worker instead.
  - writes data.transcripts: The turn loop writes every event into the transcript.
  - writes data.index: A turn marks the session running and records its processes.
  - writes data.calls: The turn loop folds tool calls and model calls into the database every few seconds.
  - depends-on engine.gates: Each turn gets the guard, gate and hook settings for its session.
  - depends-on swarms.mail: Each turn's system prompt tells the agent about the other agents.
  - calls helpers.chat: A helper's turn gets a fresh seed document before it starts.
  - calls run-queue.window: A turn refused for low memory carries the headroom so it can be queued.
fingerprint: 
written: 2026-10-02
---

A turn is one reply from the agent. This part starts it: it builds the claude command, writes a job file, and starts the turn host. The function begin_turn is the one door for every turn, from the send route, the follow-up queue, the mailbox and the scripts.

The same part holds the turn loop. The loop reads the agent's output line by line, writes the transcript, and notes each model call and its context size. It also stops a turn on request and marks a turn dead when its process is gone. A turn is refused when memory is low or when its worktree is gone.
