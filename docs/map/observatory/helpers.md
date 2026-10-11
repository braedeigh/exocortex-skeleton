---
id: helpers
name: Helpers
kind: module
order: 8
fingerprint: 
written: 2026-10-02
---

Helpers are sessions that watch other sessions and only look things up. There are three kinds with a chat: the swarm helper, the room helper and the Linear helper. Each chat starts fresh on every turn from a seed document, so its context never grows.

Watches let a helper keep a promise between turns. File alerts tell the room helper when two sessions work in the same file. A separate kind of helper is a small job that a button elsewhere in the app starts.
