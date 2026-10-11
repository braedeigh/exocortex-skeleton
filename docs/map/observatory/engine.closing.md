---
id: engine.closing
name: Done, idle and closing
kind: feature
parent: engine
sources:
  - scripts/session_done.py
links:
  - writes data.index: Done, keep open, saved and archived are marks on the session's entry.
  - reads data.queue-files: A session cannot say it is done while a detached job of its own runs.
  - calls engine.delivery: The idle check is sent to a quiet session as a System message.
  - calls spinoffs.door: Closing a spinoff moves its brief to the archive.
  - calls worktrees.copies: Closing a worktree session removes its worktree after its turn is gone.
fingerprint: 7728effb8a92
written: 2026-10-02
---

A session that finished its job calls scripts/session_done.py. It is refused when a question, an approval or a detached job still waits. The card then counts down two hours with a Keep open button, and the minute tick closes it.

A session that is quiet for a day gets one idle check message. It asks the session to close itself or to say what is left. The owner can also close a session, keep it open, or save it for later.
