---
id: engine.questions
name: Questions for the owner
kind: feature
parent: engine
sources:
  - scripts/request_input.py
links:
  - writes data.index: Open questions are kept on the session's entry.
fingerprint: e31c1aac0304
written: 2026-10-28
---

A session that needs the owner files its questions with scripts/request_input.py. Every set says what the session is building and where it stands (--about, required), and a question with real alternatives offers 2–4 options, the recommended one first. When the work started from one of her journal cards, the session names it with --card, and her words are copied from the card verbatim and shown above the questions, so she meets her own reason for the work first; a card that isn't hers is refused and nothing is filed. The card then shows orange; the about line, the questions and their options show on the card and in the chat, where she taps an option or types her own answer, or takes every recommendation at once. Her next message answers them and takes them down.

Filing the same set again changes nothing; --add puts one more question on the open set, keeping its about line and her words. Filing also lists what the rest of the session's swarm is already asking, so a session doesn't ask a question a swarm-mate has open.

When the answer comes by another route, the session takes its own questions down with the --answered form. An agent's message never clears the questions.
