# Recipe nutrients — what a recipe gives, and what in it you're sensitive to

A kitchen recipe added up like a meal on the Nutrients page, one serving at a time,
against the daily targets; plus a filter over the Recipes list for foods that hurt
and for histamine. Files: `recipe_nutrition.py` (the working-out),
`routes/recipe_nutrition.py` (HTTP), `foodstore.py` (`set_usda`, `set_line_grams`),
`frontend/src/features/kitchen/` (`recipeNutrition.ts`, `RecipeNutrients.tsx`,
`RecipesSection.tsx`). Tests: `tests/test_recipe_nutrition.py`,
`kitchen/recipeNutrition.test.ts`. The arithmetic itself is `nutrition.py`'s
(`report`), unchanged — see [nutrition.md](nutrition.md).

## The two bridges a recipe line needs

A recipe line is written for a cook ("carrots — 3 medium, chunked"). Nutrition runs on
USDA entries and grams. Each line crosses two bridges, and each says how sure it is.

**1. Which USDA entry the food is.** Stored per catalog *food*, not per line, in the
`food_usda` table (a record, backed up in `food_catalog.json`, carried by `merge`).
Choosing it once fixes every recipe with that food. Until she chooses, one is
**suggested from the food's name**, counted, and marked **guess**:

- every searched word must be a whole word of the USDA name ("butter" never matches
  "Fish, butterfish");
- only single foods (`nutrition.is_single_food`) — a recipe lists ingredients;
- the whole name first, then its last word alone (the noun: "yukon potatoes" →
  potato), never an earlier word ("beef broth" suggests nothing rather than ground
  beef), and a lone word only when it's USDA's head word ("water" doesn't become
  "Water convolvulus");
- ranked by how little USDA's leading words add to the name, then a raw form, then
  SR Legacy (it carries household portions; most Foundation entries don't), then the
  shortest name.

It's a word rule and it is wrong sometimes ("milk" → sheep's milk). That's why a guess
is marked and "Change" / "Right" sit beside it.

**2. How many grams.** In order:

1. **Hers** — `recipe_line_grams`, keyed by the line's text and remembering the amount
   it was set against. If the recipe's amount changes later, her old weight is shown
   as out of date and *not used*.
2. **As written** — a weight in the amount ("600 g", "1 lb"). A weight in brackets is
   per piece: "1 (3-4 lb)" is one 3.5 lb chicken, "2 (3 lb)" is 6 lb.
3. **From USDA's household portions** for the entry — marked **guess**: a count with
   a size or piece word ("3 medium", "6 cloves", "3 ribs" → stalk), a bare count
   matched by a word from the line ("garlic cloves — 6"), or a spoon/cup scaled from
   whichever spoon or cup USDA gives.

A range takes its middle and says so. **Unknown is not zero**: "to taste", "a drizzle",
"to cover", a count USDA has no piece for ("2 medium" parsnips — USDA gives only cups)
are listed as *not counted*, and her own weight fixes them.

A weight as written is the weight as bought: a whole chicken's pounds include bone.
Set her own weight on that line for the edible part.

## Per serving, and her gaps

The counted lines, divided by the recipe's `servings`, go through `nutrition.report`
exactly like a meal, so the targets, AI/RDA marks, and UL scope all read the same as
on the Nutrients page. A recipe without servings is shown whole, and says so.

**Gaps** are the nutrients her usual day (`nutrition.day_items`) is under target for.
The Recipes list's "Good for…" picks one and sorts by the share of its target one
serving gives; each card shows a serving's calories and its top gaps. When both sexes
are shown, the stricter (lower) percentage is used.

## Sensitivities

- **Hurts / unsure** — the food guide's lists (`food_guide.json`) matched by name,
  or the catalog food's `safety`. "Hide what hurts" hides any recipe with a hurts line.
- **Histamine** — SIGHI's rating of the line's USDA entry name (or the food name when
  there's no entry), by `histamine.rate`. "Low histamine" hides a recipe with any line
  rated high (2–3) or "avoid" (canned, cured, fermented…). Moderate and unrated lines
  don't hide a recipe; the recipe's page lists them. Stricter than this would hide
  nearly everything, since spices and vinegar are often rated. The matched SIGHI entry
  shows on hover, so a bad match can be seen.

## HTTP

- `GET /api/recipes/nutrition` — every recipe in short, her gaps.
- `GET /api/recipes/<id>/nutrition` — one recipe line by line, one serving's report.
- `POST /api/recipes/<id>/grams` `{line, grams|null, for_amount}` — her weight for a line.
- `POST /api/food/foods/<id>/usda` `{fdc_id|null}` — which USDA entry a food is.

All of it is hers: nothing here is in `public_config.PUBLIC_PATHS`, and the kitchen
components don't fetch it for a visitor. Shared recipes, below, are the one door out.

## Sharing (recipe_shares.py, routes/recipe_share.py)

Her decisions (2026-09-28): popular recipes are the ones people **explicitly share**
(no outside recipe API); a shared link should reach people **outside the tailnet**,
but through a public website that comes later; a shared recipe shows the
**recipient's own** nutrient fit per serving.

- **A share is a token.** `POST /api/recipes/<id>/share` gives the recipe's open
  token, or makes one (`secrets.token_urlsafe`). `unshare` closes every open token
  for it, and sharing again makes a new one, so a closed link never comes back.
  Kept in `recipe_shares.json` (store.py, not SQL): `{shares: {token: {recipe_id,
  created_at, revoked_at, views}}}`.
- **What a visitor sees is an allow-list**: name, servings, prep/cook minutes,
  source URL, ingredients (item, qty, note), steps (instructions and sections).
  Never `my_notes`, `notes` or `tags`, her food guide, catalog safety, her USDA
  choices' ids, or her targets. `recipe_nutrition.for_visitor` resolves the lines
  with an empty guide and strips each line to text/amount/grams/USDA description/
  histamine.
- **Their targets, not hers.** The visitor types an age and sex. They ride as query
  parameters and are never stored. `nutrition.report` is always called with an
  explicit sex (`both` by default) and age (0 when none is given, which means no
  targets), so her settings are never the fallback.
- **A visitor never writes to the database.** Their requests skip
  `foodstore.rebuild()` and read the recipe rows her own views last rebuilt. Sharing
  rebuilds them, so a recipe is current when shared. An edit made after sharing
  shows up once she next opens Kitchen.
- **Popular** = every open share, most opened first. A view is counted when the page
  first opens a recipe (`count=1`), not when the age box changes. It's a ranking
  hint, not a measure: reloading on purpose inflates it.
- **The visitor's filters** run in their page and aren't saved. "Foods you avoid"
  matches whole words, singular or plural, against the ingredient items. "Low
  histamine" hides recipes with a SIGHI-high line, and "Good for…" sorts by their
  own % of target.
- **Pages**: `/share/r/<token>` and `/share/recipes` are SPA routes drawn without the
  shell (`routes/__root.tsx`). `/share/` and `/api/share/` are prefixes in
  `public_config.PUBLIC_PATHS`, so they open without login. Her side
  (`/api/recipes/shares`, `/share`, `/unshare`) stays behind it.
- **Not yet**: reach beyond the tailnet (the public website), and recipes shared
  from *other* exocortexes showing up in Popular (needs the Shape 1 grants and
  Shape 3 exchange in dev_todo).
