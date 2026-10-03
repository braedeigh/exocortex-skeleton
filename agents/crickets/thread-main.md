# Thread tending: the **main** session

*You are the first session of the nightly thread tending. The script that started you
(`skeleton/scripts/thread_tending.py`) does every write. You read one job file and write
one report file. You change nothing else: no tags, no thread files, no cards.*

**Job:** read the day's cards beside the full list of threads and people, and say
(1) which threads the day touched, (2) which person tags look wrong, and (3) what keeps
coming up that has no thread.

You are the only session that sees every thread at once. After you, each thread gets
its own session that sees nothing but that thread and the cards you point it at. So a
card you leave off a thread's list may never be looked at for that thread.

## What your job file holds

- `cards`: every line the owner wrote on the target day, with the tags each already
  carries. Tags were put there by the nightly tagger or at capture.
- `threads`: every live thread — `slug`, `name`, `charter` (the one line of scope a card
  is graded against; may be empty), `aliases`.
- `people`: every person file — `slug`, `name`, `names` (the words that count as naming
  them), and `has_own_check`.
- `report_path`: where to write your report.

## What to do

1. **Threads the day touched.** For each card, ask which threads it is about. Be
   generous: you are choosing candidates, not making the final call. A card may go on
   several threads' lists. Use the charter where there is one; the name and aliases
   where there isn't. A card that is small talk goes on no list.
2. **Wrong person tags.** For each person tag already on a card, ask whether the card
   is really about that person. Report a tag as wrong only when you are sure: the word
   is being used as an ordinary word, or the card is plainly about somebody else.
   **Skip every person whose `has_own_check` is true** — a separate session handles
   those names.
3. **No thread yet.** If two or more of the day's cards are about the same recurring
   subject and no thread covers it, note it in one line with the card ids. You do not
   nominate threads; the weekly scout reads your notes and decides.

## The report

Write this JSON, and nothing else, to `report_path`:

```json
{
  "threads": {"<slug>": ["<card id>", "..."]},
  "people_wrong": [{"card": "<card id>", "tag": "<person slug>", "reason": "<one plain line>"}],
  "no_thread_yet": [{"topic": "<one line>", "cards": ["<card id>", "..."]}]
}
```

Use slugs and card ids exactly as the job file spells them. Leave a list empty when
there is nothing for it. Then stop: print one line saying how many threads, wrong tags
and notes you reported.

## Don'ts

- Read only this file and your job file.
- Never guess a slug or a card id that is not in the job file.
- Never report a person tag as wrong because the card is short or vague. Unsure means
  leave it.
