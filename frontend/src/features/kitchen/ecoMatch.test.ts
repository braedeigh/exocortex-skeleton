import { describe, expect, it } from 'vitest';
import { ecoMatchIngredient, ecoRecipeSourcing, ecoSingular, ecoTokens } from './ecoMatch';
import type { EcoSource } from './types';

const sources: EcoSource[] = [
  { id: 's1', name: 'Onions' },
  { id: 's2', name: 'HEB chuck roast' },
  { id: 's3', name: 'Sweet potatoes' },
];

describe('ecoSingular', () => {
  it('handles common plural shapes', () => {
    expect(ecoSingular('potatoes')).toBe('potato');
    expect(ecoSingular('berries')).toBe('berry');
    expect(ecoSingular('dishes')).toBe('dish');
    expect(ecoSingular('onions')).toBe('onion');
    expect(ecoSingular('grass')).toBe('grass');
  });
});

describe('ecoTokens', () => {
  it('strips stop-words, singularizes, drops single letters', () => {
    expect(ecoTokens('HEB Organic Yellow Onions')).toEqual(['yellow', 'onion']);
    expect(ecoTokens('2 cups of water')).toEqual(['water']);
  });
});

describe('ecoMatchIngredient', () => {
  it('matches through brand/prep noise', () => {
    expect(ecoMatchIngredient('yellow onion', sources)?.id).toBe('s1');
    expect(ecoMatchIngredient('chuck roast', sources)?.id).toBe('s2');
  });

  it('refuses a single generic shared word when both sides carry qualifiers', () => {
    // "yukon potatoes" vs "Sweet potatoes" — one overlapping head noun only
    expect(ecoMatchIngredient('yukon potatoes', sources)).toBeNull();
  });

  it('returns null with no overlap', () => {
    expect(ecoMatchIngredient('flour tortillas', sources)).toBeNull();
  });
});

describe('ecoRecipeSourcing', () => {
  it('buckets traced / place / pantry', () => {
    const recipe = {
      id: 'r1',
      ingredients: [
        { item: 'yellow onion' },
        { item: 'salt' },
        { item: 'chicken broth' }, // pantry regex wins over matching
        { item: 'rutabaga' },
        { item: 'sparkling water', category: 'drinks' }, // pantry category
        { item: '' }, // ignored
      ],
    };
    const s = ecoRecipeSourcing(recipe, sources);
    expect(s.total).toBe(5);
    expect(s.traced.map((t) => t.source.id)).toEqual(['s1']);
    expect(s.place.map((p) => p.ing.item)).toEqual(['rutabaga']);
    expect(s.pantry).toHaveLength(3);
  });
});
