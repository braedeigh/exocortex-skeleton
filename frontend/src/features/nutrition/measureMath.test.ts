import { describe, expect, it } from 'vitest';
import { formatQuarters, parseAmount, readQuantity, toHousehold, unitKey } from './measureMath';
import type { Measure } from './types';

const measure = (unit: string, grams: number, label = `1 ${unit}`, kind: Measure['kind'] = 'usda'): Measure => ({
  unit, label, grams, kind, source: 'test', url: 'https://example.org',
});
const milk = [measure('cup', 229), measure('tbsp', 15), measure('oz', 28.35, '1 oz (by weight)', 'derived')];

describe('readQuantity', () => {
  it('reads mixed numbers, fractions, decimals and glyphs', () => {
    expect(readQuantity('1 1/2 cup')?.[0]).toBe(1.5);
    expect(readQuantity('1/4 cup')?.[0]).toBe(0.25);
    expect(readQuantity('1.5cup')?.[0]).toBe(1.5);
    expect(readQuantity('1½ cup')?.[0]).toBe(1.5);
    expect(readQuantity('½ cup')?.[0]).toBe(0.5);
  });
  it('refuses text with no number in front', () => {
    expect(readQuantity('cup')).toBeNull();
  });
});

describe('unitKey', () => {
  it('folds spellings to one key, capital T a tablespoon and t a teaspoon', () => {
    expect(['cups', 'Tbsp', 'T', 't', 'fl oz', 'cloves', ''].map(unitKey)).toEqual(
      ['cup', 'tbsp', 'tbsp', 'tsp', 'floz', 'clove', 'g']);
  });
});

describe('parseAmount', () => {
  it('turns cups into grams by the food’s own USDA cup', () => {
    const reading = parseAmount('1.5 cup', milk);
    expect('grams' in reading && reading.grams).toBe(343.5);
  });
  it('treats a plain number as grams, with no measure kept', () => {
    const reading = parseAmount('150', milk);
    expect('grams' in reading && [reading.grams, reading.measure]).toEqual([150, undefined]);
  });
  it('picks between two cups by the extra words', () => {
    const mushrooms = [measure('cup', 70, '1 cup, pieces or slices'), measure('cup', 96, '1 cup, whole')];
    const reading = parseAmount('1 cup whole', mushrooms);
    expect('grams' in reading && reading.grams).toBe(96);
  });
  it('says which units the food has when the one typed is missing', () => {
    const reading = parseAmount('2 large', milk);
    expect('error' in reading && reading.error).toContain('cup, tbsp, oz');
  });
});

describe('toHousehold', () => {
  it('writes grams as cups to the nearest quarter', () => {
    expect(toHousehold(171, milk)?.text).toBe('¾ cup');
  });
  it('drops to tablespoons under a quarter cup', () => {
    expect(toHousehold(30, milk)?.text).toBe('2 tbsp');
  });
  it('uses a USDA count when the food has no volume', () => {
    expect(toHousehold(100, [measure('large', 50)])?.text).toBe('2 large');
  });
  it('gives nothing when there is no measure', () => {
    expect(toHousehold(100, [measure('oz', 28.35, '1 oz', 'derived')])).toBeNull();
  });
});

describe('formatQuarters', () => {
  it('writes wholes with a fraction glyph', () => {
    expect([0.75, 1.5, 2, 0.1].map(formatQuarters)).toEqual(['¾', '1½', '2', '0']);
  });
});
