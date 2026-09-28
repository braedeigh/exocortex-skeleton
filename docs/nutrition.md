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
4. **An optimizer**: a linear program that meets every target, stays under every limit and
   changes the fewest grams. **It's being built together with the owner** as
   linear-algebra practice. The data half exists (`nutrition.matrix`); the solving half is
   hers to write with help. See "Step 4, together" below.

## Data sources

All four come through `scripts/commons_fetch.py` into the commons, and are read into
`commons.db` (see `commonsdb.py`). Nothing is fetched at request time.

| Source | Commons file | Table(s) | What it gives |
|---|---|---|---|
| FDC Foundation Foods (2026-04) | `usda-fdc/FoodData_Central_foundation_food_csv_2026-04-30.zip` | `fdc_*` | ~470 whole foods USDA analyzed itself, with sample count and min / max / median |
| FDC SR Legacy (2018, frozen) | `usda-fdc/FoodData_Central_sr_legacy_food_csv_2018-04.zip` | `fdc_*` | ~7,800 foods, one number per nutrient, no spread |
| FDC Survey Foods / FNDDS 2021–2023 (2024-10) | `usda-fdc/FoodData_Central_survey_food_csv_2024-10-31.zip` | `fdc_*` | ~5,400 foods "as eaten"; every food has all ~65 nutrients, with USDA **imputing** the ones nobody analyzed. No iodine |
| IOM/NASEM DRI summary tables | `nasem-dri/vitaminintake.pdf` | `dri_values` | RDA / AI / UL by sex and age band |

FNDDS's `food_nutrient.csv` names a nutrient by its old 3-digit number (301 = calcium), where
the other two use the FDC id (1087). The loader translates the numbers through `nutrient.csv`,
and takes FNDDS's categories from its WWEIA list.

The DRI PDF is the four summary tables as reproduced by K-State. The primary hosts (NCBI
Bookshelf, canada.ca, NIH ODS, National Academies) all turned away scripted downloads.
`load_dri` reads it through `pdftotext -layout` and **refuses any row whose cell count is
wrong**, so a mangled row fails loudly and never shifts values into the wrong column. Only
the Males / Females rows are read. That also skips the PDF's own typos in the pregnancy
rows ("61−50 y").

Reload with `./venv/bin/python3 scripts/nutrient_data.py load`.

## Nutrient pages: deficiency text and the low-histamine list

Each nutrient's name on the Nutrients page opens `/food/nutrients/<key>`: the day's total,
what the nutrient does and what happens without enough, and every USDA food ranked by it.

**Deficiency text: NIH ODS, word for word** (`nutrient_facts.py`). The source is the NIH
Office of Dietary Supplements Health Professional Fact Sheet for each of the 23 vitamins
and minerals tracked. They're public domain and reviewed, and each one is laid out the
same way: "Introduction", "<X> Deficiency", "Groups at Risk of <X> Inadequacy". The sheets
sit in the commons under `nih-ods/`. ods.od.nih.gov turns this machine away behind
Cloudflare, so they came in through Internet Archive snapshots from 2026-08/09, and each
manifest entry names its snapshot. The page shows the sections as written, with citation
numbers stripped, and links ODS's own address. No text is paraphrased. Energy, protein,
fat, carbohydrate, fiber and sodium have no ODS sheet, and their pages say so.

**Low-histamine list: SIGHI, one list, named** (`histamine.py`). Low-histamine lists
disagree. The app follows only the Swiss Interest Group Histamine Intolerance *Food
Compatibility List* (2023-04-01 edition). It rates each food 0–3 for tolerance by
histamine-sensitive people, with a reason code for each, and it's the most detailed free
list. SIGHI's copyright asks that the list not be re-hosted, so it is kept out of the
commons (public) and this repo. `python3 histamine.py` downloads it from SIGHI into
`<data>/histamine/`.

USDA foods are matched to SIGHI entries **by name, approximately**:
- "Cheese, cheddar" is tried as "cheddar cheese", then "cheese cheddar", then "cheese",
  against every name and comma-separated synonym SIGHI gives.
- Where one name carries more than one rating, the worst is kept.
- Organ meats are rated as SIGHI's "innards".
- Canned, smoked, cured, pickled and fermented foods (kimchi, sauerkraut, miso, tempeh,
  natto) are "avoid", from SIGHI's leaflet.

Every row shows the SIGHI entry it matched, so a wrong match can be seen. The "Low
histamine only" filter keeps SIGHI 0s and nothing else. Foods not on the list are left
out, never assumed safe. Kale, for example, isn't on it.

**Single foods only** (`nutrition.is_single_food`). This switch is on the rankings and on
the add-a-food search in Meals. It keeps foods you could buy as themselves, like milk,
potatoes, rice and kale. A food passes when:
1. It's Foundation or SR Legacy. FNDDS is foods "as eaten", mostly dishes.
2. Its USDA food group is a plain-food group: vegetables, fruits, legumes, dairy and egg,
   grains, fish, beef, pork, poultry, lamb/veal/game, nuts and seeds, spices, fats and oils.
3. Its name has none of the made-from-other-things words (`MADE_WORDS`: with, canned,
   sauce, juice, fried, cured, smoked, …), no "salt added", and no brand in capitals.
   "with added vitamin D" is fortification and is ignored.

Cooked forms and cuts stay in, so "Kale, raw" and "Kale, cooked, boiled" both show. It's a
word rule, so it can be wrong at the edges. About 3,560 of the 13,700 foods pass.

**Stars.** A ☆ on any ranked food saves it to `nutrition_highlights`, the foods she's
interested in eating. They're listed on the Nutrients page and tinted in every ranking. A
star doesn't add the food to a meal.

## Rules the arithmetic keeps

- **Unknown is not zero.** Foundation foods lack many nutrients. Rolled oats, for example,
  have no vitamin A, C, D or K figure. A total lists the foods it's `missing` instead of
  counting them as 0, and the page shows that. Some nutrients have a fallback id when the
  main one is absent: energy 1008 → 2048 → 2047 (Atwater variants), fiber 1079 → 2033.
- **Gaps filled from a second USDA entry, and labelled.** A meal item may carry
  `fill_from`, the FDC id of a second entry for the same food (usually FNDDS). That entry
  is used only for the nutrients the item's own entry lacks, never over a measured figure.
  The total lists those foods under `filled`, and the page says "filled in from USDA's
  survey data (partly estimated)". Foundation oats + FNDDS "Oats, raw" is the typical
  pair: the first gives a measured range, the second fills vitamins D/E/K and choline.
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

## Other sources (surveyed 2026-09)

Cronometer uses USDA plus NCCDB, CNF, NUTTAB/AFCD, CoFID, NEVO and IFCDB. The commons takes
a source only if its licence allows redistribution.

| Source | Licence | Redistributable? | What it adds |
|---|---|---|---|
| USDA FNDDS (Survey Foods) | US public domain | yes | **Loaded.** A full ~65-nutrient profile for every food. The gaps are **imputed**, so it has to be labelled that way |
| Canadian Nutrient File 2026 (May 2026) | Open Government Licence – Canada | yes | CSVs in the same shape as FDC. Much of it is derived from USDA SR, so it's a cross-check more than an independent source |
| AFCD Release 3 (FSANZ, Australia) | CC BY-SA 3.0 AU + extra terms | yes, share-alike | ~1,588 foods, independent Australian analyses, updated vitamin D. Excel |
| CoFID 2021 (UK, McCance & Widdowson) | Open Government Licence v3 | yes | ~2,900 foods, independent UK analyses. Excel |
| NEVO 2025/9.0 (Netherlands, RIVM) | RIVM agreement: "only unchanged", cite version | doubtful | ~2,300 foods, ~130 nutrients |
| Frida 5.5 (Denmark, DTU) | credit required, terms not confirmed | unconfirmed | ~1,000 foods, strong analytical detail |
| NCCDB (Univ. of Minnesota) | paid licence (thousands of $) | no | What Cronometer calls its most complete source |

No database is simply "more accurate". Most are averages of a few samples, and one food's
real spread (variety, soil, storage) is often wider than the gap between two databases.
Foundation's min/max already shows that. The useful gain is **coverage**: filling the
`missing` gaps from a second source, with the source shown on each number. The owner chose
to stay with USDA ("USDA style"). The non-US sources are not loaded.

## Step 4, together

The diet problem as linear algebra. Say there are *n* foods and *m* nutrients.

- **x** is a vector of *n* numbers: grams of each food in a day. These are the unknowns.
- **A** is an *m × n* matrix: `A[i][j]` is nutrient *i* in one gram of food *j*.
  `nutrition.matrix` builds it from her meals, and `scripts/nutrient_data.py matrix` prints
  it. Each column is one food's nutrient profile. Each row is one nutrient across her foods.
- **A·x** (matrix × vector) is the day's nutrient totals. Every row is a dot product: grams
  × amount-per-gram, summed over foods. That is exactly what `totals` does in a loop.
- The **constraints** are `lower ≤ A·x ≤ upper` (the RDA/AI floor, the food-counting UL
  ceiling) and `x ≥ 0`. Each is a half-space. Together they cut out a convex polytope, the
  set of every diet that meets every target.
- The **objective** picks one point in that polytope. "USDA style" is the Thrifty Food Plan's
  model: USDA solves for a diet that meets the nutrient targets while staying as close as
  possible to what people already eat. Here that means minimizing Σ |x_j − current_j|: the
  fewest grams changed from her usual day. The absolute value isn't linear. The standard
  trick is to split each change into up/down parts, both ≥ 0, which keeps it an LP.
  Cost (from receipts) or contaminant dose can be added as weights or caps later.
- **Unknowns in A** (`None`, e.g. iodine for most foods) have to be decided before solving:
  drop that nutrient's row, or treat the food as contributing nothing and say so. They are
  never silently 0.

A suggested learning path, each step runnable against her real matrix:
1. Vectors and the dot product: compute one nutrient's total by hand from one row of A.
2. Matrix × vector: compute the whole day at once and check it against the page's totals.
3. Inequalities as half-spaces: with 2 foods and 2 nutrients, draw the feasible region.
4. What an LP solver does (vertices, simplex) on that 2-D picture.
5. Solve the full problem with `scipy.optimize.linprog`, then read the answer back as meals.

## Where her data lives

JSON collections through `store.py` (not SQL-backed, so not in `projects.json`
"collections"):

- `nutrition_meals`: meals as `{label, fdc_id, grams, grams_guessed?, fill_from?}` items, plus her
  usual day as `[{meal, servings}]`.
- `nutrition_settings`: `{sex, age}`.
- `nutrition_highlights`: `{foods: [{fdc_id, description, added}]}`, the starred foods.
- `histamine/SIGHI-FoodList-EN.pdf`: SIGHI's list, fetched by `python3 histamine.py`. It's
  reference data, but it's kept private because of SIGHI's no-rehosting request.

Personal facts (her age, why "both") stay in those vault files, never in this repo.

## HTTP

- `GET /api/nutrition/day`: the usual day's totals against the targets.
- `GET /api/nutrition/search?q=`: FDC food search (Foundation, then SR Legacy, then FNDDS).
- `GET /api/nutrition/rank/<key>?per=100g|100kcal&q=&limit=&histamine=low`: every FDC food
  ranked by one tracked nutrient, richest first. Per 100 kcal is nutrient density; foods
  under 5 kcal per 100 g are left out of it, and foods with no figure are never ranked as 0.
  Each food carries its SIGHI rating (`histamine`), and `histamine=low` keeps only the 0s,
  filtered before the limit.
- `GET /api/nutrition/nutrient/<key>`: `{row, sexes, facts}`, the day's row for one nutrient
  plus the ODS sections.
- `GET /api/nutrition/highlights`, `POST /api/nutrition/highlights/<fdc_id>` `{on, description}`:
  star / unstar.
- `POST /api/nutrition/meals/<name>`: replace a meal's items (a new name makes a new meal).
- `DELETE /api/nutrition/meals/<name>`: delete a meal and take it out of the day.
- `POST /api/nutrition/servings/<name>`: servings a day; 0 keeps the meal but stops counting it.
- `POST /api/nutrition/settings`: sex / age.

## Testing traps

Test fixtures that write inside `fdcdb.session` must `commit()` before calling a route. The
route opens its own connection and won't see uncommitted rows.
