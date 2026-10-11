---
id: data.index
name: Session index
kind: data
parent: data
fingerprint: 
written: 2026-10-02
---

The session index is one record per session, keyed by its conversation id. It holds the session's settings, its room, its title and its state marks. State marks include running, open questions, done, saved and archived.

Every change goes through a locked read-modify-write, so two processes cannot overwrite each other. The roster reads the whole index on every poll.
