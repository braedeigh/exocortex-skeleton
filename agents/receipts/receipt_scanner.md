<!-- Origin: personal vault prompts/receipt_scanner.md. Scrubbed modular copy
     — plug-in points marked PLUG-IN(...) -->
# Receipt Scanner Prompt

You are scanning a grocery receipt photo. Your job is to extract every item, its price, and quantity accurately.

## Image Processing

Receipt photos are usually too large and low-res to read in one shot. You MUST crop the image into sections before reading:

1. Get the image dimensions: `sips -g pixelHeight -g pixelWidth <file>`
2. Convert from HEIC if needed: `sips -s format jpeg <file> --out <output.jpg>`
3. Crop into overlapping vertical sections (top half, bottom half) so text is large enough to read:
   ```
   sips -s format jpeg <file> --out top.jpg --resampleHeight 1400 -s formatOptions 45 --cropOffset 0 0 --cropToHeightWidth <half_height> <full_width>
   sips -s format jpeg <file> --out bottom.jpg --resampleHeight 1400 -s formatOptions 45 --cropOffset <half_height_minus_overlap> 0 --cropToHeightWidth <half_height> <full_width>
   ```
4. Keep each output file under 256KB. Adjust quality (formatOptions) and resampleHeight to fit.
5. Read each cropped section with the Read tool.

(`sips` is macOS-only — see the sibling `CLAUDE.md`'s "Image Tools by Platform" section for the Linux equivalents.)

## Reading the Receipt

Receipt printers wrap long lines. Watch for these patterns that are NOT separate items:
- **Weight lines**: `1.08 Lbs @ 0.97 FW` — this is the unit price for the item above it
- **Quantity lines**: `2 Ea. @ 6.28 F` — this is the per-unit breakdown for a multi-buy item above it
- These sub-lines do NOT have item numbers

**Each real item has a number at the start of the line** (1, 2, 3...). Lines without a leading number are detail lines for the previous item.

## Output Format

Return a JSON array:
```json
[
  {"item": "CM Org Whole Milk", "price": 7.48, "quantity": 1},
  {"item": "Broccoli Crowns", "price": 1.05, "quantity": 1, "weight": "1.08 lbs", "unit_price": 0.97},
  {"item": "Cappiello Mozz Ciliegine", "price": 12.56, "quantity": 2, "unit_price": 6.28}
]
```

Also extract:
- **Store name** (from logo/header)
- **Date** (from header — format: YYYY-MM-DD)
- **Subtotal, tax, total, savings**
- **Items purchased count** (from receipt footer — use this to verify your item count)

## Verification

After extracting, check:
1. Your item count matches the "ITEMS PURCHASED" number on the receipt (note: multi-quantity items like "2 Ea." count as 2 in the receipt's count)
2. Your prices sum to approximately the subtotal
3. No weight/quantity sub-lines were counted as separate items

## Where to Save

This prompt only covers *reading* the receipt — where to write the output
depends on the pipeline that invoked you.

<!-- PLUG-IN(SAVE_PATH): the vault original told you to save straight to
     `data/grocery_trips.json`, a direct write this repo's own doctrine now
     forbids (see the sibling `CLAUDE.md`'s "Why never write the data files
     directly"). If you're using this prompt standalone rather than via that
     CLAUDE.md's staging-file workflow, define your own save convention here
     and remove this comment. -->

If a sibling `CLAUDE.md` invoked you, follow its staging-file convention
instead (write a `.parsed.json` next to the photo; never write a data file
directly).
