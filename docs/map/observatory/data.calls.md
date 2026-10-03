---
id: data.calls
name: Tool and model calls
kind: data
parent: data
fingerprint: 
written: 2026-10-02
---

The tool_calls table holds every tool call a session made. The model_calls table holds every model call with its tokens and context size. A running turn folds its calls in every few seconds. Many parts read these tables to see what a session really did.
