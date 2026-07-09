import { describe, expect, it } from 'vitest';
import {
  classifyAdd,
  filterCatalogItems,
  groupChips,
  groupGroceryItems,
  householdItems,
  kitchenCats,
  nextSafetyTag,
  prefixRank,
} from './catalogHelpers';

describe('kitchenCats', () => {
  it('appends household to the order and labels without mutating input meaning', () => {
    const { categoryOrder, categoryLabels } = kitchenCats(['fruit', 'other']);
    expect(categoryOrder).toEqual(['fruit', 'other', 'household']);
    expect(categoryLabels.household).toBe('Household');
  });

  it('does not duplicate household when already present', () => {
    const { categoryOrder } = kitchenCats(['household', 'other']);
    expect(categoryOrder.filter((c) => c === 'household')).toHaveLength(1);
  });

  it('falls back to the default order when none stored', () => {
    const { categoryOrder } = kitchenCats(undefined);
    expect(categoryOrder[0]).toBe('vegetables');
    expect(categoryOrder).toContain('household');
  });
});

describe('prefixRank', () => {
  it('ranks name-prefix before word-prefix before substring', () => {
    expect(prefixRank('broccoli', 'bro')).toBe(0);
    expect(prefixRank('purple broccoli', 'bro')).toBe(1);
    expect(prefixRank('hashbrowns', 'bro')).toBe(2);
  });

  it('treats hyphens as word boundaries', () => {
    expect(prefixRank('gluten-free bread', 'free')).toBe(1);
  });
});

describe('filterCatalogItems', () => {
  const known = { broccoli: 'vegetables', bread: 'grains', sponge: 'household', hashbrowns: 'other' };
  const counts = { bread: 5, broccoli: 2 };

  it('excludes household items', () => {
    const names = filterCatalogItems(known, counts, '').map((i) => i.name);
    expect(names).not.toContain('sponge');
  });

  it('sorts by count desc then alpha with no filter', () => {
    const names = filterCatalogItems(known, counts, '').map((i) => i.name);
    expect(names).toEqual(['bread', 'broccoli', 'hashbrowns']);
  });

  it('ranks prefix matches first when filtering', () => {
    const names = filterCatalogItems(known, counts, 'bro').map((i) => i.name);
    expect(names).toEqual(['broccoli', 'hashbrowns']);
  });
});

describe('householdItems', () => {
  it('returns only household entries alphabetically', () => {
    const items = householdItems({ sponge: 'household', apple: 'fruit', bags: 'household' }, {});
    expect(items.map((i) => i.name)).toEqual(['bags', 'sponge']);
  });
});

describe('groupChips', () => {
  const items = [
    { name: 'bread', cat: 'grains', count: 5 },
    { name: 'apple', cat: 'fruit', count: 0 },
    { name: 'zucchini', cat: 'vegetables', count: 0 },
  ];

  it('alpha mode is a flat A–Z list', () => {
    const g = groupChips(items, 'alpha', ['vegetables', 'fruit', 'grains'], {});
    expect(g.alpha!.map((i) => i.name)).toEqual(['apple', 'bread', 'zucchini']);
  });

  it('both mode splits most-bought from the alphabetical rest', () => {
    const g = groupChips(items, 'both', ['vegetables', 'fruit', 'grains'], {});
    expect(g.mostBought!.map((i) => i.name)).toEqual(['bread']);
    expect(g.restAlpha!.map((i) => i.name)).toEqual(['apple', 'zucchini']);
  });

  it('frequency mode groups zero-count items by ordered category', () => {
    const g = groupChips(items, 'frequency', ['vegetables', 'fruit', 'grains'], { fruit: 'Fruit' });
    expect(g.mostBought!.map((i) => i.name)).toEqual(['bread']);
    expect(g.byCategory!.map((c) => c.cat)).toEqual(['vegetables', 'fruit']);
    expect(g.byCategory![1].label).toBe('Fruit');
  });

  it('frequency mode appends unknown categories at the end', () => {
    const g = groupChips([{ name: 'thing', cat: 'mystery', count: 0 }], 'frequency', ['fruit'], {});
    expect(g.byCategory!.map((c) => c.cat)).toEqual(['mystery']);
  });
});

describe('groupGroceryItems', () => {
  const order = ['vegetables', '@aisles', 'dairy'];
  const labels = { vegetables: 'Vegetables', dairy: 'Dairy' };

  it('buckets by category in order, unknown categories sink to the bottom', () => {
    const groups = groupGroceryItems(
      [
        { name: 'Milk', category: 'dairy' },
        { name: 'Kale', category: 'vegetables' },
        { name: 'Widget', category: 'mystery' },
      ],
      order,
      labels,
      {},
    );
    expect(groups.map((g) => g.label)).toEqual(['Vegetables', 'Dairy', 'mystery']);
  });

  it('puts aisle items under Aisle N at the @aisles slot, ordered by number', () => {
    const groups = groupGroceryItems(
      [
        { name: 'Kale', category: 'vegetables' },
        { name: 'Chips', category: 'snacks' },
        { name: 'Salsa', category: 'other' },
        { name: 'Milk', category: 'dairy' },
      ],
      order,
      labels,
      { chips: 12, salsa: 3 },
    );
    expect(groups.map((g) => g.label)).toEqual(['Vegetables', 'Aisle 3', 'Aisle 12', 'Dairy']);
  });

  it('falls back to category when there is no @aisles slot', () => {
    const groups = groupGroceryItems(
      [{ name: 'Chips', category: 'snacks' }],
      ['snacks'],
      { snacks: 'Snacks' },
      { chips: 12 },
    );
    expect(groups.map((g) => g.label)).toEqual(['Snacks']);
  });

  it('defaults missing category to other', () => {
    const groups = groupGroceryItems([{ name: 'Egg' }], ['other'], { other: 'Other' }, {});
    expect(groups[0].label).toBe('Other');
  });
});

describe('classifyAdd', () => {
  const data = {
    kitchen_list: [{ name: 'Milk' }],
    kitchen_known_items: { kale: 'vegetables' },
  };

  it('detects items already on the list case-insensitively', () => {
    expect(classifyAdd('milk', data)).toBe('already-on-list');
  });

  it('known catalog items add directly', () => {
    expect(classifyAdd('Kale', data)).toBe('known');
  });

  it('unknown items need the category picker', () => {
    expect(classifyAdd('dragonfruit', data)).toBe('unknown');
  });
});

describe('nextSafetyTag', () => {
  it('cycles untagged → safe → suspect → inflammatory → untagged', () => {
    expect(nextSafetyTag('')).toBe('safe');
    expect(nextSafetyTag('safe')).toBe('suspect');
    expect(nextSafetyTag('suspect')).toBe('inflammatory');
    expect(nextSafetyTag('inflammatory')).toBe('');
  });
});
