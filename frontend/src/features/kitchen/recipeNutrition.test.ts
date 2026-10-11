import { describe, expect, it } from 'vitest';
import { passesFilters, servingHighlights, sortByNutrient, type RecipeNutritionSummary } from './recipeNutrition';
import type { Recipe } from './types';

const noFlags = { hurts: [], unsure: [], histamine_high: [], histamine_moderate: [], histamine_unrated: [] };

function summary(id: string, nutrients: RecipeNutritionSummary['nutrients'], flags = {}): RecipeNutritionSummary {
  return { id, name: id, servings: 4, per: 'serving', lines: 3, counted: 3, guesses: 0, nutrients, flags: { ...noFlags, ...flags } };
}

const off = { hideHurts: false, lowHistamine: false, goodFor: null };

describe('passesFilters', () => {
  it('hides a recipe with a food that hurts only when asked', () => {
    const stew = summary('stew', {}, { hurts: ['butter'] });
    expect(passesFilters(stew, off)).toBe(true);
    expect(passesFilters(stew, { ...off, hideHurts: true })).toBe(false);
  });

  it('low histamine hides high lines but keeps moderate ones', () => {
    expect(passesFilters(summary('a', {}, { histamine_high: ['vinegar'] }), { ...off, lowHistamine: true })).toBe(false);
    expect(passesFilters(summary('b', {}, { histamine_moderate: ['onion'] }), { ...off, lowHistamine: true })).toBe(true);
  });

  it('keeps a recipe whose numbers have not loaded', () => {
    expect(passesFilters(undefined, { hideHurts: true, lowHistamine: true, goodFor: null })).toBe(true);
  });
});

describe('sortByNutrient', () => {
  it('puts the richest serving first and unknowns last', () => {
    const recipes = [{ id: 'low' }, { id: 'none' }, { id: 'high' }] as Recipe[];
    const summaries = new Map([
      ['low', summary('low', { iron: { amount: 1, unit: 'mg', percent: 5 } })],
      ['high', summary('high', { iron: { amount: 5, unit: 'mg', percent: 30 } })],
    ]);
    expect(sortByNutrient(recipes, summaries, 'iron').map((r) => r.id)).toEqual(['high', 'low', 'none']);
  });
});

describe('servingHighlights', () => {
  it('leads with energy, then the chosen nutrient, then the richest other gaps', () => {
    const one = summary('x', {
      energy: { amount: 480.4, unit: 'kcal', percent: null },
      iron: { amount: 5, unit: 'mg', percent: 27 },
      folate: { amount: 80, unit: 'µg', percent: 20 },
      calcium: { amount: 100, unit: 'mg', percent: 10 },
    });
    const gaps = [
      { key: 'calcium', label: 'Calcium' },
      { key: 'iron', label: 'Iron' },
      { key: 'folate', label: 'Folate (DFE)' },
    ];
    expect(servingHighlights(one, gaps, 'calcium')).toEqual(['480 kcal', 'calcium 10%', 'iron 27%', 'folate (dfe) 20%']);
  });
});
