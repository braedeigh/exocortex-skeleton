import { describe, expect, it } from 'vitest';
import { ecoMatchIngredient, ecoRecipeSourceIds, ecoRecipeSourcing, ecoSingular, ecoTokens } from './ecoMatch';
import type { EcoRecipe, EcoSource } from './types';

function src(id: string, name: string): EcoSource {
  return { id, name };
}

describe('ecoSingular', () => {
  it('handles -oes plurals', () => {
    expect(ecoSingular('potatoes')).toBe('potato');
    expect(ecoSingular('tomatoes')).toBe('tomato');
  });
  it('handles -ies plurals', () => {
    expect(ecoSingular('berries')).toBe('berry');
  });
  it('handles sibilant -es plurals', () => {
    expect(ecoSingular('dishes')).toBe('dish');
  });
  it('handles plain -s plurals but not -ss', () => {
    expect(ecoSingular('onions')).toBe('onion');
    expect(ecoSingular('grass')).toBe('grass');
  });
  it('leaves short words alone', () => {
    expect(ecoSingular('gas')).toBe('gas');
  });
});

describe('ecoTokens', () => {
  it('strips vendor/prep stop words and singularizes', () => {
    expect(ecoTokens('HEB chuck roast')).toEqual(['chuck', 'roast']);
    expect(ecoTokens('yellow onions')).toEqual(['yellow', 'onion']);
    expect(ecoTokens('HEB organic ground beef')).toEqual(['beef']);
  });
  it('drops single letters left by punctuation ("h e b" debris)', () => {
    expect(ecoTokens('h e b milk')).toEqual(['milk']);
  });
  it('splits hyphenated words', () => {
    expect(ecoTokens('sweet-potatoes')).toEqual(['sweet', 'potato']);
  });
  it('is empty for empty/nullish input', () => {
    expect(ecoTokens('')).toEqual([]);
    expect(ecoTokens(null)).toEqual([]);
  });
});

describe('ecoMatchIngredient', () => {
  it('matches through vendor prefixes and plurals', () => {
    const onions = src('a', 'Onions');
    expect(ecoMatchIngredient('yellow onion', [onions])).toBe(onions);
  });
  it('matches an exact multi-word name', () => {
    const roast = src('a', 'HEB chuck roast');
    expect(ecoMatchIngredient('chuck roast', [roast])).toBe(roast);
  });
  it('guards against one generic shared word when both sides carry qualifiers', () => {
    const sweet = src('a', 'Sweet potatoes');
    expect(ecoMatchIngredient('yukon potatoes', [sweet])).toBeNull();
  });
  it('still matches a single-word ingredient to a qualified source', () => {
    const yukon = src('a', 'Yukon potatoes');
    expect(ecoMatchIngredient('potatoes', [yukon])).toBe(yukon);
  });
  it('prefers the tighter name on ties', () => {
    const loose = src('a', 'Beef tallow candles');
    const tight = src('b', 'Beef');
    expect(ecoMatchIngredient('beef', [loose, tight])).toBe(tight);
  });
  it('returns null when nothing overlaps', () => {
    expect(ecoMatchIngredient('quinoa', [src('a', 'Onions')])).toBeNull();
  });
});

describe('ecoRecipeSourcing', () => {
  // Onions is linked to food 1; the chicken source to a product of food 2.
  const sources: EcoSource[] = [
    { ...src('on', 'Onions'), links: [{ id: 1, food_id: 1, food_name: 'onion' }] },
    {
      ...src('ch', 'HEB whole chicken'),
      links: [{ id: 2, food_id: 2, food_name: 'chicken', product_id: 9, product_name: 'HEB ROASTER' }],
    },
    src('ca', 'Carrots'),
  ];
  const recipe: EcoRecipe = {
    id: 'r1',
    name: 'Soup',
    ingredients: [
      { item: 'yellow onion', food_id: 1 },
      { item: 'carrots', food_id: 3 },
      { item: 'salt' },
      { item: 'chicken broth', food_id: 2 },
      { item: 'sparkling water', category: 'drinks' },
      { item: '' },
    ],
  };

  it('traces by link, sets aside pantry, and counts only real items', () => {
    const s = ecoRecipeSourcing(recipe, sources);
    expect(s.total).toBe(5);
    expect(s.traced.map((t) => [t.ing.item, t.sources.map((x) => x.id)])).toEqual([['yellow onion', ['on']]]);
    expect(s.pantry.map((p) => p.ing.item)).toEqual(['salt', 'chicken broth', 'sparkling water']);
  });

  it('a same-named but unlinked source is only a suggestion, never a trace', () => {
    const s = ecoRecipeSourcing(recipe, sources);
    expect(s.place.map((p) => [p.ing.item, p.suggestion?.id])).toEqual([['carrots', 'ca']]);
  });

  it('a product link traces its food', () => {
    const s = ecoRecipeSourcing({ id: 'r', name: 'x', ingredients: [{ item: 'whole chicken', food_id: 2 }] }, sources);
    expect(s.traced[0].sources.map((x) => x.id)).toEqual(['ch']);
  });

  it('pantry categories (usually_have) are pantry even when linked', () => {
    const s = ecoRecipeSourcing(
      { id: 'r', name: 'x', ingredients: [{ item: 'yellow onion', food_id: 1, category: 'usually_have' }] },
      sources,
    );
    expect(s.pantry).toHaveLength(1);
    expect(s.traced).toEqual([]);
  });
});

describe('ecoRecipeSourceIds', () => {
  it('collects the linked source ids as a set', () => {
    const sources: EcoSource[] = [
      { ...src('on', 'Onions'), links: [{ id: 1, food_id: 1 }] },
      { ...src('ch', 'Chicken'), links: [{ id: 2, food_id: 2 }] },
    ];
    const recipe: EcoRecipe = {
      id: 'r',
      name: 'x',
      ingredients: [{ item: 'onions', food_id: 1 }, { item: 'whole chicken', food_id: 2 }, { item: 'onion', food_id: 1 }],
    };
    expect(ecoRecipeSourceIds(recipe, sources)).toEqual(new Set(['on', 'ch']));
  });
});
