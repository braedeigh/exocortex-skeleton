---
id: helpers.jobs
name: Button helpers
kind: feature
parent: helpers
sources:
  - routes/helpers.py
  - frontend/src/features/observatory/HelpersDoor.tsx
  - frontend/src/features/observatory/HelpersPage.tsx
  - frontend/src/features/observatory/HelpersPage.module.css
links:
  - calls spinoffs.door: Each job opens a Personal-room session through the spinoff door.
  - reads data.index: The history lists every helper session, archived ones too.
  - depends-on engine.turns: A row reads running and cost the same way a roster card does.
  - depends-on page.api: The history page reads the helper runs through the shared API file.
fingerprint: c2eaa5c819e9
written: 2026-10-02
---

Some buttons elsewhere in the app hand a small job to Claude, for example a triage or a parse. The one door for them opens a session marked as a helper and writes a brief for the job.

The Helpers door at the bottom of the roster opens a history of these runs. Each row shows the kind of job, its time, its state and its cost. A tap opens the session.
