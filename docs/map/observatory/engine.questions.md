---
id: engine.questions
name: Questions for the owner
kind: feature
parent: engine
sources:
  - scripts/request_input.py
links:
  - writes data.index: Open questions are kept on the session's entry.
fingerprint: db01f0b9d7b1
written: 2026-10-02
---

A session that needs the owner files its questions with scripts/request_input.py. The card then shows orange, and the questions show on the card and in the chat. The owner's next message answers them and takes them down.

When the answer comes by another route, the session takes its own questions down with the --answered form. An agent's message never clears the questions.
