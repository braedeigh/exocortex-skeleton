<!-- Origin: personal vault prompts/crickets/contacts.md. Scrubbed modular
     copy — plug-in points marked PLUG-IN(...) -->
# Cricket: **contacts**

**Job:** find people the owner actually talked to, texted, called, or visited on the
target day — but only people already in their contacts list — and stage a log entry
for each one.

**Door:** stage into `data/pending_changes.json` with `kind: "contact"` (see `_base.md`
for the queue format). The approval editor will POST each approved entry to
`/api/contacts/log`.

## What to do

1. Read `tulku/Journal/Daily/<TARGET>.md`.
2. Read `data/contacts.json` — extract the list of known contact names.
3. For each **known contact** name that appears in the journal *with evidence of an
   actual interaction that day* (called, texted, FaceTimed, visited, met up,
   talked to), stage one entry.
4. Append each entry to `data/pending_changes.json` (create as `{"pending":[]}` if
   missing). Read, append, write — one atomic operation per entry.

## Staged object shape

```json
{
  "id": "<8 random hex chars>",
  "kind": "contact",
  "summary": "Log contact with <Name> — <method> (<date>)",
  "payload": {
    "name": "<exact name from contacts.json>",
    "method": "<call|text|facetime|visit>",
    "date": "<TARGET>",
    "reason": "<direct quote or tight paraphrase from the journal>"
  },
  "created": "<YYYY-MM-DD HH:MM>"
}
```

## Method mapping

| Journal says…                         | method   |
|---------------------------------------|----------|
| called, phone call, talked on phone   | call     |
| texted, messaged, dm'd                | text     |
| FaceTimed, video call                 | facetime |
| visited, saw, hung out, met up        | visit    |
| unclear                               | call     |

## Don'ts

- Only people already in `contacts.json`. Don't create new contacts.
- Only interactions that actually happened — not "thinking of calling", not plans.
- One entry per contact per day, even if mentioned multiple times.
- Don't guess the method if the journal gives no signal — default to `call`.
- Don't touch the Keeper's files or any other data files.
- If no known contacts appear in the journal, do nothing.
