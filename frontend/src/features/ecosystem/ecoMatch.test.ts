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
  const sources = [src('on', 'Onions'), src('ch', 'HEB whole chicken')];
  const recipe: EcoRecipe = {
    id: 'r1',
    name: 'Soup',
    ingredients: [
      { item: 'yellow onion' },
      { item: 'carrots' },
      { item: 'salt' },
      { item: 'chicken broth' },
      { item: 'sparkling water', category: 'drinks' },
      { item: '' },
    ],
  };

  it('classifies traced / place / pantry and counts only real items', () => {
    const s = ecoRecipeSourcing(recipe, sources);
    expect(s.total).toBe(5);
    expect(s.traced.map((t) => t.ing.item)).toEqual(['yellow onion']);
    expect(s.traced[0].source.id).toBe('on');
    expect(s.place.map((p) => p.ing.item)).toEqual(['carrots']);
    expect(s.pantry.map((p) => p.ing.item)).toEqual(['salt', 'chicken broth', 'sparkling water']);
  });

  it('pantry staples win over matching (chicken broth never traces to the chicken source)', () => {
    const s = ecoRecipeSourcing({ id: 'r', name: 'x', ingredients: [{ item: 'chicken broth' }] }, sources);
    expect(s.traced).toEqual([]);
    expect(s.pantry).toHaveLength(1);
  });

  it('pantry categories (usually_have) are pantry regardless of name', () => {
    const s = ecoRecipeSourcing(
      { id: 'r', name: 'x', ingredients: [{ item: 'yellow onion', category: 'usually_have' }] },
      sources,
    );
    expect(s.pantry).toHaveLength(1);
    expect(s.traced).toEqual([]);
  });
});

describe('ecoRecipeSourceIds', () => {
  it('collects the matched source ids as a set', () => {
    const sources = [src('on', 'Onions'), src('ch', 'HEB whole chicken')];
    const recipe: EcoRecipe = {
      id: 'r',
      name: 'x',
      ingredients: [{ item: 'onions' }, { item: 'whole chicken' }, { item: 'onion' }],
    };
    expect(ecoRecipeSourceIds(recipe, sources)).toEqual(new Set(['on', 'ch']));
  });
});
