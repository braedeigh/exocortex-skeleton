---
id: spinoffs.door
name: Spinoff door
kind: module
parent: spinoffs
sources:
  - routes/spinoff.py
  - scripts/spinoff_open.py
  - scripts/spinoff_offer.py
  - scripts/spinoff_brief.py
  - briefstore.py
  - scripts/import_spinoff_briefs.py
  - frontend/src/features/observatory/SessionBriefPage.tsx
  - frontend/src/features/observatory/SessionBriefPage.module.css
links:
  - depends-on engine.sessions: The room's profile gives the new session its folder and gates.
  - writes data.index: It mints the new session with its parent and how it was born.
  - calls spinoffs.runner: It starts the runner that posts the kickoff.
  - calls worktrees.copies: The steward mode stands a session on an existing branch in its own worktree.
fingerprint: 8182b8df0331
written: 2026-10-02
---

A session saves a brief with spinoff_brief.py, which takes the text on standard input and keeps it as a row in the database. It then calls spinoff_open.py, or it offers the spinoff with spinoff_offer.py. An offer puts a Go button in the owner's chat. Go opens each spinoff and takes the owner to the new session.

The door mints the session, records its parent, and stages the brief as its first message. The brief's listed files go into the session's hidden instructions, which are kept in the database beside the brief and handed to every turn. Handoffs are kept there too. The session's brief page shows all three. Briefs written before October 2026 were folders of files; an import script brought them in.
