import { describe, expect, it } from 'vitest';
import { barShare, formatAmount, groupOf, groupRows } from './nutrientMath';
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
