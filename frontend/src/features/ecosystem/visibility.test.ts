import { describe, expect, it } from 'vitest';
import { computeVisibleIds } from './visibility';
import type { EcoRecipe, EcoSource } from './types';

const sources: EcoSource[] = [
  { id: 'on', name: 'Onions', transparency: 'disclosed' },
  { id: 'be', name: 'Beef', transparency: 'partial' },
  { id: 'mi', name: 'Milk', transparency: 'weird-old-value' }, // normalizes to unrated
];

const recipe: EcoRecipe = {
  id: 'r',
  name: 'Soup',
  ingredients: [{ item: 'onion' }, { item: 'beef' }],
};

describe('computeVisibleIds', () => {
  it('returns null (show all) when nothing filters', () => {
    expect(computeVisibleIds(sources, '', null, null)).toBeNull();
  });

  it('filters by transparency chip, treating unknown values as unrated', () => {
    expect(computeVisibleIds(sources, 'partial', null, null)).toEqual(new Set(['be']));
    expect(computeVisibleIds(sources, 'unrated', null, null)).toEqual(new Set(['mi']));
  });

  it('filters by a traced recipe', () => {
    expect(computeVisibleIds(sources, '', recipe, null)).toEqual(new Set(['on', 'be']));
  });

  it('stacks (intersects) chip ∩ recipe ∩ solo', () => {
    expect(computeVisibleIds(sources, 'partial', recipe, null)).toEqual(new Set(['be']));
    expect(computeVisibleIds(sources, 'partial', recipe, 'be')).toEqual(new Set(['be']));
    // the solo item is outside the chip's set → intersection is empty
    expect(computeVisibleIds(sources, 'disclosed', null, 'be')).toEqual(new Set());
  });

  it('solo alone narrows to the one source', () => {
    expect(computeVisibleIds(sources, '', null, 'mi')).toEqual(new Set(['mi']));
  });
});
