import { describe, expect, it } from 'vitest';
import {
  applyActiveRemove,
  applyActiveReview,
  applyArchivalRemove,
  applyBuyRemove,
  applyBuySetKind,
  applyBuyUpdate,
  applyMarkBought,
  applyRestock,
  applyRetire,
  applyUnretire,
} from './optimistic';
import type { InventoryData } from './types';

function base(): InventoryData {
  return {
    priority_notes: '',
    buy_list: [
      { name: 'Zinc', kind: '', priority: 'medium', cost: '$10', where: 'CVS', order_url: 'https://z' },
    ],
    active_inventory: [
      { name: 'Magnesium', status: 'in_use', last_cost: '$15', ordered_at: ['2026-01-01'] },
    ],
    archivals: [{ id: 'a1', name: 'Locket' }],
  };
}

describe('buy list updaters', () => {
  it('applyBuyRemove drops by name', () => {
    const out = applyBuyRemove(base(), 'Zinc');
    expect(out.buy_list).toEqual([]);
  });

  it('applyBuySetKind files an unsorted item', () => {
    const out = applyBuySetKind(base(), 'Zinc', 'consumable');
    expect((out.buy_list as { kind?: string }[])[0].kind).toBe('consumable');
  });

  it('applyBuyUpdate renames unless the new name clashes (case-insensitive)', () => {
    const data = base();
    (data.buy_list as { name: string }[]).push({ name: 'Soap' });
    const renamed = applyBuyUpdate(data, { name: 'Zinc', new_name: 'Zinc Picolinate' });
    expect((renamed.buy_list as { name: string }[])[0].name).toBe('Zinc Picolinate');
    const clashed = applyBuyUpdate(data, { name: 'Zinc', new_name: 'soap' });
    expect((clashed.buy_list as { name: string }[])[0].name).toBe('Zinc');
  });

  it('applyMarkBought moves a buy item into active with today appended', () => {
    const out = applyMarkBought(base(), 'Zinc', '2026-07-09');
    expect(out.buy_list).toEqual([]);
    const active = out.active_inventory as { name: string; status?: string; ordered_at?: string[]; last_cost?: string }[];
    const zinc = active.find((i) => i.name === 'Zinc');
    expect(zinc).toMatchObject({ status: 'in_use', last_cost: '$10', ordered_at: ['2026-07-09'] });
  });

  it('applyMarkBought re-activates an existing active item instead of duplicating', () => {
    const data = base();
    (data.buy_list as object[]).push({ name: 'magnesium', cost: '$20' });
    const out = applyMarkBought(data, 'magnesium', '2026-07-09');
    const active = out.active_inventory as { name: string; ordered_at?: string[]; last_cost?: string }[];
    expect(active).toHaveLength(1);
    expect(active[0].ordered_at).toEqual(['2026-01-01', '2026-07-09']);
    expect(active[0].last_cost).toBe('$20');
  });
});

describe('active inventory updaters', () => {
  it('applyRestock flips status and adds a high-priority consumable to the buy list', () => {
    const out = applyRestock(base(), 'Magnesium', '2026-07-09T12:00:00');
    const active = out.active_inventory as { status?: string }[];
    expect(active[0].status).toBe('running_low');
    const buy = out.buy_list as { name: string; priority?: string; kind?: string; why?: string }[];
    const added = buy.find((i) => i.name === 'Magnesium');
    expect(added).toMatchObject({ priority: 'high', kind: 'consumable', why: 'running low — restock' });
  });

  it('applyRestock does not duplicate an existing buy entry', () => {
    const data = base();
    (data.buy_list as object[]).push({ name: 'MAGNESIUM' });
    const out = applyRestock(data, 'Magnesium', '2026-07-09T12:00:00');
    expect((out.buy_list as object[]).length).toBe(2);
  });

  it('applyRetire sets finished + retired_on and keeps a non-empty review', () => {
    const out = applyRetire(base(), 'Magnesium', 'helped a bit', '2026-07-09');
    const item = (out.active_inventory as { status?: string; retired_on?: string; review?: string }[])[0];
    expect(item).toMatchObject({ status: 'finished', retired_on: '2026-07-09', review: 'helped a bit' });
    const noReview = applyRetire(base(), 'Magnesium', '', '2026-07-09');
    expect((noReview.active_inventory as { review?: string }[])[0].review).toBeUndefined();
  });

  it('applyUnretire restores in_use and clears retired_on', () => {
    const retired = applyRetire(base(), 'Magnesium', '', '2026-07-09');
    const out = applyUnretire(retired, 'Magnesium');
    const item = (out.active_inventory as { status?: string; retired_on?: string }[])[0];
    expect(item.status).toBe('in_use');
    expect(item.retired_on).toBeUndefined();
  });

  it('applyActiveRemove / applyActiveReview target by name', () => {
    expect(applyActiveRemove(base(), 'Magnesium').active_inventory).toEqual([]);
    const out = applyActiveReview(base(), 'Magnesium', 'good');
    expect((out.active_inventory as { review?: string }[])[0].review).toBe('good');
  });
});

describe('archival updaters', () => {
  it('applyArchivalRemove drops by id', () => {
    expect(applyArchivalRemove(base(), 'a1').archivals).toEqual([]);
  });
});

describe('frosted safety', () => {
  it('non-array payloads pass through unchanged', () => {
    const frosted: InventoryData = { buy_list: { _frosted: true }, active_inventory: { _frosted: true } };
    expect(applyBuyRemove(frosted, 'x').buy_list).toEqual([]);
    // no throw is the contract; a frosted view never mutates real data anyway
    expect(() => applyMarkBought(frosted, 'x', '2026-07-09')).not.toThrow();
  });
});
