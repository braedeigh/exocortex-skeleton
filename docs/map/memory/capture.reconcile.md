---
id: capture.reconcile
name: Transcript safety net
kind: script
parent: capture
sources:
  - tools/stream/reconcile_transcripts.py
links:
  - calls capture.pool: A missed message becomes a card through the pool's own writer.
fingerprint: 1d600b7dbd33
written: 2026-10-04
---

A hook can die without telling anyone, and then the messages typed after it are not captured. Claude Code still writes every session to its own transcript file.

This script runs on a timer and reads those transcripts. It makes a card for each message of the owner's that the pool does not have. It keeps a list of what it has checked, so it never makes the same card twice.
