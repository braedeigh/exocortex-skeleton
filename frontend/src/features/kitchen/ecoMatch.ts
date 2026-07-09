/**
 * ecoMatch.ts — the bridge between recipe ingredients and ecosystem sources.
 * Feature-local re-implementation of static/js/eco-match.js (the ecosystem
 * feature owns its own copy): matches free-text ingredient names to placed
 * sources by normalized token overlap.
 *
 * Honest by design: an ingredient with no matching source is *untraced*
 * (worth placing), and a pantry staple (salt, water, spices) is *pantry*
 * (nothing meaningful to trace).
 */
import type { EcoSource, Recipe, RecipeIngredient } from './types';

/** Words that describe HOW a food is sold/prepped, not WHAT it is. */
const ECO_MATCH_STOP = new Set([
  'heb', 'central', 'market', 'whole', 'foods', '365', 'kirkland', 'trader',
  "joe's", 'joes', 'organic', 'fresh', 'raw', 'dried', 'ground', 'large',
  'medium', 'small', 'baby', 'boneless', 'skinless', 'of', 'a', 'the', 'and',
  'or', 'with', 'to', 'taste', 'optional', 'from', 'cup', 'cups', 'tbsp',
  'tsp', 'lb', 'lbs', 'oz',
]);

/** Pantry staples — real ingredients with no meaningful place to map. */
const ECO_PANTRY_RE = /\b(salt|pepper|peppercorns?|water|oil|vinegar|sugar|flour|baking|cornstarch|bay\s*leaf|bay\s*leaves|worcestershire|cumin|paprika|turmeric|thyme|parsley|sage|rosemary|garlic\s*powder|onion\s*powder|spices?|herbs?|broth|stock)\b/i;

/** Ingredient categories not worth placing on the map. */
const ECO_PANTRY_CATS = new Set(['usually_have', 'drinks']);

/** Transparency → dot color/label, mirroring ecosystem.js's ECO_TX. */
export const ECO_TX: Record<string, { color: string; label: string }> = {
  disclosed: { color: '#2f9e7f', label: 'disclosed' },
  partial: { color: '#e0a82e', label: 'partial' },
  opaque: { color: '#d4554a', label: 'opaque' },
  unrated: { color: '#9aa0a6', label: 'unrated' },
};

export function ecoTx(source: EcoSource | null | undefined): { color: string; label: string } {
  return (source && source.transparency && ECO_TX[source.transparency]) || ECO_TX.unrated;
}

export function ecoSingular(w: string): string {
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2); // potatoes->potato
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'; // berries->berry
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2); // dishes->dish
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1); // onions->onion
  return w;
}

export function ecoTokens(s: string): string[] {
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
export function ecoMatchIngredient(item: string, sources: EcoSource[]): EcoSource | null {
  const it = ecoTokens(item);
  if (!it.length) return null;
  const itSet = new Set(it);
  let best: EcoSource | null = null;
  let bestScore = 0;
  (sources || []).forEach((s) => {
    const st = ecoTokens(s.name || '');
    if (!st.length) return;
    let overlap = 0;
    st.forEach((w) => {
      if (itSet.has(w)) overlap++;
    });
    if (!overlap) return;
    // One shared word only counts when at least one side has no competing
    // qualifier of its own ("yukon potatoes" vs "Sweet potatoes").
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
  traced: { ing: RecipeIngredient; source: EcoSource }[];
  place: { ing: RecipeIngredient }[];
  pantry: { ing: RecipeIngredient }[];
  total: number;
}

/** Full sourcing breakdown for a recipe against the placed sources. */
export function ecoRecipeSourcing(recipe: Recipe | null | undefined, sources: EcoSource[]): RecipeSourcing {
  const out: RecipeSourcing = { traced: [], place: [], pantry: [], total: 0 };
  ((recipe && recipe.ingredients) || []).forEach((ing) => {
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
