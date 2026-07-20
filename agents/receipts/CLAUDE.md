<!-- Origin: personal vault receipts/CLAUDE.md. Scrubbed modular copy —
     plug-in points marked PLUG-IN(...) -->
# Receipts Folder

This folder holds receipt photos uploaded from the dashboard. When you
(Claude Code) are opened in this folder, your job is to **parse unparsed
receipts into structured line items**.

<!-- PLUG-IN(OWNER_NAME): the person this workspace serves — appears in the
     "summarize for" lines below. Fill in, or just read "the owner." -->

## Subfolder structure

- `grocery/` — receipts uploaded from the Kitchen tab's "📷 Scan receipt" button. **Your job is JUST to transcribe** — read the photo, output a sibling `.parsed.json` file with raw line items. The dashboard's rules-based parser handles categorization downstream. Do NOT touch `data/grocery_trips.json` or `data/kitchen.json` from here.
- (root of `receipts/`) — receipts uploaded from the Money tab, linked to specific expenses. Map lives in `../data/expense_receipts.json`. **Your job is JUST to transcribe here too** — write a sibling `.parsed.json` staging file next to the photo. The dashboard's `/api/expense-receipts/parsed/import` route applies it (writes the trip + flips `parsed: true`) through the app's data layer. **Never write `../data/expense_receipts.json` or `../data/grocery_trips.json` directly from here — see "Why never write the data files directly" below.**

## Why never write the data files directly

`expense_receipts.json` and `grocery_trips.json` are both SQL-backed now (SQLite is the database of record; the JSON files in `data/` are one-way export MIRRORS the app regenerates on every write — it never reads them back). A direct write to either file from an agent session:

1. Is **invisible** — the running app reads SQLite, not the file, so nothing you write there ever shows up.
2. Gets **silently clobbered** — the next time anything writes that collection through the app (another receipt upload, another import), the mirror export overwrites your file with whatever's in the database, and your edit is gone with no error, no warning, nothing in the logs.

This bit us for real: an older version of this doc told you to write `../data/grocery_trips.json` and `../data/expense_receipts.json` directly for Money-tab receipts. Don't do that anymore, here or anywhere else. If a future task ever seems to call for writing a `data/*.json` file directly, stop and flag it instead — there's almost certainly a staging-file + import-route path (like this one) that should exist instead.

## Grocery receipt workflow (subfolder `grocery/`)

For each new file in `grocery/` that doesn't have a sibling `<file>.parsed.json`:

1. **Read the photo** following `receipt_scanner.md` (in this same folder) — crop, OCR, extract every line item with name + price + quantity.
2. **Write a sibling JSON file** at `grocery/<original_filename>.parsed.json` with this shape:

```json
{
  "store": "HEB",
  "date": "2026-05-03",
  "subtotal": 42.50,
  "tax": 3.51,
  "total": 46.01,
  "saved": 1.06,
  "items_count": 12,
  "line_items": [
    {"name": "GAL ORG WHOLE MILK", "qty": 1, "price": 4.50, "unit_price": null},
    {"name": "BROCCOLI CROWNS", "qty": 1, "price": 1.05, "unit_price": 0.97}
  ]
}
```

3. **DO NOT** categorize items, **DO NOT** map to kitchen catalog, **DO NOT** modify any other JSON files. The dashboard's rules-based parser does that with human-in-the-loop review.
4. **DO NOT** delete the original photo. Keep it for reference.
5. After writing the parsed JSON, summarize for <OWNER_NAME>: "Parsed N items from <store>, total $<x>, saved to <file>.parsed.json. Open the Kitchen tab to import."

## On Startup

1. Read the canonical parser instructions: `receipt_scanner.md` (in this same folder) — guidance on cropping, reading multi-line items, output verification.
2. List `grocery/*.{jpg,png,heic,...}` files that DON'T have a sibling `.parsed.json` — those are the new uploads waiting to be transcribed.
3. For Money-tab receipts (root of `receipts/`): read `../data/expense_receipts.json` (read-only — this is a mirror of the database, safe to read, never to write) — map of `expense_id → receipt filename`. Find entries where `parsed: false` and the photo doesn't yet have a sibling `.parsed.json`. Those are the new uploads waiting to be transcribed.

## Workflow Per Receipt (root of `receipts/`, Money tab)

For each unparsed receipt file in this folder (not `grocery/`):

1. **Identify the corresponding expense** by looking up the filename in `expense_receipts.json`. Note the linked expense's date, amount, merchant.
2. **Parse the photo** following `receipt_scanner.md`:
   - Convert HEIC → JPEG if needed
   - Crop into overlapping sections so text is readable
   - Extract every line item with name + price + quantity
   - Extract store name, date, subtotal, tax, total, savings
3. **Verify** — your item count should match the receipt's "ITEMS PURCHASED" footer; prices should sum to subtotal.
4. **Write a sibling staging file** at `<original_filename>.parsed.json` (same shape as the grocery pipeline — see the `grocery/` workflow above for the exact schema: `store`, `date`, `subtotal`, `tax`, `total`, `saved`, `line_items: [{name, qty, price, unit_price}]`). Do NOT write `grocery_trips.json` or `expense_receipts.json` — those get written by the import route, not by you.
5. **Do NOT mark as parsed yourself** — `parsed: true` is set only when that import route actually applies your staging file, never by editing the map.
6. **Summarize for <OWNER_NAME>**: "Parsed <store> receipt for expense `<eid>`, total $<x>, saved to `<file>.parsed.json`. Ready to import." If no Money-tab button is wired up yet to trigger the import (check the app's current state), flag that so they can either trigger it once from their logged-in browser or ask their dev partner to wire up the button. `GET /api/expense-receipts/parsed/list` shows everything staged and waiting.

## Image Tools by Platform

The canonical prompt (`receipt_scanner.md`) assumes `sips` (macOS). If you're running on Linux:
- HEIC → JPEG: `heif-convert <file>.HEIC <file>.jpg` (install: `apt install libheif-examples`)
- Resize/crop: `convert <file> -crop WxH+X+Y -quality 80 <out>` (ImageMagick)
- Get dimensions: `identify -format "%w %h" <file>`

If neither toolchain is available, fall back to reading the full image directly with the Read tool — it may work for higher-res photos.

## Naming Convention

Web app uploads use: `<YYYY-MM-DD>-<merchant_slug>-<short_id>.<ext>` — e.g. `2026-05-02-heb-a3f1.jpg`. The short_id is the first 4 chars of the linked expense's UUID, so you can correlate without the JSON map.

## What NOT to do

- Don't parse files that are already marked `parsed: true` in `expense_receipts.json`
- Don't delete the original photo after parsing — it's reference material
- Don't invent line items if the photo is unreadable; output a `parse_error` field with what went wrong instead

## When done

After parsing all unparsed receipts, summarize for <OWNER_NAME>:
- N receipts parsed
- Any that failed (with reason)
- Total $ across all parsed receipts this session
