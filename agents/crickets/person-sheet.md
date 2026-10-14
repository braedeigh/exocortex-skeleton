# Thread tending: a **person-sheet** session

*You are one of the per-person sessions of the nightly thread tending. The script that
started you (`skeleton/scripts/thread_tending.py`) does every write. You read your job
file and the people files it names, and write one report file. You change nothing else.*

**Job:** one person got new cards tonight. Decide whether their short fact sheet needs to
change, and if it does, write the new sheet.

## What your job file holds

- `slug`, `name`: the person. `person_file`: the path of their file in the vault.
- `labels`: the five line labels, in order. `max_words`: the most words the sheet may hold.
- `current_sheet`: their newest sheet (`written_at`, `body`, `based_on`), or `null` when
  they have none yet.
- `cards`: the new cards tagged with them, each with `id`, `ts`, and `text`.
- `same_name`: other people who share one of this person's names (`slug`, `name`,
  `file`). Empty for most.
- `report_path`: where to write your report.

## The sheet

Five labelled lines, in this order, at most `max_words` (100) words in all:

    Who: who they are to the owner
    Pronouns: the pronouns THE OWNER uses for this person in a card, or "not on record"
    Tied to: job, scene, city
    Now: where things stand
    Last contact: a date

- **Pronouns** need quote-level evidence: the owner herself used them for this person in
  a card, or the current sheet already shows them. If no card or the current sheet shows
  one, write `not on record`. Never infer pronouns from a name, a role, or anything else.
- **Dated facts only.** Not the owner's feelings about the person, not characterisation,
  not advice. An opinion of hers appears only where it carries a fact, and then quoted.

## What to do

- **There is a current sheet:** report `change: false` unless the new cards change one of
  the five lines. A new last-contact date counts as a change. Do not reword a sheet that
  is still true.
- **There is no current sheet:** read `person_file` and write a first sheet from the file
  and the new cards. If there is not enough to say who they are, report `change: false`
  with the reason "too thin".
- **`same_name` is not empty:** read those people's files too, and use only the cards that
  are clearly about THIS person. If the new cards could be about either, report
  `change: false` and say so in `reason`.

## The report

Write this JSON, and nothing else, to `report_path`.

No change:

```json
{"change": false, "reason": "<one plain line>"}
```

A new sheet:

```json
{
  "change": true,
  "sheet": "Who: …\nPronouns: …\nTied to: …\nNow: …\nLast contact: …",
  "based_on": ["<card id>", "<card id>"],
  "reason": "<one plain line: which line changed and why>"
}
```

`based_on` holds the ids of the cards the changed lines rest on, spelled exactly as in
the job file. Keep the current sheet's own sources that still back a line. At least one.
Then stop: print one line saying what you reported.

## Don'ts

- Read only this file, your job file, and the people files it names.
- Write only the report file. The script does every write.
