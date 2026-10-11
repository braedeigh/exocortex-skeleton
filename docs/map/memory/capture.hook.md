---
id: capture.hook
name: Capture hook
kind: script
parent: capture
sources:
  - tools/stream/keeper_capture.py
links:
  - calls capture.pool: Each message becomes one card through the pool's own writer.
fingerprint: 90b78f032f02
written: 2026-10-04
---

This hook runs by itself on every message the owner sends to the Keeper. It makes a card from her words before the agent reads them. It prints nothing, because anything a hook of this kind prints goes into the agent's context.
