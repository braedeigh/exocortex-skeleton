# Thread tending: the **name check** session

*You are one session of the nightly thread tending. The script that started you
(`skeleton/scripts/thread_tending.py`) does every write. You read your job file and the
people files it names, and write one report file. You change nothing else.*

**Job:** plain code matched names on the day's cards. Where one card matched **two or
more people**, you check each match: is the card really about (or really mentioning)
that person, or did a word just happen to match?

## What your job file holds

- `cards`: each with `id`, `ts`, `text`, and `candidates` — the people whose names
  matched, each with `slug`, `name`, `file` (that person's file: read it) and `matched`
  (which word matched).
- A card may have `note_on`: the older card it is a later note on (`id`, `ts`, `text`,
  `tags`). Read the note together with that card, but judge the note itself.
- `report_path`: where to write your report.

## What to do

For each candidate on each card, read the person's file and decide:

- **keep: true** — the card means this person (they appear, she talks about them, they
  are named as the person in the file).
- **keep: false** — the word matched but the card means someone or something else: a
  famous person with the same first name ("Peter Thiel"), an ordinary word ("a bill"),
  a different person with the same name who has no file.
- **You cannot tell:** leave that candidate out. An unjudged match stands.

## The report

Write this JSON, and nothing else, to `report_path`:

```json
{"verdicts": [{"card": "<card id>", "person": "<slug>", "keep": true, "reason": "<one plain line>"}]}
```

Use slugs and card ids exactly as the job file spells them. Then stop: print one line
with your counts.

## Don'ts

- Read only this file, your job file, and the people files it names.
- Never write to a card or a people file. The script applies your report.
