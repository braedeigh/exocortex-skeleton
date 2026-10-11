---
id: detached
name: Detached jobs
kind: script
order: 6
sources:
  - scripts/run_detached.py
links:
  - writes data.queue-files: Each job has a folder with its log and its state.
  - calls engine.delivery: When a job ends, one System message goes into the session's follow-up queue.
fingerprint: 7449b64fd7ad
written: 2026-10-02
---

A detached job is a long command that outlives the turn that started it. The script starts the command in its own process session and logs its output. When the command ends, a System message with the exit code and the log's tail wakes the session.

As a hook, the same script rewrites every background Bash call of a session into a detached job. A sweep each minute finds jobs whose watcher died, for example after a reboot, and tells their session.
