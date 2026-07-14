/**
 * Inventory tab data shapes — mirrors what /api/data/inventory returns
 * (server.py get_data_inventory): the buy list + active consumables loop
 * (routes/inventory.py, buy_list.json / active_inventory.json), the
 * priority-notes sticky, and the archivals catalog (routes/archivals.py).
 *
 * In public/frosted mode `filter_for_view` may replace the lists with
 * non-array placeholders — consumers must go through `asList()`
 * (inventoryHelpers.ts) rather than trusting the types.
 */

export type BuyPriority = 'high' | 'medium' | 'low';

/** '' / missing kind = unsorted (shows the C/D/S filing words). */
export type BuyKind = 'consumable' | 'durable' | 'service' | '';

export interface BuyItem {
  name: string;
  priority?: BuyPriority | string;
  where?: string;
  notes?: string;
  category?: string;
  cost?: string;
  why?: string;
  /** Deadline (freeform, usually YYYY-MM-DD) or '' for open. */
  by?: string;
  order_url?: string;
  kind?: BuyKind | string;
  /** Life-domain tags — front ids from routes/fronts.py, zero or more. */
  fronts?: string[];
  /** ISO timestamp set server-side on add. */
  added?: string;
}

export type ActiveStatus = 'in_use' | 'running_low' | 'finished' | 'paused';

export interface ActiveItem {
  name: string;
  category?: string;
  status?: ActiveStatus | string;
  last_cost?: string;
  where?: string;
  notes?: string;
  order_url?: string;
  /** YYYY-MM-DD dates, appended on each (re)order. */
  ordered_at?: string[];
  /** Retirement review — "didn't work, side effects, finished, etc". */
  review?: string;
  /** YYYY-MM-DD, set when retired (status finished). */
  retired_on?: string;
}

export interface ArchivalPhoto {
  id: string;
  filename: string;
}

export interface ArchivalMaterial {
  material: string;
  percentage?: number | null;
}

export interface ArchivalItem {
  id: string;
  name: string;
  category?: string;
  subcategory?: string;
  origin?: string;
  description?: string;
  /** 'new' | 'secondhand' | 'handmade' | 'unknown' */
  secondhand?: string;
  /** 'yes' | 'no' */
  gifted?: string;
  /** 'yes' | 'no' — hidden from the public site entirely. */
  private?: string;
  materials?: ArchivalMaterial[];
  photos?: ArchivalPhoto[];
  created_at?: string;
  last_edited?: string;
}

/** /api/data/inventory — only the keys this tab renders. */
export interface InventoryData {
  buy_list?: unknown;
  active_inventory?: unknown;
  priority_notes?: string;
  archivals?: unknown;
}

/** /api/data/item-buy?name=… — kept for reference; the React page derives
 * the same view (item + known categories) from the inventory query. */
export interface BuyItemDetailData {
  buy_item?: BuyItem | null;
  known_categories?: string[];
}
