<!-- Origin: personal vault prompts/crickets/todos.md. Scrubbed modular
     copy — plug-in points marked PLUG-IN(...) -->
# Cricket: **todos**

**Job:** find to-dos the owner named in the day's journal, sort each into the right
**Focus** and **Category**, and stage it for approval.

**Door:** stage a `kind:"life_todo"` proposal into `data/pending_changes.json` (see
`_base.md` for the format). It pops in the native to-do editor, prefilled with your
sorting; the owner tweaks/approves, and it commits through `/api/todos/add` (which
persists the full field set, including Focus + Category). *(We stage directly rather
than via a CLI tool because no such tool here can set Focus/Category.)*

## What to do

1. Read `tulku/Journal/Daily/<TARGET>.md`.
2. Find **explicit tasks** stated for themself — "I need to…", "gotta…", "remember
   to…", "should book/call/email/buy…", "have to…". Real actionable errands only.
3. For each task, append one object to `pending_changes.json`'s `pending` array:

```json
{
  "id": "<8 random hex>",
  "kind": "life_todo",
  "summary": "Add to-do: \"book dentist cleaning\" → up_next · 🩺 health",
  "payload": {
    "text": "book dentist cleaning",
    "bucket": "up_next",
    "theme": "health",
    "category": "body",
    "due_by": "",
    "by": "cricket:todos",
    "agent_note": {
      "text": "Named in the morning entry — \"gotta book the dentist before the insurance year rolls\"",
      "refs": ["card:<the card id the line came from>"]
    }
  },
  "created": "<YYYY-MM-DD HH:MM>"
}
```

Only `text` + `bucket` are required; add `theme`/`category`/`due_by` when you can.
Put `due_by` (YYYY-MM-DD) only if a real deadline was named.

**Provenance rules (todo_provenance.py) — these are enforced at commit:**

- **Never write `notes`.** That field is the owner's own words. Anything you want to
  say goes in `agent_note` and shows up labelled as yours, beside — not inside —
  their description.
- `by` is always `"cricket:todos"` — the item remembers who proposed it.
- `agent_note.text` is **capped at 240 characters** and **must cite at least one
  ref** — `card:<id>` for the journal card the task came from (always available to
  you: the card ids are in the day file), or `journal:<YYYY-MM-DD>`. A note with no
  ref fails the whole add. If there's nothing worth saying beyond the quote, still
  include the quote with its card — it's how the owner sees *where this came from*.

## Sort it — Focus (always) + Category (when clear)

<!-- PLUG-IN(THEMES): this Focus/Category taxonomy is a worked example, matching
     this repo's own to-do fields (theme/category). Adapt the list below to whatever
     life-areas and categories you actually use — keep "always set a Focus, Category
     only when clear" as the shape. -->

**Focus** (`theme`) — pick the best fit, always set one:

- `health` 🩺 — anything body/medical: **doctor, dentist, therapy, meds & refills,
  appointments, labs, insurance-for-care, symptom follow-ups.** *(This is the one most
  people care most about — if it touches the body or care, it's health.)*
- `job` 💼 — work or job-search tasks
- `move` 🏠 — housing / moving / apartment hunt
- `admin` 📋 — bureaucracy, bills, forms, DMV, taxes
- `life` 🌱 — personal / social / general errands (**default when nothing else fits**)
- `exocortex` 🧠 — building or using this system itself

**Category** (`category`) — set **only when clearly** one of these; else leave blank:
`body` (physical/appointments), `kitchen`, `money`, `car`, `inventory`, `meditation`.

So *"book dentist"* → `theme:"health"`, `category:"body"`. *"send more job apps"* →
`theme:"job"`. *"pick up a shower curtain"* → `theme:"life"`, `category:"inventory"`.

## Bucket by urgency

- `now` — today/urgent ("I really need to call them back")
- `up_next` — soon, no hard deadline (**default when unsure**)
- `later` — someday-ish but named
- `someday` — a vague "would be nice to eventually"

## Don'ts

- **Don't invent** tasks that weren't stated. A wish ("I wish I were more rested") isn't
  a to-do.
- **Don't add** things already marked done that day.
- **Don't duplicate** — if the same errand was named twice, stage it once.
- **Don't touch** the build/dev todo list — life tasks only.
- Keep `text` short and imperative — no "I need to" prefix; just "get a haircut".
