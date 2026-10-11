import { describe, expect, it } from 'vitest';
import { avoidWords, avoidedIn, readVisitor, sortSharedBy, type SharedSummary } from './shareApi';

const summary = (token: string, percent: number | null): SharedSummary => ({
  token, name: token, servings: 4, per: 'serving', views: 0, ingredients: [], lines: 1, counted: 1,
  nutrients: { iron: { amount: 1, unit: 'mg', percent } },
  flags: { histamine_high: [], histamine_moderate: [], histamine_unrated: [] },
});

describe('the visitor filters', () => {
  it('reads foods to avoid split by commas, lowercased', () => {
    expect(avoidWords(' Onion, garlic ,, ')).toEqual(['onion', 'garlic']);
  });

  it('catches a plural ingredient by its singular word', () => {
    expect(avoidedIn(['yellow onions', 'carrots'], ['onion'])).toEqual(['yellow onions']);
  });

  it('does not catch a word inside another word', () => {
    expect(avoidedIn(['butternut squash'], ['nut'])).toEqual([]);
  });

  it('sorts richest first in the chosen nutrient, unknowns last', () => {
    const sorted = sortSharedBy([summary('a', 10), summary('b', null), summary('c', 40)], 'iron');
    expect(sorted.map((s) => s.token)).toEqual(['c', 'a', 'b']);
  });

  it('turns an unreadable age into none given', () => {
    expect(readVisitor({ sex: 'robot', age: '3x' })).toEqual({ sex: 'both', age: null });
  });
});
