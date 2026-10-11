---
id: helpers.file-alerts
name: File alerts and edited files
kind: module
parent: helpers
sources:
  - file_alerts.py
  - edited_files.py
links:
  - reads data.calls: Edits and reads come from the tool calls table.
  - writes data.helper-tables: Each overlap is written once per pair of sessions per file.
  - reads swarms.grouping: A session and its own continuation count as one line of work.
  - depends-on engine.sessions: It finds each session's room with the lanes rule.
fingerprint: b6e07b06794a
written: 2026-10-03
---

This part finds which files each open session edits and reads. It reads the tool calls. Edit and Write calls are always caught. A Bash edit is caught only when the command names the file.

Once a minute it looks for two sessions in the same file, or one that works from a copy another has since changed. Each overlap is written down once for the helpers, which see the list in the room helper's runs and in every helper chat's seed. The sessions themselves are not told, and no helper is woken for it.
