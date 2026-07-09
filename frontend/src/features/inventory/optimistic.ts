/**
 * Pure optimistic updaters over the /api/data/inventory cache — each mirrors
 * what the corresponding routes/inventory.py handler will persist, so the UI
 * lands where the 5s poll will confirm. All return a new InventoryData;
 * frosted/non-array payloads pass through untouched (asList guards).
 */
import { asList } from './inventoryHelpers';
import type { UpdateBuyPayload } from './api';
import type { ActiveItem, ArchivalItem, BuyItem, InventoryData } from './types';

function withBuy(data: InventoryData, items: BuyItem[]): InventoryData {
  return { ...data, buy_list: items };
}

function withActive(data: InventoryData, items: ActiveItem[]): InventoryData {
  return { ...data, active_inventory: items };
}

export function applyPriorityNotes(data: InventoryData, text: string): InventoryData {
  return { ...data, priority_notes: text };
}

export function applyBuyRemove(data: InventoryData, name: string): InventoryData {
  return withBuy(data, asList<BuyItem>(data.buy_list).filter((i) => i.name !== name));
}

/** Field updates + optional rename (rename skipped when empty or duplicate,
 * matching update_buy_item). */
export function applyBuyUpdate(data: InventoryData, payload: UpdateBuyPayload): InventoryData {
  const items = asList<BuyItem>(data.buy_list);
  return withBuy(
    data,
    items.map((i) => {
      if (i.name !== payload.name) return i;
      const next: BuyItem = { ...i };
      (['priority', 'where', 'notes', 'category', 'cost', 'why', 'by', 'order_url', 'kind'] as const).forEach(
        (k) => {
          if (payload[k] !== undefined) next[k] = payload[k];
        },
      );
      if (payload.new_name !== undefined) {
        const newName = payload.new_name.trim();
        const clash = items.some((x) => x !== i && x.name.toLowerCase() === newName.toLowerCase());
        if (newName && newName !== i.name && !clash) next.name = newName;
      }
      return next;
    }),
  );
}

export function applyBuySetKind(data: InventoryData, name: string, kind: string): InventoryData {
  return applyBuyUpdate(data, { name, kind });
}

/** "bought" — drop from the buy list and add/refresh the active item
 * (mirrors move_buy_to_active). `today` is YYYY-MM-DD. */
export function applyMarkBought(data: InventoryData, name: string, today: string): InventoryData {
  const buy = asList<BuyItem>(data.buy_list);
  const item = buy.find((i) => i.name === name);
  if (!item) return data;
  let out = withBuy(data, buy.filter((i) => i.name !== name));

  const active = asList<ActiveItem>(out.active_inventory);
  const existing = active.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    out = withActive(
      out,
      active.map((i) =>
        i === existing
          ? {
              ...i,
              status: 'in_use',
              last_cost: item.cost || i.last_cost || '',
              ordered_at: [...(i.ordered_at || []), today],
              ...(item.where ? { where: item.where } : {}),
              ...(item.order_url ? { order_url: item.order_url } : {}),
            }
          : i,
      ),
    );
  } else {
    out = withActive(out, [
      ...active,
      {
        name: item.name,
        category: item.category || '',
        status: 'in_use',
        last_cost: item.cost || '',
        where: item.where || '',
        notes: item.notes || '',
        order_url: item.order_url || '',
        ordered_at: [today],
      },
    ]);
  }
  return out;
}

/** Restock — mark running_low and auto-add a high-priority consumable copy to
 * the buy list unless it's already there (mirrors restock_active_item). */
export function applyRestock(data: InventoryData, name: string, nowIso: string): InventoryData {
  const active = asList<ActiveItem>(data.active_inventory);
  const item = active.find((i) => i.name === name);
  if (!item) return data;
  let out = withActive(
    data,
    active.map((i) => (i.name === name ? { ...i, status: 'running_low' } : i)),
  );

  const buy = asList<BuyItem>(out.buy_list);
  if (!buy.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
    out = withBuy(out, [
      ...buy,
      {
        name: item.name,
        priority: 'high',
        where: item.where || '',
        notes: item.notes || '',
        category: item.category || '',
        cost: item.last_cost || '',
        why: 'running low — restock',
        by: '',
        order_url: item.order_url || '',
        kind: 'consumable',
        added: nowIso,
      },
    ]);
  }
  return out;
}

export function applyRetire(
  data: InventoryData,
  name: string,
  review: string,
  today: string,
): InventoryData {
  return withActive(
    data,
    asList<ActiveItem>(data.active_inventory).map((i) =>
      i.name === name
        ? { ...i, status: 'finished', retired_on: today, ...(review ? { review } : {}) }
        : i,
    ),
  );
}

export function applyUnretire(data: InventoryData, name: string): InventoryData {
  return withActive(
    data,
    asList<ActiveItem>(data.active_inventory).map((i) => {
      if (i.name !== name) return i;
      const next = { ...i, status: 'in_use' };
      delete next.retired_on;
      return next;
    }),
  );
}

export function applyActiveRemove(data: InventoryData, name: string): InventoryData {
  return withActive(
    data,
    asList<ActiveItem>(data.active_inventory).filter((i) => i.name !== name),
  );
}

export function applyActiveReview(data: InventoryData, name: string, review: string): InventoryData {
  return withActive(
    data,
    asList<ActiveItem>(data.active_inventory).map((i) => (i.name === name ? { ...i, review } : i)),
  );
}

export function applyArchivalRemove(data: InventoryData, id: string): InventoryData {
  return { ...data, archivals: asList<ArchivalItem>(data.archivals).filter((i) => i.id !== id) };
}
