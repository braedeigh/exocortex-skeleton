---
id: run-queue.dispatcher
name: Run dispatcher
kind: script
parent: run-queue
sources:
  - scripts/run_dispatcher.py
links:
  - reads data.queue-files: It reads the queue of waiting and running runs.
  - writes data.queue-files: It promotes one run, records its start, and prunes finished runs.
  - reads data.transcripts: A run is alive when its transcript changed lately, not because a flag says so.
  - calls spinoffs.runner: A queued session's first turn is posted by the spinoff runner.
fingerprint: f067bd481153
written: 2026-10-02
---

Cron runs the dispatcher every minute. It takes a lock, checks which runs are really alive, and reads the free memory. When there is room, it starts exactly one waiting run.

It never stops a run to make room. A run that hits a rate limit goes back into the queue, and the whole queue waits for a cooling period. Runs started from cron do not stop when the web service restarts.
