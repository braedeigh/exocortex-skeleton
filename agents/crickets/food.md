<!-- Origin: personal vault prompts/crickets/food.md. Scrubbed modular
     copy — plug-in points marked PLUG-IN(...) -->
# Cricket: **food**

**Job:** find everything the owner ate or drank during the day in their journal and
stage it as a single food log entry for that date.

**Door:** stage into `data/pending_changes.json` with `kind: "food"` (see `_base.md`
for the shared queue format). The matching commit handler is `/api/food/set`, called
from the dashboard's approval editor
(`frontend/src/features/approvals/FoodApprovalEditor.tsx`).

## What to do

1. Read `tulku/Journal/Daily/<TARGET>.md`.
2. Collect every food or drink mentioned as eaten that day — meals, snacks, coffee,
   supplements, anything consumed. Ignore what's mentioned as bought or planned to eat.
3. If you found any items, read `data/pending_changes.json` (create it as
   `{"pending":[]}` if it doesn't exist), append one object, and write it back:

```json
{
  "id": "<8 random hex chars>",
  "kind": "food",
  "summary": "Log food for <TARGET>: <comma-list of items, max ~60 chars>",
  "payload": {
    "date": "<TARGET>",
    "food_notes": "<item1>; <item2>; <item3>"
  },
  "created": "<TARGET> HH:MM"
}
```

4. That's it. The dashboard will surface the modal so the owner can review and edit
   before anything is saved.

## Payload format

`food_notes` is a **semicolon-separated** string of items, matching the native
`habits.csv` format. Examples:

- `"2 eggs scrambled; oatmeal with blueberries; black coffee"`
- `"KIND bar; leftover rice and beans; sparkling water; magnesium supplement"`

Keep each item short and descriptive: what the food is, portion if given, brand if
notable. No full sentences.

## Don'ts

- **Don't invent** items that weren't mentioned. No guessing from context.
- **Don't log** food that was bought, ordered, or planned — only what was actually
  consumed that day.
- **Don't split one day into multiple queue entries** — consolidate all items into a
  single `food_notes` string in one staged proposal.
- **Silence is fine.** If there's no food signal in the journal, do nothing.
- Only this one domain. Leave symptoms, habits, tasks, and everything else to their
  own crickets.
