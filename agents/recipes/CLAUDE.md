<!-- Origin: personal vault recipes/CLAUDE.md. Scrubbed modular copy —
     plug-in points marked PLUG-IN(...) -->
# Recipes Folder

This folder holds recipe submissions (URLs + photos) uploaded from the Kitchen tab's "Recipes" section. When you (Claude Code) are opened in this folder, your job is to **parse unparsed recipe submissions into structured JSON**.

<!-- PLUG-IN(OWNER_NAME): the person this workspace serves — appears below in
     "the frontend writes it after <OWNER_NAME> reviews...". -->

## Subfolder structure

- `urls/` — URL submissions land here as `<slug>.url.json` files like `{"url": "https://...", "submitted_at": "..."}`.
- `images/` — uploaded photos of printed recipes (cookbook pages, recipe cards, etc).
- `parsed/` — your output: structured recipe JSON. One file per submission, sibling to (or named after) the original.

## Your job

For each item in `urls/` or `images/` that DOESN'T already have a corresponding `parsed/<basename>.parsed.json`, produce a structured recipe and write it to `parsed/`.

### URL submissions

For `urls/<slug>.url.json`:
1. Read the file to get the URL.
2. Use the WebFetch tool to retrieve the page.
3. Extract structured data per the schema below.
4. Write to `parsed/<slug>.parsed.json`.

### Image submissions

For `images/<filename>`:
1. Read the image with the Read tool (it supports JPG/PNG/HEIC).
2. Convert HEIC → JPEG if needed: `heif-convert <file>.HEIC <file>.jpg` (apt: `libheif-examples`).
3. Extract structured data per the schema below.
4. Write to `parsed/<filename>.parsed.json` (use the full original filename including extension as the basename, then add `.parsed.json`).

## Output schema

```json
{
  "name": "Lemon ricotta pancakes",
  "source_url": "https://...",            // null if from image
  "source_image": "recipes/images/foo.jpg",  // null if from URL
  "servings": 4,
  "prep_min": 10,
  "cook_min": 15,
  "ingredients": [
    {"item": "ricotta", "qty": "1 cup", "category": "dairy", "note": ""},
    {"item": "eggs", "qty": "2", "category": "protein", "note": "separated"},
    {"item": "lemon zest", "qty": "1 tsp", "category": "produce", "note": ""}
  ],
  "instructions": [
    "Whisk eggs and ricotta in a large bowl.",
    "Sift in flour and baking powder...",
    "Cook on a buttered griddle 2 min per side."
  ],
  "tags": ["breakfast", "brunch"],
  "notes": ""
}
```

### Field guidance

- **name**: a clean human title. Strip site-name suffixes ("— Serious Eats", "| NYT Cooking"). Title-case.
- **source_url** / **source_image**: exactly one is non-null per recipe.
- **servings, prep_min, cook_min**: integers if you can find them. `null` if not stated.
- **ingredients[].category**: one of `produce`, `vegetables`, `fruit`, `protein`, `dairy`, `grains`, `drinks`, `snacks`, `dessert`, `pharmacy`, `supplements`, `household`, `other`. Best guess based on the canonical kitchen categories. Default `other` if unclear.
- **ingredients[].qty**: keep as written ("1 cup", "2 tbsp", "1/2", "to taste"). Don't normalize.
- **ingredients[].note**: free-form qualifier ("separated", "room temp", "optional"). Empty string if none.
- **instructions**: one array entry per step. Strip step numbers ("1. ", "Step 1:"). Combine multi-sentence steps into a single string per step.
- **tags**: 1-3 short tags describing the dish (meal type, cuisine, dietary). e.g. `["breakfast", "vegetarian"]`. Lowercase, single words preferred.
- **notes**: any caveats or chef tips that don't fit elsewhere. Empty string if none.

## What NOT to do

- **DO NOT** modify `data/recipes.json` — that's the human-approved canonical store. The frontend writes it after <OWNER_NAME> reviews your parsed output.
- **DO NOT** delete the original `urls/<slug>.url.json` or `images/<filename>` — leave them as reference.
- **DO NOT** invent fields not in the schema.
- If a page is paywalled or unreadable, write a `parsed/<basename>.parsed.json` with `{"parse_error": "<reason>"}` instead so the frontend can surface the failure.

## On Startup

1. List files in `urls/` and `images/`.
2. For each, check if `parsed/<basename>.parsed.json` exists. If not, it's new — parse it.
3. After parsing each, summarize for <OWNER_NAME>: `Parsed: <name> (N ingredients, M steps). Open Kitchen → Recipes to review.`

## When done

After processing all pending submissions, summarize for <OWNER_NAME>:
- N recipes parsed
- Any that failed (with reason)
- A reminder to open the Kitchen tab's Recipes section to review and approve.
