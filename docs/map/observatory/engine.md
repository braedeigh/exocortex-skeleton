---
id: engine
name: Session engine
kind: module
order: 2
sources:
  - routes/observatory.py
fingerprint: c0f5bbad9fea
written: 2026-10-04
---

The session engine is the server side of the Observatory. It is one large file of HTTP routes and the functions behind them. It makes sessions, starts turns, delivers messages, and closes sessions.

Each session is an entry in the session index and a transcript file on disk. Most changes to a session's state go through the engine. Agents reach it only through narrow doors, which are small scripts that call its public functions.
