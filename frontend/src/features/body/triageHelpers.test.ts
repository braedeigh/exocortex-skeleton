import { describe, expect, it } from 'vitest';
import { agoLabel, displayName, taggedFoods, triageMeta, untaggedFoods } from './triageHelpers';

describe('untaggedFoods', () => {
  it('lists only untagged catalog items, most-bought first then alphabetical', () => {
    const known = { kale: 'produce', oats: 'grains', beans: 'pantry', rice: 'grains' };
    const tags = { kale: 'safe' as const };
    const counts = { beans: 5, oats: 5 };
    const items = untaggedFoods(known, tags, counts, { beans: '2026-07-01' });
    expect(items.map((i) => i.name)).toEqual(['beans', 'oats', 'rice']);
    expect(items[0]).toEqual({ name: 'beans', count: 5, lastBought: '2026-07-01' });
    expect(items[2]).toEqual({ name: 'rice', count: 0, lastBought: null });
  });
  it('degrades to alphabetical when counts are absent (body payload today)', () => {
    const items = untaggedFoods({ b: 'x', a: 'y' }, {}, undefined, undefined);
    expect(items.map((i) => i.name)).toEqual(['a', 'b']);
  });
});

describe('taggedFoods', () => {
  it('filters by tag, alphabetical', () => {
    const tags = { kale: 'safe', beans: 'suspect', rice: 'safe', okra: 'inflammatory' } as const;
    expect(taggedFoods(tags, 'safe')).toEqual(['kale', 'rice']);
    expect(taggedFoods(tags, 'inflammatory')).toEqual(['okra']);
    expect(taggedFoods(undefined, 'suspect')).toEqual([]);
  });
});

describe('agoLabel / triageMeta', () => {
  const today = '2026-07-09';
  it('formats recency in the old buckets', () => {
    expect(agoLabel('2026-07-09', today)).toBe('today');
    expect(agoLabel('2026-07-08', today)).toBe('yesterday');
    expect(agoLabel('2026-07-01', today)).toBe('8d ago');
    expect(agoLabel('2026-05-09', today)).toBe('9w ago');
  });
  it('joins count and recency with a middot, omitting missing parts', () => {
    expect(triageMeta({ name: 'beans', count: 3, lastBought: '2026-07-07' }, today)).toBe('bought 3× · 2d ago');
    expect(triageMeta({ name: 'beans', count: 0, lastBought: null }, today)).toBe('');
  });
});

describe('displayName', () => {
  it('capitalizes the first letter only', () => {
    expect(displayName('white rice')).toBe('White rice');
    expect(displayName('')).toBe('');
  });
});
