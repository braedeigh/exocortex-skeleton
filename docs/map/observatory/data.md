---
id: data
name: Session data
kind: data
order: 15
fingerprint: 
written: 2026-10-02
---

The Observatory keeps its state in two places. Files in the data folder hold the session index, the transcripts, and small queue files. Tables in the app database hold the mailbox, the swarms, the helpers' records, and the tool calls.

Code reaches the files through the store module and the tables through the SQL store.
