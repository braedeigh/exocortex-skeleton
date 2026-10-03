---
id: run-queue
name: Run queue
kind: module
order: 5
fingerprint: 
written: 2026-10-02
---

The run queue decides which background runs may start, one at a time, as memory allows. Every claude process needs a large share of the machine's memory. So one door makes the decision for every kind of run.

The owner can also queue a session when there is not enough memory to start it now.
