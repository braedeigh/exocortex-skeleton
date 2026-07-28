/**
 * Pure buy-list / active-inventory logic — the grouping, filtering and text
 * formatting the Inventory tab renders from. No DOM, no fetch, so all of it
 * is vitest-testable (inventoryHelpers.test.ts).
 *
 * Three families live here: the buy list's phone-first view (group by
 * priority or by category, filter by store, format the deadline), the older
 * kind/front grouping kept from the ported static/js/inventory.js, and the
 * active/past inventory partitions the tables use.
 */
import type { ActiveItem, BuyItem } from './types';

export interface BuyKindMeta {
  key: 'consumable' | 'durable' | 'service';
  label: string;
  color: string;
}

export const BUY_KINDS: BuyKindMeta[] = [
  { key: 'consumable', label: 'Consumables', color: 'var(--green)' },
  { key: 'durable', label: 'Durables', color: 'var(--purple, #8e6bbf)' },
  { key: 'service', label: 'Services', color: 'var(--ongoing)' },
];

export const PRIORITY_COLORS: Record<string, string> = {
  high: 'var(--red)',
  medium: 'var(--yellow)',
  low: 'var(--text-muted)',
};

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Frosted/public payloads replace lists with placeholders — never trust the shape. */
export function asList<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function priorityColor(priority?: string): string {
  return PRIORITY_COLORS[priority || ''] || 'var(--text-muted)';
}

export function isSortedKind(kind?: string): boolean {
  return BUY_KINDS.some((k) => k.key === kind);
}

/** '2026-07-06T21:40:00' → 'Jul 6' (year appended if not `now`'s year). */
export function formatBuyDate(ts: string | undefined, now: Date = new Date()): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts.slice(0, 10);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

/** 'uncategorized' → 'Uncategorized', 'supplements' → 'Supplements'. */
export function categoryLabel(cat: string): string {
  if (cat === 'uncategorized') return 'Uncategorized';
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

export interface CategoryGroup<T> {
  category: string;
  label: string;
  items: T[];
}

function groupByCategory<T extends { category?: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  items.forEach((item) => {
    const cat = (item.category || '').trim() || 'uncategorized';
    const list = groups.get(cat) || [];
    list.push(item);
    groups.set(cat, list);
  });
  return groups;
}

/** A-Z with 'uncategorized' forced last (old renderCategoryGroups order). */
function sortCategoriesUncatLast(names: string[]): string[] {
  return [...names].sort((a, b) => {
    if (a === 'uncategorized') return 1;
    if (b === 'uncategorized') return -1;
    return a.localeCompare(b);
  });
}

/** Buy items of one kind → category groups (uncategorized last), each
 * priority-sorted high → medium → low (unknown priorities sink with low). */
export function groupBuyByCategory(items: BuyItem[]): CategoryGroup<BuyItem>[] {
  const groups = groupByCategory(items);
  return sortCategoriesUncatLast([...groups.keys()]).map((cat) => ({
    category: cat,
    label: categoryLabel(cat),
    items: [...(groups.get(cat) || [])].sort(
      (a, b) => (PRIORITY_ORDER[a.priority || ''] ?? 2) - (PRIORITY_ORDER[b.priority || ''] ?? 2),
    ),
  }));
}

/** Sentinel group for items with no front tags — frontLabel renders it. */
export const UNTAGGED_FRONT = '__none__';

export interface FrontGroup {
  /** Front id, or UNTAGGED_FRONT for untagged items. */
  front: string;
  items: BuyItem[];
}

/** Buy items → per-front groups in fronts.json order (unknown front ids A-Z
 * after, untagged last). An item tagged with two fronts appears under both;
 * each group is priority-sorted high → medium → low. */
export function groupBuyByFront(items: BuyItem[], frontOrder: string[]): FrontGroup[] {
  const groups = new Map<string, BuyItem[]>();
  items.forEach((item) => {
    const tags = item.fronts && item.fronts.length ? item.fronts : [UNTAGGED_FRONT];
    tags.forEach((f) => {
      const list = groups.get(f) || [];
      list.push(item);
      groups.set(f, list);
    });
  });
  const rank = new Map(frontOrder.map((f, i) => [f, i]));
  const ordered = [...groups.keys()].sort((a, b) => {
    if (a === UNTAGGED_FRONT) return 1;
    if (b === UNTAGGED_FRONT) return -1;
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.localeCompare(b);
  });
  return ordered.map((front) => ({
    front,
    items: [...(groups.get(front) || [])].sort(
      (a, b) => (PRIORITY_ORDER[a.priority || ''] ?? 2) - (PRIORITY_ORDER[b.priority || ''] ?? 2),
    ),
  }));
}

export function buyItemsOfKind(items: BuyItem[], kind: string): BuyItem[] {
  return items.filter((i) => i.kind === kind);
}

export function unsortedBuyItems(items: BuyItem[]): BuyItem[] {
  return items.filter((i) => !isSortedKind(i.kind));
}

/** Distinct trimmed categories across the buy list — the add-form datalist. */
export function knownBuyCategories(items: BuyItem[]): string[] {
  return [...new Set(items.map((i) => (i.category || '').trim()).filter(Boolean))].sort();
}

/** Buy + active categories combined — mirrors /api/data/item-buy's
 * known_categories for the detail page. */
export function knownCategories(buy: BuyItem[], active: ActiveItem[]): string[] {
  const all = new Set<string>();
  [...buy, ...active].forEach((i) => {
    const c = (i.category || '').trim();
    if (c) all.add(c);
  });
  return [...all].sort();
}

// --- Buy list: priority grouping + store filter (the phone-first view) ---

export interface PriorityGroup {
  priority: string;
  label: string;
  color: string;
  items: BuyItem[];
}

const PRIORITY_GROUPS: { priority: string; label: string }[] = [
  { priority: 'high', label: 'High priority' },
  { priority: 'medium', label: 'Medium' },
  { priority: 'low', label: 'Low' },
];

/** Soonest `by` deadline first (dated before undated), then name A–Z. */
function byDeadlineThenName(a: BuyItem, b: BuyItem): number {
  const da = (a.by || '').trim();
  const db = (b.by || '').trim();
  if (da && db && da !== db) return da < db ? -1 : 1;
  if (da && !db) return -1;
  if (db && !da) return 1;
  return (a.name || '').localeCompare(b.name || '');
}

/** A plain 'YYYY-MM-DD' deadline → 'Jul 31' for the row's sub-line. Parsed by
 * hand rather than through `new Date`: the built-in reads a bare date as UTC
 * midnight, which renders as the *previous* day in any US timezone. Anything
 * that isn't a plain date (freeform text like "before the move") comes back
 * untouched. */
export function formatByDate(by?: string): string {
  const raw = (by || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return raw;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Buy items → High / Medium / Low groups (that order; blank/unknown priority
 * falls into Medium), each sorted by deadline then name; empty groups dropped.
 * The phone-first default view — flat and scannable, most urgent on top. */
export function groupBuyByPriority(items: BuyItem[]): PriorityGroup[] {
  const buckets: Record<string, BuyItem[]> = { high: [], medium: [], low: [] };
  items.forEach((i) => {
    const p = (i.priority || '').toLowerCase();
    (buckets[p] || buckets.medium).push(i);
  });
  return PRIORITY_GROUPS.map(({ priority, label }) => ({
    priority,
    label,
    color: priorityColor(priority),
    items: [...buckets[priority]].sort(byDeadlineThenName),
  })).filter((g) => g.items.length);
}

/** Best-effort store normalization: a freeform `where` ("Target / HEB",
 * "Target now / Sur La Table") maps to canonical store labels by keyword, so
 * the shopping-mode filter chips stay clean even though the field is free
 * text. Extend as new stores show up. Generic US retailers, not personal. */
const STORE_ALIASES: { label: string; re: RegExp }[] = [
  { label: 'Target', re: /target/i },
  { label: 'HEB', re: /\bh\.?-?e\.?-?b\b/i },
  { label: 'Amazon', re: /amazon/i },
  { label: 'Marketplace', re: /marketplace|facebook/i },
  { label: 'IKEA', re: /ikea/i },
  { label: 'Home Depot', re: /home ?depot/i },
  { label: 'Micro Center', re: /micro ?center/i },
  { label: 'Sur La Table', re: /sur la table/i },
  { label: 'Container Store', re: /container store/i },
  { label: 'Walmart', re: /wal-?mart/i },
  { label: 'Costco', re: /costco/i },
  { label: 'Whole Foods', re: /whole foods/i },
  { label: 'Sprouts', re: /sprouts/i },
  { label: 'Dollar store', re: /dollar ?(store|tree|general)/i },
];

/** Canonical store labels this item's `where` mentions (zero or more). */
export function itemStores(item: BuyItem): string[] {
  const w = item.where || '';
  return STORE_ALIASES.filter((s) => s.re.test(w)).map((s) => s.label);
}

export interface StoreChip {
  label: string;
  count: number;
}

/** Distinct stores across the list, most-common first — the shopping-mode
 * filter chips (at a store, pull up just what's there). Items whose `where`
 * matches no known store contribute no chip (they still show under "All"). */
export function buyStores(items: BuyItem[]): StoreChip[] {
  const counts = new Map<string, number>();
  items.forEach((i) => itemStores(i).forEach((s) => counts.set(s, (counts.get(s) || 0) + 1)));
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Filter to items whose `where` mentions `store` (null = no filter). */
export function filterBuyByStore(items: BuyItem[], store: string | null): BuyItem[] {
  if (!store) return items;
  return items.filter((i) => itemStores(i).includes(store));
}

// --- Active inventory ---

export interface StatusMeta {
  label: string;
  color: string;
}

export const STATUS_META: Record<string, StatusMeta> = {
  in_use: { label: 'In use', color: 'var(--green)' },
  running_low: { label: 'Running low', color: 'var(--red)' },
  finished: { label: 'Finished', color: 'var(--text-muted)' },
  paused: { label: 'Paused', color: 'var(--yellow)' },
};

export function statusMeta(status?: string): StatusMeta {
  return STATUS_META[status || 'in_use'] || STATUS_META.in_use;
}

export function activeItems(all: ActiveItem[]): ActiveItem[] {
  return all.filter((i) => i.status !== 'finished');
}

export function pastItems(all: ActiveItem[]): ActiveItem[] {
  return all.filter((i) => i.status === 'finished');
}

export function runningLowItems(all: ActiveItem[]): ActiveItem[] {
  return all.filter((i) => i.status === 'running_low');
}

/** Active (non-finished) items → category groups (uncategorized last), rows
 * sorted running_low first, then in_use, then everything else. */
export function groupActiveByCategory(items: ActiveItem[]): CategoryGroup<ActiveItem>[] {
  const statusRank = (s?: string) => (s === 'running_low' ? 0 : s === 'in_use' ? 1 : 2);
  const groups = groupByCategory(items);
  return sortCategoriesUncatLast([...groups.keys()]).map((cat) => ({
    category: cat,
    label: categoryLabel(cat),
    items: [...(groups.get(cat) || [])].sort((a, b) => statusRank(a.status) - statusRank(b.status)),
  }));
}

/** Past (finished) items → category groups in *plain* A-Z order (the old
 * renderPastInventory sorts keys without the uncategorized-last rule), rows
 * newest-retired first. */
export function groupPastByCategory(items: ActiveItem[]): CategoryGroup<ActiveItem>[] {
  const groups = groupByCategory(items);
  return [...groups.keys()].sort().map((cat) => ({
    category: cat,
    label: categoryLabel(cat),
    items: [...(groups.get(cat) || [])].sort((a, b) =>
      (b.retired_on || '').localeCompare(a.retired_on || ''),
    ),
  }));
}

/** 'first-order → retired-on' | 'retired X' | '' (render an em-dash for ''). */
export function usedRangeText(item: ActiveItem): string {
  const orders = item.ordered_at || [];
  const firstOrder = orders.length ? orders[0] : '';
  const retiredOn = item.retired_on || '';
  if (firstOrder && retiredOn) return `${firstOrder} → ${retiredOn}`;
  if (retiredOn) return `retired ${retiredOn}`;
  return '';
}

/** Multi-line notes collapsed to one ' · '-joined line for table cells. */
export function notesOneLine(notes?: string): string {
  return notes ? notes.replace(/\n/g, ' · ') : '';
}

/** 'Last ordered 2026-07-01 · 3 times total' (empty when never ordered). */
export function orderHistoryText(item: ActiveItem): string {
  const orders = item.ordered_at || [];
  if (!orders.length) return '';
  const last = `Last ordered ${orders[orders.length - 1]}`;
  return orders.length > 1 ? `${last} · ${orders.length} times total` : last;
}
