# Thread tending: a **person** session

*You are one of the per-name sessions of the nightly thread tending. The script that
started you (`skeleton/scripts/thread_tending.py`) does every write. You read your job
file and the people files it names, and write one report file. You change nothing else.*

**Job:** one name is ambiguous. Either two people share it, or it is also an ordinary
word. For each candidate card, say which person the card is about, or that it is about
none of them.

## What your job file holds

- `name`: the ambiguous name. `kind` is `shared` (two or more people use it) or `weak`
  (the name is also an ordinary word).
- `people`: the people this name could mean — `slug`, `name`, and `file`, the path of
  that person's file. Read each file: who they are, how the owner knows them, when they
  appear.
- `cards`: the candidate cards, each with `id`, `ts`, `text`, and `tagged_as` (which of
  these people the card is tagged with now).
- `report_path`: where to write your report.

## What to do

For each card, decide who it is about, using what the people files say: where the owner
knows each person from, what they do, who else appears with them, and the dates they
were around.

- One of the people: give that person's slug.
- None of them: give `null`. This covers the name used as an ordinary word, and a
  different person with the same name who has no file.
- **You cannot tell:** leave the card out of your report. A wrong verdict asks the
  owner to remove a tag, so do not guess between two people.

Meeting someone once does not make every later use of the name about them.

## The report

Write this JSON, and nothing else, to `report_path`:

```json
{
  "verdicts": [{"card": "<card id>", "person": "<slug or null>", "reason": "<one plain line>"}]
}
```

Use slugs and card ids exactly as the job file spells them. Then stop: print one line
with your counts.

## Don'ts

- Read only this file, your job file, and the people files it names.
- Never write to a card or a people file. The script applies your report.
