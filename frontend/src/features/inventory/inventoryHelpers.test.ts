import { describe, expect, it } from 'vitest';
import {
  activeItems,
  asList,
  buyItemsOfKind,
  categoryLabel,
  formatBuyDate,
  formatByDate,
  groupActiveByCategory,
  buyStores,
  filterBuyByStore,
  groupBuyByCategory,
  groupBuyByFront,
  groupBuyByPriority,
  itemStores,
  groupPastByCategory,
  UNTAGGED_FRONT,
  isSortedKind,
  knownBuyCategories,
  knownCategories,
  notesOneLine,
  orderHistoryText,
  pastItems,
  runningLowItems,
  statusMeta,
  unsortedBuyItems,
  usedRangeText,
} from './inventoryHelpers';
import type { ActiveItem, BuyItem } from './types';

const buy = (over: Partial<BuyItem> = {}): BuyItem => ({ name: 'x', ...over });

describe('groupBuyByPriority', () => {
  it('groups high/medium/low in that order, blank priority → medium', () => {
    const groups = groupBuyByPriority([
      buy({ name: 'lo', priority: 'low' }),
      buy({ name: 'hi', priority: 'high' }),
      buy({ name: 'blank' }),
      buy({ name: 'med', priority: 'medium' }),
    ]);
    expect(groups.map((g) => g.priority)).toEqual(['high', 'medium', 'low']);
    expect(groups[1].items.map((i) => i.name).sort()).toEqual(['blank', 'med']);
  });
  it('drops empty groups', () => {
    expect(groupBuyByPriority([buy({ priority: 'high' })]).map((g) => g.priority)).toEqual(['high']);
  });
  it('sorts within a group by deadline (soonest first), then name', () => {
    const [g] = groupBuyByPriority([
      buy({ name: 'no-date', priority: 'high' }),
      buy({ name: 'later', priority: 'high', by: '2026-08-01' }),
      buy({ name: 'soon', priority: 'high', by: '2026-07-31' }),
    ]);
    expect(g.items.map((i) => i.name)).toEqual(['soon', 'later', 'no-date']);
  });
});

describe('formatByDate', () => {
  it('renders a plain YYYY-MM-DD without slipping a day', () => {
    // `new Date('2026-07-31')` is UTC midnight, which prints as Jul 30 in any
    // US timezone — the row must not show a deadline a day early.
    expect(formatByDate('2026-07-31')).toBe('Jul 31');
    expect(formatByDate('2026-01-01')).toBe('Jan 1');
  });
  it('passes freeform deadlines through untouched', () => {
    expect(formatByDate('before the move')).toBe('before the move');
  });
  it('is empty for missing/blank input', () => {
    expect(formatByDate(undefined)).toBe('');
    expect(formatByDate('   ')).toBe('');
  });
});

describe('store filter (itemStores / buyStores / filterBuyByStore)', () => {
  it('maps freeform where to canonical stores; unknown → none', () => {
    expect(itemStores(buy({ where: 'Target now / Sur La Table / Amazon' }))).toEqual([
      'Target',
      'Amazon',
      'Sur La Table',
    ]);
    expect(itemStores(buy({ where: 'hardware aisle' }))).toEqual([]);
  });
  it('buyStores counts stores, most-common first', () => {
    const chips = buyStores([
      buy({ where: 'Target / HEB' }),
      buy({ where: 'Target' }),
      buy({ where: 'Amazon' }),
    ]);
    expect(chips[0]).toEqual({ label: 'Target', count: 2 });
    expect(chips.find((c) => c.label === 'HEB')).toEqual({ label: 'HEB', count: 1 });
  });
  it('filterBuyByStore keeps items mentioning the store; null = all', () => {
    const items = [buy({ name: 'a', where: 'Target / HEB' }), buy({ name: 'b', where: 'Amazon' })];
    expect(filterBuyByStore(items, 'Target').map((i) => i.name)).toEqual(['a']);
    expect(filterBuyByStore(items, null)).toHaveLength(2);
  });
});

describe('asList', () => {
  it('passes arrays through', () => {
    expect(asList<number>([1, 2])).toEqual([1, 2]);
  });
  it('returns [] for frosted/non-array payloads', () => {
    expect(asList({ _frosted: true })).toEqual([]);
    expect(asList(undefined)).toEqual([]);
    expect(asList('nope')).toEqual([]);
  });
});

describe('formatBuyDate', () => {
  const now = new Date('2026-07-09T12:00:00');
  it('drops the year for the current year', () => {
    expect(formatBuyDate('2026-07-06T21:40:00', now)).toBe('Jul 6');
  });
  it('appends the year otherwise', () => {
    expect(formatBuyDate('2025-12-31T09:00:00', now)).toContain('2025');
  });
  it('falls back to the raw date slice when unparseable', () => {
    expect(formatBuyDate('not-a-date-at-all', now)).toBe('not-a-date');
  });
  it('is empty for missing input', () => {
    expect(formatBuyDate(undefined, now)).toBe('');
  });
});

describe('isSortedKind', () => {
  it('knows the three kinds', () => {
    expect(isSortedKind('consumable')).toBe(true);
    expect(isSortedKind('durable')).toBe(true);
    expect(isSortedKind('service')).toBe(true);
  });
  it('treats anything else as unsorted', () => {
    expect(isSortedKind('')).toBe(false);
    expect(isSortedKind(undefined)).toBe(false);
    expect(isSortedKind('gadget')).toBe(false);
  });
});

describe('groupBuyByCategory', () => {
  const items: BuyItem[] = [
    { name: 'zinc', category: 'supplements', priority: 'low' },
    { name: 'soap', category: '', priority: 'high' },
    { name: 'magnesium', category: 'supplements', priority: 'high' },
    { name: 'broom', category: 'household', priority: 'medium' },
  ];
  it('sorts categories A-Z with uncategorized last', () => {
    expect(groupBuyByCategory(items).map((g) => g.category)).toEqual([
      'household',
      'supplements',
      'uncategorized',
    ]);
  });
  it('sorts items by priority high → low inside a category', () => {
    const supplements = groupBuyByCategory(items).find((g) => g.category === 'supplements');
    expect(supplements?.items.map((i) => i.name)).toEqual(['magnesium', 'zinc']);
  });
  it('labels categories capitalized', () => {
    const labels = groupBuyByCategory(items).map((g) => g.label);
    expect(labels).toEqual(['Household', 'Supplements', 'Uncategorized']);
  });
  it('sinks unknown priorities with low', () => {
    const groups = groupBuyByCategory([
      { name: 'a', priority: 'weird' },
      { name: 'b', priority: 'high' },
    ]);
    expect(groups[0].items.map((i) => i.name)).toEqual(['b', 'a']);
  });
});

describe('groupBuyByFront', () => {
  const FRONT_ORDER = ['health', 'appearance', 'living-space'];

  it('orders groups by the fronts vocabulary, untagged last', () => {
    const items: BuyItem[] = [
      { name: 'A', fronts: ['living-space'] },
      { name: 'B' },
      { name: 'C', fronts: ['health'] },
    ];
    expect(groupBuyByFront(items, FRONT_ORDER).map((g) => g.front)).toEqual([
      'health',
      'living-space',
      UNTAGGED_FRONT,
    ]);
  });

  it('puts a multi-front item in every one of its groups', () => {
    const items: BuyItem[] = [{ name: 'Barefoot shoes', fronts: ['health', 'appearance'] }];
    const groups = groupBuyByFront(items, FRONT_ORDER);
    expect(groups.map((g) => g.front)).toEqual(['health', 'appearance']);
    expect(groups.every((g) => g.items[0].name === 'Barefoot shoes')).toBe(true);
  });

  it('treats an empty fronts list as untagged', () => {
    const groups = groupBuyByFront([{ name: 'A', fronts: [] }], FRONT_ORDER);
    expect(groups).toEqual([{ front: UNTAGGED_FRONT, items: [{ name: 'A', fronts: [] }] }]);
  });

  it('sinks unknown front ids below known ones, A-Z', () => {
    const items: BuyItem[] = [
      { name: 'A', fronts: ['zzz-old'] },
      { name: 'B', fronts: ['aaa-old'] },
      { name: 'C', fronts: ['living-space'] },
    ];
    expect(groupBuyByFront(items, FRONT_ORDER).map((g) => g.front)).toEqual([
      'living-space',
      'aaa-old',
      'zzz-old',
    ]);
  });

  it('priority-sorts within a group', () => {
    const items: BuyItem[] = [
      { name: 'low', priority: 'low', fronts: ['health'] },
      { name: 'high', priority: 'high', fronts: ['health'] },
    ];
    expect(groupBuyByFront(items, FRONT_ORDER)[0].items.map((i) => i.name)).toEqual([
      'high',
      'low',
    ]);
  });
});

describe('kind partitions', () => {
  const items: BuyItem[] = [
    { name: 'a', kind: 'consumable' },
    { name: 'b', kind: '' },
    { name: 'c', kind: 'service' },
    { name: 'd' },
  ];
  it('selects a single kind', () => {
    expect(buyItemsOfKind(items, 'consumable').map((i) => i.name)).toEqual(['a']);
  });
  it('collects everything unfiled as unsorted', () => {
    expect(unsortedBuyItems(items).map((i) => i.name)).toEqual(['b', 'd']);
  });
});

describe('category datalists', () => {
  it('knownBuyCategories dedupes, trims and sorts', () => {
    const cats = knownBuyCategories([
      { name: 'a', category: ' supplements ' },
      { name: 'b', category: 'household' },
      { name: 'c', category: 'supplements' },
      { name: 'd', category: '' },
    ]);
    expect(cats).toEqual(['household', 'supplements']);
  });
  it('knownCategories merges buy + active (the item-buy endpoint view)', () => {
    const cats = knownCategories(
      [{ name: 'a', category: 'supplements' }],
      [{ name: 'b', category: 'household' }],
    );
    expect(cats).toEqual(['household', 'supplements']);
  });
});

describe('active/past partitions', () => {
  const all: ActiveItem[] = [
    { name: 'a', status: 'in_use' },
    { name: 'b', status: 'finished' },
    { name: 'c', status: 'running_low' },
    { name: 'd', status: 'paused' },
    { name: 'e' },
  ];
  it('active excludes finished (missing status counts as active)', () => {
    expect(activeItems(all).map((i) => i.name)).toEqual(['a', 'c', 'd', 'e']);
  });
  it('past is only finished', () => {
    expect(pastItems(all).map((i) => i.name)).toEqual(['b']);
  });
  it('running low feeds the restock banner', () => {
    expect(runningLowItems(all).map((i) => i.name)).toEqual(['c']);
  });
});

describe('groupActiveByCategory', () => {
  it('puts running_low first, then in_use, then the rest', () => {
    const groups = groupActiveByCategory([
      { name: 'paused', status: 'paused' },
      { name: 'using', status: 'in_use' },
      { name: 'low', status: 'running_low' },
    ]);
    expect(groups[0].items.map((i) => i.name)).toEqual(['low', 'using', 'paused']);
  });
});

describe('groupPastByCategory', () => {
  it('sorts categories plainly (no uncategorized-last rule, matching the old page)', () => {
    const groups = groupPastByCategory([
      { name: 'a', status: 'finished', category: 'z-things' },
      { name: 'b', status: 'finished' },
    ]);
    expect(groups.map((g) => g.category)).toEqual(['uncategorized', 'z-things']);
  });
  it('sorts rows newest-retired first', () => {
    const groups = groupPastByCategory([
      { name: 'older', status: 'finished', retired_on: '2026-01-01' },
      { name: 'newer', status: 'finished', retired_on: '2026-06-01' },
    ]);
    expect(groups[0].items.map((i) => i.name)).toEqual(['newer', 'older']);
  });
});

describe('row text helpers', () => {
  it('usedRangeText prefers first-order → retired', () => {
    expect(usedRangeText({ name: 'x', ordered_at: ['2026-01-02', '2026-03-04'], retired_on: '2026-06-01' })).toBe(
      '2026-01-02 → 2026-06-01',
    );
  });
  it('usedRangeText falls back to retired-only, then empty', () => {
    expect(usedRangeText({ name: 'x', retired_on: '2026-06-01' })).toBe('retired 2026-06-01');
    expect(usedRangeText({ name: 'x' })).toBe('');
  });
  it('notesOneLine joins lines with dots', () => {
    expect(notesOneLine('one\ntwo')).toBe('one · two');
    expect(notesOneLine(undefined)).toBe('');
  });
  it('orderHistoryText counts repeat orders', () => {
    expect(orderHistoryText({ name: 'x', ordered_at: ['2026-01-01'] })).toBe('Last ordered 2026-01-01');
    expect(orderHistoryText({ name: 'x', ordered_at: ['2026-01-01', '2026-02-01'] })).toBe(
      'Last ordered 2026-02-01 · 2 times total',
    );
    expect(orderHistoryText({ name: 'x' })).toBe('');
  });
  it('statusMeta falls back to in_use', () => {
    expect(statusMeta('running_low').label).toBe('Running low');
    expect(statusMeta(undefined).label).toBe('In use');
    expect(statusMeta('bogus').label).toBe('In use');
  });
  it('categoryLabel capitalizes and special-cases uncategorized', () => {
    expect(categoryLabel('supplements')).toBe('Supplements');
    expect(categoryLabel('uncategorized')).toBe('Uncategorized');
  });
});
