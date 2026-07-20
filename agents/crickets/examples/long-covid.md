<!-- Origin: personal vault prompts/crickets/long-covid.md. Scrubbed modular
     copy — plug-in points marked PLUG-IN(...) -->
# Example cricket: **long-covid** (a worked example of a symptom-tracking cricket)

*Ships `off` in `roster` and lives in `examples/` rather than alongside the active
crickets, because its whole job is a personal health schema — the original author's
long-COVID symptom fields. It's kept as a complete, working example of the
"stage a daily reading against a fixed schema" pattern. To use it: copy this file to
`agents/crickets/<yourid>.md`, replace the schema below with the fields YOU track,
rename the `kind` if you like, add a matching commit handler in `routes/pending.py`
if one doesn't already exist for your fields, then add a roster row and flip it `on`.*

*The shared rules live in `_base.md` — read that first. This file only describes this
cricket's one job and one door.*

**Job:** from the day's journal, pull every tracked symptom signal mentioned and stage
a single `kind:"symptoms"` proposal for dashboard approval.

**Door:** stage into `data/pending_changes.json` with `kind:"symptoms"` (see `_base.md`
for the queue format). The commit handler is the dashboard's symptoms approval editor;
it POSTs the approved payload to `/api/symptoms` and overwrites the row for that date.

## PLUG-IN(SYMPTOMS): the schema — replace with the fields YOU track

This table is the entire personal part of this cricket. Everything else on this page
(the scoring approach, the "only what was mentioned" discipline, the payload shape) is
generic and worth keeping; this table is the one thing to rewrite.

The worked example below is the original author's long-COVID symptom set — 0-3
severity scales plus a yes/no flare flag:

| Field | What to look for | Values |
|---|---|---|
| `nose_congestion` | stuffy/congested nose, sinus pressure | 0 none → 3 bad |
| `brain_fog` | fog, can't think, word retrieval, confusion, haze | 0 none → 3 bad |
| `abdominal_pain` | stomach/gut pain, cramping, GI discomfort | 0 none → 3 bad |
| `hand_pain` | hand/joint pain, aching hands | 0 none → 3 bad |
| `headache` | headache, head pain | 0 none → 3 bad |
| `energy` | overall energy level | 0 crashed / 1 low / 2 okay / 3 great |
| `histamine_flare` | histamine reaction, flushing, hives, itching, flare | `"yes"` or `"no"` |
| `flare_trigger` | what was named as the trigger (only with a "yes" flare) | free text |

Swap in whatever you track — migraine days, mood, a chronic-condition flare scale, a
medication side-effect checklist, anything with a small fixed set of fields and a
consistent scoring convention.

## What to do

1. Read `tulku/Journal/Daily/<TARGET>.md`.
2. Find every signal actually named for a field in your schema.
3. Translate words to numbers (adapt this convention to your own fields):
   - Explicit: "none" → 0, "mild/slight/a little" → 1, "moderate/some" → 2,
     "bad/severe/really bad/awful" → 3
   - Energy tone: "crashed/PEM/couldn't get up/bedridden" → 0,
     "exhausted/wiped out/very tired" → 0–1, "tired/low energy" → 1,
     "okay/alright/not bad" → 2, "good/great/energized" → 3
4. Only include fields with actual signal — **never guess an unmentioned field.**
   If nothing was said about headache, leave `headache` out of the payload entirely.
5. If any symptoms were mentioned, stage exactly one object:

```json
{
  "id": "<8 random hex chars>",
  "kind": "symptoms",
  "summary": "<one line — quote or paraphrase, e.g. 'brain fog (bad) + low energy; no flare'>",
  "payload": {
    "date": "<TARGET>",
    "brain_fog": 3,
    "energy": 1,
    "histamine_flare": "no"
  },
  "created": "<TARGET> HH:MM"
}
```

   Append this to `data/pending_changes.json` → `pending` array. Create the file as
   `{"pending": []}` if it doesn't exist. Edit atomically (read → append → write back).

## Don'ts

- Only your schema's fields. Sleep quality, food, exercise are other crickets' jobs.
- Never include `flare_trigger` unless `histamine_flare` is `"yes"` (or the equivalent
  conditional field in your own schema).
- If nothing relevant is mentioned at all — do nothing. Silence is fine.
- Never invent or extrapolate values for fields that weren't addressed.
- One object per run (one proposal for the whole day — not one per field).
