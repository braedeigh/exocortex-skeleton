import { describe, expect, it } from 'vitest';
import { ecoRecipeSourcing } from '../ecosystem/ecoMatch';
import type { EcoRecipe, EcoSource } from '../ecosystem/types';
import { traceSummary } from './traceSummary';

const sources: EcoSource[] = [
  { id: 'rice', name: 'Lundberg rice', links: [{ id: 1, food_id: 10 }] },
  { id: 'onion', name: 'Onions', links: [] },
];

const recipe: EcoRecipe = {
  id: 'r1',
  name: 'Rice bowl',
  ingredients: [
    { item: 'brown rice', food_id: 10 },
    { item: 'yellow onion', food_id: 11 },
    { item: 'mystery thing', food_id: null },
    { item: 'salt', food_id: 12 },
    { item: 'olive oil', food_id: 13 },
    { item: '  ' },
  ],
};

describe('traceSummary', () => {
  it('counts traced out of traceable, leaving pantry staples out', () => {
    expect(traceSummary(ecoRecipeSourcing(recipe, sources)).text).toBe('1 of 3 traced');
  });

  it('says 0 of 0 for a recipe of only staples', () => {
    const staples: EcoRecipe = { id: 'r2', name: 'Brine', ingredients: [{ item: 'salt' }, { item: 'water' }] };
    expect(traceSummary(ecoRecipeSourcing(staples, sources))).toEqual({ traced: 0, traceable: 0, text: '0 of 0 traced' });
  });
});
