---
id: data.transcripts
name: Transcripts and sidecars
kind: data
parent: data
fingerprint: 
written: 2026-10-02
---

Each session has a transcript file with one JSON line per event. The app writes it, and it is the record of the conversation. Claude Code's own files are not the record.

Small files sit beside the transcripts. The live sidecar holds token deltas during a turn. Others hold the turn's job file, the follow-up queue, approvals, and a helper's seed and what it has seen.
