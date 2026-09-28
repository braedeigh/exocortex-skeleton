import { describe, expect, it } from 'vitest';
import { matchingFoodIds, matchingSourceIds, normalizeQuery, proposalMatches, textMatches } from './foodSearch';
import type { EcoProposal } from './proposals';
import type { EcoFood, EcoRecipe, EcoSource } from './types';

const foods: EcoFood[] = [
  { id: 1, name: 'kale', products: [], source_ids: ['farm'] },
  { id: 2, name: 'onion', products: [{ id: 9, name: 'Vidalia sweet onion' }], source_ids: [] },
  { id: 3, name: 'rice', products: [], source_ids: ['mill'] },
];
const recipes: EcoRecipe[] = [{ id: 'r1', name: 'Kale soup', ingredients: [{ item: 'onion', food_id: 2 }] }];
const sources: EcoSource[] = [
  { id: 'farm', name: 'Green Acres', links: [{ id: 1, food_id: 1 }] },
  { id: 'mill', name: 'River Mill', note: 'stone ground', links: [{ id: 2, food_id: 3 }] },
];

describe('foodSearch', () => {
  it('treats blank words as no search', () => {
    expect(normalizeQuery('  ')).toBe('');
    expect(textMatches('', 'anything')).toBe(true);
    expect(matchingSourceIds('', sources, foods, recipes)).toBeNull();
  });

  it('matches a food by a product name', () => {
    expect(matchingFoodIds('vidalia', foods, recipes)).toEqual(new Set([2]));
  });

  it('brings a matching recipe’s foods along', () => {
    expect(matchingFoodIds('soup', foods, recipes)).toEqual(new Set([2]));
  });

  it('finds sources through the foods linked to them', () => {
    expect(matchingSourceIds('kale', sources, foods, recipes)).toEqual(new Set(['farm']));
  });

  it('finds a source by its own note', () => {
    expect(matchingSourceIds('stone', sources, foods, recipes)).toEqual(new Set(['mill']));
  });

  it('matches a suggestion by the food it is for', () => {
    const proposal = { food_id: 1, name: 'Some farm', summary: null, usda_commodity: null } as EcoProposal;
    expect(proposalMatches('kale', proposal, matchingFoodIds('kale', foods, recipes))).toBe(true);
    expect(proposalMatches('rice', proposal, matchingFoodIds('rice', foods, recipes))).toBe(false);
  });
});
