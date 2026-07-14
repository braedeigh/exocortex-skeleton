/** Pure buy-item form state helpers shared by BuyItemModal and BuyItemDetail. */
import type { BuyItem } from './types';
import type { UpdateBuyPayload } from './api';

export interface BuyFormState {
  name: string;
  cost: string;
  why: string;
  by: string;
  category: string;
  where: string;
  order_url: string;
  priority: string;
  kind: string;
  fronts: string[];
  notes: string;
}

export function buyFormFromItem(item: BuyItem): BuyFormState {
  return {
    name: item.name,
    cost: item.cost || '',
    why: item.why || '',
    by: item.by || '',
    category: item.category || '',
    where: item.where || '',
    order_url: item.order_url || '',
    priority: item.priority || 'medium',
    kind: item.kind && ['consumable', 'durable', 'service'].includes(item.kind) ? item.kind : '',
    fronts: item.fronts || [],
    notes: item.notes || '',
  };
}

/** Build the /api/buy/update payload (originalName is the identity). */
export function buyUpdatePayload(originalName: string, form: BuyFormState): UpdateBuyPayload {
  return {
    name: originalName,
    new_name: form.name.trim(),
    cost: form.cost.trim(),
    why: form.why.trim(),
    by: form.by.trim(),
    category: form.category.trim(),
    where: form.where.trim(),
    order_url: form.order_url.trim(),
    priority: form.priority,
    kind: form.kind,
    fronts: form.fronts,
    notes: form.notes.trim(),
  };
}
