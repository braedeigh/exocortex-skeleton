/**
 * ecoMatch.ts — the bridge between recipe ingredients and ecosystem sources.
 * Port of static/js/eco-match.js (shared there by the kitchen + ecosystem tabs).
 *
 * A recipe lists free-text ingredients ("yellow onion", "HEB chuck roast"); the
 * ecosystem map holds placed sources with free-text names ("Onions", "HEB chuck
 * roast"). This matches one to the other by normalized token overlap, so a recipe
 * can show where its food comes from without anyone hand-linking every item.
 *
 * Honest by design: an ingredient with no matching source is *untraced* (worth
 * placing), and a pantry staple (salt, water, spices) is *pantry* (nothing
 * meaningful to trace) — neither pretends to a location it doesn't have.
 */
import type { EcoIngredient, EcoRecipe, EcoSource } from './types';

/** Words that describe HOW a food is sold/prepped, not WHAT it is. Stripped
 * before matching so "HEB chuck roast" ~ "chuck roast" and "yellow onion" ~
 * "onion". */
const ECO_MATCH_STOP = new Set([
  'heb', 'central', 'market', 'whole', 'foods', '365', 'kirkland', 'trader',
  "joe's", 'joes', 'organic', 'fresh', 'raw', 'dried', 'ground', 'large',
  'medium', 'small', 'baby', 'boneless', 'skinless', 'of', 'a', 'the', 'and',
  'or', 'with', 'to', 'taste', 'optional', 'from', 'cup', 'cups', 'tbsp',
  'tsp', 'lb', 'lbs', 'oz',
]);

/** Pantry staples — real ingredients, but ones with no meaningful place to map
 * (you don't trace where your salt came from). Matched by word so they render
 * muted instead of nagging as "untraced". */
const ECO_PANTRY_RE =
  /\b(salt|pepper|peppercorns?|water|oil|vinegar|sugar|flour|baking|cornstarch|bay\s*leaf|bay\s*leaves|worcestershire|cumin|paprika|turmeric|thyme|parsley|sage|rosemary|garlic\s*powder|onion\s*powder|spices?|herbs?|broth|stock)\b/i;

/** Ingredient categories that are NOT worth placing on the map (vs produce /
 * fruit / protein / dairy / grains / vegetables / other, which are).
 * (n_a is intentionally absent — "chicken bones" is n_a yet traceable to
 * chicken; genuine non-foods like water are caught by ECO_PANTRY_RE
 * regardless of category.) */
const ECO_PANTRY_CATS = new Set(['usually_have', 'drinks']);

export function ecoSingular(w: string): string {
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2); // potatoes->potato, tomatoes->tomato
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'; // berries->berry
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2); // dishes->dish
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1); // onions->onion
  return w;
}

export function ecoTokens(s: string | null | undefined): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .filter((w) => !ECO_MATCH_STOP.has(w))
    .map(ecoSingular)
    .filter((w) => w.length > 1); // drop stray single letters (the "h e b" debris)
}

/** Best-matching source for a free-text ingredient name, or null. Requires at
 * least one shared significant word; scores by overlap, lightly penalizing
 * leftover words so a tighter name wins ties. */
export function ecoMatchIngredient(item: string, sources: EcoSource[] | null | undefined): EcoSource | null {
  const it = ecoTokens(item);
  if (!it.length) return null;
  const itSet = new Set(it);
  let best: EcoSource | null = null;
  let bestScore = 0;
  (sources || []).forEach((s) => {
    const st = ecoTokens(s.name);
    if (!st.length) return;
    let overlap = 0;
    st.forEach((w) => {
      if (itSet.has(w)) overlap++;
    });
    if (!overlap) return;
    // Guard against a single generic word colliding two different foods on the
    // same head noun ("yukon potatoes" vs "Sweet potatoes"): one shared word
    // only counts when at least one side has no competing qualifier of its own.
    if (overlap === 1 && st.length > 1 && it.length > 1) return;
    const score = overlap * 2 - (st.length - overlap) * 0.25 - (it.length - overlap) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  });
  return best;
}

export interface RecipeSourcing {
  traced: { ing: EcoIngredient; source: EcoSource }[];
  place: { ing: EcoIngredient }[];
  pantry: { ing: EcoIngredient }[];
  total: number;
}

/** Full sourcing breakdown for a recipe against the placed sources.
 * traced = matched to a source · place = unmatched but worth placing ·
 * pantry = staple with nothing meaningful to trace. */
export function ecoRecipeSourcing(
  recipe: EcoRecipe | null | undefined,
  sources: EcoSource[] | null | undefined,
): RecipeSourcing {
  const out: RecipeSourcing = { traced: [], place: [], pantry: [], total: 0 };
  (recipe?.ingredients || []).forEach((ing) => {
    const item = (ing.item || '').trim();
    if (!item) return;
    out.total++;
    // Pantry staples win over matching — a seasoning or liquid shouldn't trace
    // to a meat source on a stray shared word ("chicken broth" → "HEB chicken").
    const cat = (ing.category || '').toLowerCase();
    if (ECO_PANTRY_RE.test(item) || ECO_PANTRY_CATS.has(cat)) {
      out.pantry.push({ ing });
      return;
    }
    const match = ecoMatchIngredient(item, sources);
    if (match) out.traced.push({ ing, source: match });
    else out.place.push({ ing });
  });
  return out;
}

/** The set of source ids a recipe's ingredients map to (for map highlighting). */
export function ecoRecipeSourceIds(
  recipe: EcoRecipe | null | undefined,
  sources: EcoSource[] | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  ecoRecipeSourcing(recipe, sources).traced.forEach((t) => ids.add(t.source.id));
  return ids;
}
