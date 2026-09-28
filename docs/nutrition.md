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
| FDC Branded Foods (2026-04) | `usda-fdc/FoodData_Central_branded_food_csv_2026-04-30.zip` (**outside git**) | `fdc_foods`, `fdc_branded*` | ~442,000 packaged products by barcode: the **maker's label** figures as USDA copies them, usually 10–15 nutrients. See "Packaged foods" below |
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

## Packaged foods: the maker's label, by name, brand or barcode

USDA's **Branded Foods** dataset is the manufacturers' own label data, submitted to USDA
(mostly through Label Insight and GS1). It's what Cronometer's barcode scanner reads. It is
**not a lab analysis**: each product carries what its label prints, per serving, which USDA
turns into per-100 g figures. That's usually 10–15 nutrients: energy, protein, fat, carbs,
sugars, fiber, sodium, and often calcium, iron, potassium and vitamins C and D. Labels
round ("0 g" can mean under 0.5 g), so a label zero is softer than a lab zero.

**Where it lives.** The zip is 428 MB (3 GB of CSV unzipped), over the commons' 95 MB git
limit. It came in through `commons_fetch.py --outside-git`: filed and checksummed in the
manifest like any other file, with its path put in the commons' `.gitignore` before the
file landed, so the backups skip it. Anyone can re-fetch it from the manifest's `url` and
check the `sha256`. commons.db grows from ~136 MB to ~570 MB with it.

**What the loader keeps** (`fdcdb._load_branded`, 10–15 minutes). USDA keeps every label
revision: 2.0 million rows for 465,000 barcodes. Only the **newest label per barcode** is
kept (latest `available_date`), and discontinued products are dropped: ~442,000 products.
The label figures go in `fdc_branded_amounts`, **apart from the lab figures** in
`fdc_amounts`, so the nutrient rankings and the whole-food search stay USDA-lab only and
don't get buried under half a million cereals. One unit change is made: a label giving
vitamin D only in IU (120,000 of them) gets a µg figure at IU ÷ 40, which is exact by
definition. Vitamin A in IU is **not** converted, because IU → RAE depends on how much is
retinol and how much carotene, which the label doesn't say. So a label's vitamin A in IU
stays unknown.

**Barcodes.** The same product is 12 digits on a US can (UPC-A), 13 in Europe (EAN-13) and
14 in USDA's file (GTIN-14). A barcode is matched as its digits with leading zeros dropped.
An 8-digit code is tried as EAN-8 and as UPC-E (the short code on small packs), expanded
back to UPC-A (`fdcdb.barcode_keys`).

**On the page.** In Meals, "Add a food" has a **Packaged** switch: search by name or brand
(SQLite full-text, `fdc_branded_fts`), type the barcode number, or tap **Scan** to read it
with the phone camera (`BarcodeScanner.tsx`, the zxing library, loaded only when opened;
it works in iPhone Safari, which has no built-in barcode reader). A picked product joins
the meal at one label serving when the label gives it in grams, else 100 g, marked a
guess. In the totals, a nutrient its label doesn't give is `missing`, like any unknown,
never 0, and "What to add" names it in `unknown_in`. Every nutrient a label *does* give
lists the product under `labelled`, and the page says "From the package label (the
maker's figures, not USDA's lab)".

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

**Daily, or does it build up?** (`nutrient_storage.py`, `StorageNote.tsx`). Each of the
23 ODS nutrients gets one of three readings: *Body stores it* (calcium, iron, vitamin A,
vitamin D, folate, B12), *Needed steadily* (thiamin, riboflavin, copper, vitamin K,
vitamin C), or *Store not stated* (the sheet says where it sits in the body, or nothing,
but not whether that carries you through low days). The six nutrients without a sheet
say "no sourced answer". The reading is ours. The sentences behind it are the sheet's,
quoted word for word. Every quote is checked against the sheet on each read, and one
that has gone missing is dropped rather than shown. "How long" appears only where the
sheet names a time: B12 several years, vitamin C about a month, vitamin D's blood form a
15-day half-life, thiamin a short half-life. The card closes with the sheet's own
definition of the RDA ("Average daily level of intake"), since targets are averages over
days. Deliberately *not* written from general knowledge. Zinc, for example, is "stored in
skeletal muscle and bone" per ODS, but the sheet doesn't say the body can draw on it, so
it stays *Store not stated*.

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

**Where each nutrient comes from** (`FoodShares.tsx`). `totals` also returns `by_food`: each food's
share of a nutrient's amount. A food eaten in two meals is merged by FDC id. The Nutrients list shows
each nutrient's top three sources. A nutrient's page lists every food that gives it, with its share of
the day and of the target. The "What each food gives you" card turns the same numbers around, food by
food (`foodGifts` in nutrientMath.ts). "Of target" uses the higher floor when both sexes are shown.

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

## Cups and spoons: amounts by kitchen measure

Her ask: type meal amounts as "1.5 cup" / "2 tbsp", and see What to add in cups and spoons
too. `measures.py` turns USDA's portion rows (`fdc_portions`, from FDC's `food_portion.csv`,
e.g. "0.5 cup = 107 g") into grams per one unit. A cup, tablespoon, teaspoon or fluid ounce
USDA didn't list for a food is worked out from its nearest-sized USDA volume by NIST's
kitchen volumes (1 cup = 240 mL, 1 tbsp = 15 mL, 1 tsp = 5 mL, 1 fl oz = 30 mL,
[Metric Kitchen](https://www.nist.gov/pml/owm/metric-kitchen-cooking-measurement-equivalencies)),
marked `derived`, and every food takes ounces by weight (1 oz = 28.35 g, NIST). A food with
no USDA portion at all is grams (or ounces) only, and the box says so.

The meal box (`AmountInput.tsx`, reading in `measureMath.ts`) takes grams, a cup / spoon, or
one of USDA's counts ("2 large" eggs, "1 clove"); when a food has two cups ("cup, whole" and
"cup, sliced"), extra words choose. Grams stay the number that's counted; what she typed is
kept on the item as `measure`. What to add shows "≈ ¾ cup" beside each amount, rounded to
the nearest quarter of the biggest unit that fits, each linked to its USDA or NIST source.
A volume weight is the density of that food as USDA measured it, so a heaped or packed
cup will differ.

## Rules the arithmetic keeps

- **Unknown is not zero.** Foundation foods lack many nutrients. Rolled oats, for example,
  have no vitamin A, C, D or K figure. A total lists the foods it's `missing` instead of
  counting them as 0, and the page shows that. A packaged product's missing nutrients count
  the same way. Some nutrients have a fallback id when the
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

**The calculator** (`plan_additions`, `GET /api/nutrition/plan`, `MealPrepPlan.tsx`) is this
problem, solved with `scipy.optimize.linprog` (HiGHS). Her choices: it only **adds** food (what she
eats now stays fixed), and only her **starred** foods. Stored nutrients (those `nutrient_storage.py`
reads as *Body stores it*: calcium, iron, vitamins A and D, folate, B12) are judged on the **week's
average**; every other nutrient must be met every day (her answer, 2026-09-28). So each food has three
unknowns: `d` grams every day, `w` grams a week on top, eaten in sittings of `p`
(`d + p ≤ cap`, `w ≤ 7p`). A daily nutrient counts only `C·d`, and a weekly one counts `C·(d + w/7)`.
ULs are checked on the heaviest day, `C·(d + p)`, and the calorie cap on the average day. It runs
four times, each keeping the last: least total shortfall (each gap as a fraction of its target),
fewest grams on the average day, least eaten every day (this pushes stored-only needs into weekly
sittings), then the biggest sittings (the fewest times a week). Seven sittings a week are folded
back into "every day". Worth knowing: weekly averaging never lowers the *total* grams. With no
per-sitting cost, a plan spread over the week can't beat the same plan every day. It only makes
some of it less frequent. A UL the day is already past is listed in `already_over`. An unknown figure counts as none, and the food is named in `unknown_in`.

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

- `GET /api/nutrition/day`: the usual day's totals against the targets, plus `storage`,
  each nutrient's stored-or-steady marker.
- `GET /api/nutrition/search?q=`: FDC food search (Foundation, then SR Legacy, then FNDDS).
- `GET /api/nutrition/packaged?q=`: packaged products (Branded Foods) by name or brand; a `q`
  of 8+ digits is a barcode, typed or scanned.
- `GET /api/nutrition/rank/<key>?per=100g|100kcal&q=&limit=&histamine=low`: every FDC food
  ranked by one tracked nutrient, richest first. Per 100 kcal is nutrient density; foods
  under 5 kcal per 100 g are left out of it, and foods with no figure are never ranked as 0.
  Each food carries its SIGHI rating (`histamine`), and `histamine=low` keeps only the 0s,
  filtered before the limit.
- `GET /api/nutrition/nutrient/<key>`: `{row, sexes, facts, storage}`, the day's row for one
  nutrient plus the ODS sections and the stored-or-steady reading.
- `GET /api/nutrition/measures?ids=`: grams in one cup / tbsp / count of each food
  (`measures.py`), each with its source and link.
- `GET /api/nutrition/highlights`, `POST /api/nutrition/highlights/<fdc_id>` `{on, description}`:
  star / unstar.
- `POST /api/nutrition/meals/<name>`: replace a meal's items (a new name makes a new meal).
- `DELETE /api/nutrition/meals/<name>`: delete a meal and take it out of the day.
- `POST /api/nutrition/servings/<name>`: servings a day; 0 keeps the meal but stops counting it.
- `POST /api/nutrition/settings`: sex / age.

## Testing traps

Test fixtures that write inside `fdcdb.session` must `commit()` before calling a route. The
route opens its own connection and won't see uncommitted rows.
