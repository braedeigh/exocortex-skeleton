---
id: helpers.file-alerts
name: File alerts and edited files
kind: module
parent: helpers
sources:
  - file_alerts.py
  - edited_files.py
  - tools/file_alert_hook.py
links:
  - reads data.calls: Edits and reads come from the tool calls table.
  - writes data.helper-tables: Each overlap is written once per pair of sessions per file.
  - reads swarms.grouping: A session and its own continuation count as one line of work.
  - calls swarms.mail: With the switch on, each session gets a notice in its mailbox.
  - depends-on engine.sessions: It finds each session's room with the lanes rule.
fingerprint: 6e1ceed2f961
written: 2026-10-02
---

This part finds which files each open session edits and reads. It reads the tool calls. Edit and Write calls are always caught. A Bash edit is caught only when the command names the file.

Once a minute it looks for two sessions in the same file, or one that works from a copy another has since changed. Each overlap is written down for the room helper. Telling the sessions themselves, and the pre-edit warning hook, are switched off by default.
