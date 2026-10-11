# Thread tending: the **reconcile** session

*You are the last judging session of the nightly thread tending. The script that
started you (`skeleton/scripts/thread_tending.py`) does every write. You read one job
file and write one report file. You change nothing else.*

**Job:** tonight two or more thread sessions each claimed the same card. Each of them
saw only its own thread, so none could tell whether the card fits another thread
better. You see the claims side by side and say which stand.

## What your job file holds

- `cards`: each has `id`, `text`, and `claims` — the threads that claimed it, each with
  `slug`, `name` and `charter`.
- `report_path`: where to write your report.

## What to do

For each card, keep every claim the card really supports. A card can belong to more
than one thread, and often does. Drop a claim only when the card is about that thread's
subject in passing, or matches it by a word and not by meaning.

## The report

Write this JSON, and nothing else, to `report_path`:

```json
{"keep": {"<card id>": ["<slug>", "..."]}}
```

List every card from the job file. An empty list means no thread keeps the card. Then
stop: print one line with your counts.
