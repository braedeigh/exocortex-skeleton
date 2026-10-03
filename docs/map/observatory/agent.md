---
id: agent
name: Agent turn
kind: module
order: 4
links:
  - calls engine.gates: Claude Code runs the gate hooks before the tool calls they match.
  - calls engine.questions: The agent files questions for the owner with request_input.py.
  - calls engine.closing: The agent marks its own session done with session_done.py.
  - calls swarms.mail: The agent lists, reads and messages other sessions with peers.py.
  - calls sudo: The agent asks for a root command with sudo_request.py.
  - calls spinoffs.door: The agent offers or opens new sessions through the spinoff scripts.
  - calls detached: A long command runs as a detached job that wakes the session later.
  - calls helpers.watches: A helper sets a watch on a session with helper_watch.py.
  - calls helpers.context: A helper adds the owner's standing rules with helper_rule.py.
  - calls linear.feed: A helper or session reads the Linear news with the linear_feed script.
fingerprint: 
written: 2026-10-02
---

An agent turn is one run of the Claude Code command line, claude -p, for one reply. It is not code in this repo. The app starts it with the session's settings and resumes the same conversation on each turn. A helper's turn is the exception: it starts fresh each time.

The agent knows its own session from an environment variable. It acts on the app only through small scripts: to ask the owner, to finish, to message peers, and to start other sessions.
