# Nutrition — an own-Cronometer

A day of meals, weighed in grams, added up nutrient by nutrient and laid beside the
daily targets. Built so every number says how sure it is.

Files: `fdcdb.py` (food composition), `dri.py` (daily targets), `nutrition.py` (the
arithmetic), `routes/nutrition.py` (HTTP), `scripts/nutrient_data.py` (load / search /
show), `frontend/src/features/nutrition/` (the `/food/nutrients` page). Project: **kitchen**
in `projects.json`.

## The build order

1. **Food composition, offline.** USDA FoodData Central, downloaded whole into the commons.
2. **Meals with gram weights.** Her meals as foods × grams.
3. **Daily targets.** The Dietary Reference Intakes.
4. **An optimizer** (linear programming: meet every target, stay under every limit, change
   the fewest grams). **Not built — ask the owner first**; she may want to write it herself.

## Data sources

All three come through `scripts/commons_fetch.py` into the commons, and are read into
`commons.db` (see `commonsdb.py`). Nothing is fetched at request time.

| Source | Commons file | Table(s) | What it gives |
|---|---|---|---|
| FDC Foundation Foods (2026-04) | `usda-fdc/FoodData_Central_foundation_food_csv_2026-04-30.zip` | `fdc_*` | ~470 whole foods USDA analyzed itself, with sample count and min / max / median |
| FDC SR Legacy (2018, frozen) | `usda-fdc/FoodData_Central_sr_legacy_food_csv_2018-04.zip` | `fdc_*` | ~7,800 foods, one number per nutrient, no spread |
| IOM/NASEM DRI summary tables | `nasem-dri/vitaminintake.pdf` | `dri_values` | RDA / AI / UL by sex and age band |

The DRI PDF is the four summary tables as reproduced by K-State. The primary hosts (NCBI
Bookshelf, canada.ca, NIH ODS, National Academies) all turned away scripted downloads.
`load_dri` reads it through `pdftotext -layout` and **refuses any row whose cell count is
wrong**, so a mangled row fails loudly and never shifts values into the wrong column. Only
the Males / Females rows are read. That also skips the PDF's own typos in the pregnancy
rows ("61−50 y").

Reload with `./venv/bin/python3 scripts/nutrient_data.py load`.

## Rules the arithmetic keeps

- **Unknown is not zero.** Foundation foods lack many nutrients. Rolled oats, for example,
  have no vitamin A, C, D or K figure. A total lists the foods it's `missing` instead of
  counting them as 0, and the page shows that. Some nutrients have a fallback id when the
  main one is absent: energy 1008 → 2048 → 2047 (Atwater variants), fiber 1079 → 2033.
- **A range where USDA gives one.** Foundation foods carry the min and max of their
  samples. A day's low / high is those added up. SR Legacy foods add the same number to
  both ends.
- **RDA vs AI.** An RDA is set from measured requirements and covers 97–98% of people. An
  AI is a best guess, used where the evidence was too thin, and the page marks it as
  softer.
- **UL scope.** Some upper limits don't count food (`dri.UL_SCOPE`): magnesium counts
  supplements and medicines only; vitamin E, niacin and folate count supplements and
  fortified foods only; vitamin A counts preformed retinol only, not plant carotenoids. For
  these the page says the limit doesn't apply to food, instead of flagging "over". A
  plant-heavy day can read 4× the vitamin A RDA and still be nowhere near the retinol UL.
- **The 2019 sodium & potassium update.** The 2019 NASEM report (doi:10.17226/25353)
  replaced the 2005 Na/K values the PDF prints. It sits in `dri.UPDATES_2019`, typed in
  from the report, and is marked that way wherever it shows.
- **"Both" sexes.** `nutrition_settings.sex` can be `female`, `male` or `both`. `both`
  shows the two target columns side by side, for a body the tables don't describe with one
  row. Iron is the widest gap (18 vs 8 mg). Bloodwork is the better guide there.
- **Guessed grams.** Each meal item carries `grams_guessed: true` until someone weighs it.
  The page marks those, because the whole result is only as good as the weights.
- **Added salt isn't counted.** Sodium reads low unless salt is added as an item.

## Where her data lives

JSON collections through `store.py` (not SQL-backed, so not in `projects.json`
"collections"):

- `nutrition_meals`: meals as `{label, fdc_id, grams, grams_guessed?}` items, plus her
  usual day as `[{meal, servings}]`.
- `nutrition_settings`: `{sex, age}`.

Personal facts (her age, why "both") stay in those vault files, never in this repo.

## HTTP

- `GET /api/nutrition/day`: the usual day's totals against the targets.
- `GET /api/nutrition/search?q=`: FDC food search.
- `POST /api/nutrition/meals/<name>`: replace a meal's items.
- `POST /api/nutrition/settings`: sex / age.

## Testing traps

Test fixtures that write inside `fdcdb.session` must `commit()` before calling a route. The
route opens its own connection and won't see uncommitted rows.
