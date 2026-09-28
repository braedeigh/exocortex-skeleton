import { describe, expect, it } from 'vitest';
import { barShare, dayTarget, fdcFoodUrl, foodGifts, formatAmount, groupOf, groupRows } from './nutrientMath';
import type { NutrientRow } from './types';

function row(key: string, statuses: Record<string, string>): NutrientRow {
  return {
    key,
    label: key,
    unit: 'mg',
    amount: 1,
    low: 1,
    high: 1,
    missing: [],
    by_sex: Object.fromEntries(Object.entries(statuses).map(([sex, status]) => [sex, { status }])),
  } as NutrientRow;
}

describe('groupOf', () => {
  it('puts a row under for either sex in Below target', () => {
    expect(groupOf(row('iron', { female: 'under', male: 'met' }))).toBe('under');
  });

  it('puts over ahead of under', () => {
    expect(groupOf(row('zinc', { female: 'under', male: 'over' }))).toBe('over');
  });

  it('treats a row with no targets as untargeted', () => {
    expect(groupOf(row('energy', { female: 'no_target' }))).toBe('untargeted');
  });
});

describe('groupRows', () => {
  it('drops empty groups and keeps page order', () => {
    const groups = groupRows([row('a', { female: 'met' }), row('b', { female: 'under' })]);
    expect(groups.map((entry) => entry.group)).toEqual(['under', 'met']);
  });
});

describe('formatAmount', () => {
  it('writes big numbers whole with commas and small ones with two places', () => {
    expect([formatAmount(1944.6), formatAmount(17.66), formatAmount(0.452)]).toEqual(['1,945', '17.7', '0.45']);
  });
});

describe('barShare', () => {
  it('caps the bar at 150%', () => {
    expect(barShare(900, { status: 'met', target: { value: 300, kind: 'rda', source: '' } })).toBe(1.5);
  });

  it('has no bar without a target', () => {
    expect(barShare(900, { status: 'no_target' })).toBeNull();
  });
});

describe('fdcFoodUrl', () => {
  it('points at the food’s own FoodData Central page', () => {
    expect(fdcFoodUrl(168421)).toBe('https://fdc.nal.usda.gov/food-details/168421/nutrients');
  });
});

// A day row with targets per sex and per-food shares, for the food-by-food view.
function dayRow(key: string, amount: number, targets: Record<string, number>, shares: [number, string, number][]): NutrientRow {
  return {
    key,
    label: key,
    unit: 'mg',
    amount,
    low: amount,
    high: amount,
    missing: [],
    by_food: shares.map(([fdc_id, label, share]) => ({ fdc_id, label, meals: [], amount: share })),
    by_sex: Object.fromEntries(
      Object.entries(targets).map(([sex, value]) => [sex, { status: 'under', target: { value, kind: 'rda', source: '' } }]),
    ),
  } as NutrientRow;
}

describe('dayTarget', () => {
  it('takes the higher floor when both sexes are shown', () => {
    expect(dayTarget(dayRow('iron', 10, { female: 18, male: 8 }, []), ['female', 'male'])).toBe(18);
  });
});

describe('foodGifts', () => {
  const rows = [
    dayRow('calcium', 400, { female: 1000 }, [[1, 'kale', 100], [2, 'milk', 300]]),
    dayRow('iron', 10, { female: 18 }, [[1, 'kale', 9], [2, 'milk', 1]]),
  ];

  it('turns the day into what each food gives, as share of day and of target', () => {
    const kale = foodGifts(rows, ['female']).find((food) => food.fdc_id === 1)!;
    expect(kale.gifts.map((gift) => [gift.key, gift.shareOfDay, gift.percentOfTarget])).toEqual([
      ['iron', 0.9, 50],
      ['calcium', 0.25, 10],
    ]);
  });

  it('leaves out nutrients a food gives none of', () => {
    const zero = [dayRow('zinc', 5, { female: 8 }, [[1, 'kale', 5], [2, 'milk', 0]])];
    expect(foodGifts(zero, ['female']).map((food) => food.label)).toEqual(['kale']);
  });
});
