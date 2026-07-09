import { describe, expect, it } from 'vitest';
import {
  allGroupsValid,
  bucketPushAll,
  buildSendRows,
  filterSortRecipes,
  ingStockingStatus,
  ingStoreCategory,
  initialPicks,
  recipeMemberLabel,
  walkRecipeChain,
} from './recipeHelpers';
import type { Recipe } from './types';

describe('ingredient schema-tolerant readers', () => {
  it('reads stocking status from the new field or the legacy category slot', () => {
    expect(ingStockingStatus({ stocking_status: 'n_a' })).toBe('n_a');
    expect(ingStockingStatus({ category: 'usually_have' })).toBe('usually_have');
    expect(ingStockingStatus({ category: 'dairy' })).toBe('');
  });

  it('store category falls back to other when the slot held a status', () => {
    expect(ingStoreCategory({ category: 'n_a' })).toBe('other');
    expect(ingStoreCategory({ category: 'dairy' })).toBe('dairy');
    expect(ingStoreCategory({})).toBe('other');
  });
});

describe('filterSortRecipes', () => {
  const recipes: Recipe[] = [
    { id: 'a', name: 'Beta stew', created: '2026-01-02', prep_min: 30, cook_min: 60, ingredients: [{ item: 'carrots' }] },
    { id: 'b', name: 'Alpha soup', created: '2026-03-01', prep_min: 5, cook_min: 10 },
    { id: 'c', name: 'Old one', is_archived: true },
  ];

  it('hides archived recipes', () => {
    expect(filterSortRecipes(recipes, '', 'name').map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('searches names and ingredients', () => {
    expect(filterSortRecipes(recipes, 'carrot', 'name').map((r) => r.id)).toEqual(['a']);
  });

  it('sorts by added (newest first) and total time (shortest first)', () => {
    expect(filterSortRecipes(recipes, '', 'added').map((r) => r.id)).toEqual(['b', 'a']);
    expect(filterSortRecipes(recipes, '', 'time').map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('walkRecipeChain', () => {
  it('follows parent_id and stops on cycles', () => {
    const all: Recipe[] = [
      { id: 'v3', parent_id: 'v2' },
      { id: 'v2', parent_id: 'v1' },
      { id: 'v1', parent_id: 'v3' }, // cycle back
    ];
    expect(walkRecipeChain(all[0], all).map((r) => r.id)).toEqual(['v2', 'v1']);
  });
});

const grouped: Recipe = {
  id: 'r1',
  name: 'Bowl',
  choice_groups: [{ id: 'g1', name: 'Pick a veg', pick_n: 2, members: ['Kale', 'Chard', 'Beets'] }],
  last_picks: { g1: ['Kale', 'Chard'] },
  ingredients: [
    { item: 'Kale', qty: '1 bunch' },
    { item: 'Chard' },
    { item: 'Beets' },
    { item: 'Rice', qty: '2 cups' },
    { item: 'Salt', stocking_status: 'usually_have' },
    { item: 'Water', stocking_status: 'n_a' },
    { item: 'Tahini' },
  ],
};

describe('send-to-grocery model', () => {
  it('recipeMemberLabel appends qty when present', () => {
    expect(recipeMemberLabel(grouped, 'kale')).toBe('Kale · 1 bunch');
    expect(recipeMemberLabel(grouped, 'Chard')).toBe('Chard');
    expect(recipeMemberLabel(grouped, 'nope')).toBe('nope');
  });

  it('buildSendRows skips group members and N/A, dims on-list/stocked', () => {
    const rows = buildSendRows(grouped, new Set(['tahini']));
    expect(rows.map((r) => r.name)).toEqual(['Rice', 'Salt', 'Tahini']);
    expect(rows[0].defaultChecked).toBe(true);
    expect(rows[1]).toMatchObject({ usuallyHave: true, defaultChecked: false });
    expect(rows[2]).toMatchObject({ onList: true, defaultChecked: false });
  });

  it('initialPicks seeds from last_picks and allGroupsValid enforces pick_n', () => {
    const picks = initialPicks(grouped);
    expect(Array.from(picks.g1)).toEqual(['Kale', 'Chard']);
    expect(allGroupsValid(grouped.choice_groups!, picks)).toBe(true);
    picks.g1.delete('Kale');
    expect(allGroupsValid(grouped.choice_groups!, picks)).toBe(false);
  });
});

describe('bucketPushAll', () => {
  it('buckets by outcome using last picks', () => {
    const b = bucketPushAll(grouped, new Set(['chard']));
    expect(b.canPush).toBe(true);
    expect(b.willAdd.map((i) => i.item)).toEqual(['Kale', 'Rice', 'Tahini']);
    expect(b.skippedOnList.map((i) => i.item)).toEqual(['Chard']);
    expect(b.skippedUnpicked.map((i) => i.item)).toEqual(['Beets']);
    expect(b.skippedStocked.map((i) => i.item)).toEqual(['Salt']);
    expect(b.skippedNa.map((i) => i.item)).toEqual(['Water']);
  });

  it('cannot push a grouped recipe without complete last picks', () => {
    const noPicks: Recipe = { ...grouped, last_picks: {} };
    expect(bucketPushAll(noPicks, new Set()).canPush).toBe(false);
  });
});
