---
id: run-queue.window
name: Queue routes and memory meter
kind: feature
parent: run-queue
sources:
  - routes/run_queue.py
  - frontend/src/features/runqueue/
links:
  - depends-on run-queue.dispatcher: The queue's shape and memory numbers come from the dispatcher.
  - writes data.queue-files: Enqueue adds a run and keeps its kickoff text in a file.
fingerprint: 3f7e846facb9
written: 2026-10-02
---

These routes are the app's window onto the queue. They report the memory headroom, list the queue, and add one of the owner's sessions to it. They never start a run themselves.

The frontend part draws a memory meter. When a send is refused for low memory, it offers to queue the turn.
