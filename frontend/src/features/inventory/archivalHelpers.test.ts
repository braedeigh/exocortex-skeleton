import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  allCategories,
  allMaterials,
  archPhotoUrl,
  clothingSubcategories,
  emptyFilters,
  emptyMessage,
  getFilteredItems,
  knownArchCategories,
  materialsText,
  matchesFilters,
  matchesSearch,
  seededShuffle,
  sortArchivals,
} from './archivalHelpers';
import type { ArchivalItem } from './types';

const items: ArchivalItem[] = [
  {
    id: '1',
    name: 'Wool sweater',
    category: 'clothing',
    subcategory: 'tops',
    secondhand: 'secondhand',
    gifted: 'no',
    materials: [{ material: 'Wool', percentage: 100 }],
    created_at: '2026-01-01T10:00:00',
  },
  {
    id: '2',
    name: 'Locket',
    category: 'jewelry',
    origin: 'from grandma',
    secondhand: 'unknown',
    gifted: 'yes',
    created_at: '2026-03-01T10:00:00',
  },
  {
    id: '3',
    name: 'Linen pants',
    category: 'clothing',
    subcategory: '',
    secondhand: 'new',
    gifted: 'no',
    materials: [{ material: 'Linen', percentage: null }],
    created_at: '2026-02-01T10:00:00',
  },
];

describe('matchesSearch', () => {
  it('matches across name/description/origin/category/subcategory, case-insensitive', () => {
    expect(matchesSearch(items[1], 'grandma')).toBe(true);
    expect(matchesSearch(items[0], 'TOPS')).toBe(true);
    expect(matchesSearch(items[0], 'jewelry')).toBe(false);
  });
  it('empty/whitespace query matches everything', () => {
    expect(matchesSearch(items[0], '   ')).toBe(true);
  });
});

describe('matchesFilters', () => {
  it('filters by category', () => {
    const f = { ...emptyFilters(), categories: ['jewelry'] };
    expect(matchesFilters(items[1], f)).toBe(true);
    expect(matchesFilters(items[0], f)).toBe(false);
  });
  it('subcategory filter only applies to clothing, with an uncategorized bucket', () => {
    const f = { ...emptyFilters(), subcategories: ['uncategorized'] };
    expect(matchesFilters(items[2], f)).toBe(true); // clothing, no subcategory
    expect(matchesFilters(items[0], f)).toBe(false); // clothing, tops
    expect(matchesFilters(items[1], f)).toBe(true); // jewelry: rule doesn't apply
  });
  it('filters by source and gifted', () => {
    expect(matchesFilters(items[0], { ...emptyFilters(), sources: ['secondhand'] })).toBe(true);
    expect(matchesFilters(items[2], { ...emptyFilters(), sources: ['secondhand'] })).toBe(false);
    expect(matchesFilters(items[1], { ...emptyFilters(), gifted: true })).toBe(true);
    expect(matchesFilters(items[1], { ...emptyFilters(), gifted: false })).toBe(false);
  });
  it('materials filter is an OR across selected materials', () => {
    const f = { ...emptyFilters(), materials: ['Wool', 'Silk'] };
    expect(matchesFilters(items[0], f)).toBe(true);
    expect(matchesFilters(items[2], f)).toBe(false);
  });
  it('exclude skips exactly one group (chip-count semantics)', () => {
    const f = { ...emptyFilters(), categories: ['jewelry'], gifted: true };
    // excluded category: only the gifted filter applies
    expect(matchesFilters(items[1], f, 'category')).toBe(true);
    expect(matchesFilters(items[0], f, 'category')).toBe(false); // still fails gifted
    // excluded gifted: only category applies
    expect(matchesFilters(items[0], f, 'gifted')).toBe(false);
  });
});

describe('getFilteredItems / activeFilterCount', () => {
  it('combines search and filters', () => {
    const f = { ...emptyFilters(), categories: ['clothing'] };
    expect(getFilteredItems(items, 'linen', f).map((i) => i.id)).toEqual(['3']);
  });
  it('counts every active filter (gifted counts as one)', () => {
    expect(activeFilterCount(emptyFilters())).toBe(0);
    expect(
      activeFilterCount({ categories: ['a'], subcategories: ['b'], sources: ['new'], gifted: false, materials: ['Wool'] }),
    ).toBe(5);
  });
});

describe('sortArchivals', () => {
  it('newest is the default (created_at desc)', () => {
    expect(sortArchivals(items, 'newest', 1).map((i) => i.id)).toEqual(['2', '3', '1']);
  });
  it('oldest is created_at asc', () => {
    expect(sortArchivals(items, 'oldest', 1).map((i) => i.id)).toEqual(['1', '3', '2']);
  });
  it('az sorts by name', () => {
    expect(sortArchivals(items, 'az', 1).map((i) => i.name)).toEqual([
      'Linen pants',
      'Locket',
      'Wool sweater',
    ]);
  });
  it('random is stable for a given seed and changes with it', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `n${i}` }));
    const a = sortArchivals(many, 'random', 7).map((i) => i.id);
    const b = sortArchivals(many, 'random', 7).map((i) => i.id);
    const c = sortArchivals(many, 'random', 8).map((i) => i.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect([...a].sort()).toEqual([...c].sort());
  });
  it('does not mutate its input', () => {
    const copy = [...items];
    sortArchivals(items, 'az', 1);
    expect(items).toEqual(copy);
  });
});

describe('seededShuffle', () => {
  it('is a permutation', () => {
    const arr = [1, 2, 3, 4, 5];
    const out = seededShuffle(arr, 3);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('derived lists', () => {
  it('allCategories / allMaterials / clothingSubcategories', () => {
    expect(allCategories(items)).toEqual(['clothing', 'jewelry']);
    expect(allMaterials(items)).toEqual(['Linen', 'Wool']);
    expect(clothingSubcategories(items)).toEqual(['tops']);
  });
  it('knownArchCategories seeds the defaults', () => {
    expect(knownArchCategories([])).toEqual(['bedding', 'clothing', 'jewelry', 'other', 'sentimental']);
    expect(knownArchCategories(items)).toContain('jewelry');
  });
});

describe('formatting helpers', () => {
  it('materialsText round-trips percentages and bare names', () => {
    expect(materialsText({ materials: [{ material: 'Cotton', percentage: 80 }, { material: 'Silk', percentage: null }] })).toBe(
      'Cotton 80, Silk',
    );
    expect(materialsText({})).toBe('');
  });
  it('archPhotoUrl uses the first photo, url-encoded', () => {
    expect(archPhotoUrl({ photos: [{ id: 'p', filename: 'a b.jpg' }] })).toBe('/archivals/photo/a%20b.jpg');
    expect(archPhotoUrl({ photos: [] })).toBe('');
  });
  it('emptyMessage distinguishes empty catalog from empty filter result', () => {
    expect(emptyMessage(0)).toBe('Nothing catalogued yet — add your first thing');
    expect(emptyMessage(5)).toBe('Nothing matches');
  });
});
