/**
 * historyHelpers.ts — pure logic for the Purchase History spreadsheet and the
 * Grocery Spend trend card. Ports kitchen.js's _renderPurchaseHistorySection
 * sorters + renderSpendTrendCard math.
 */
import type { KitchenTrip } from './types';

export interface HistoryRow {
  name: string;
  category: string;
  count: number;
  lastBought: string | null;
  daysSince: number | null;
  safety: string;
}

export type HistorySort =
  | 'name_asc' | 'name_desc'
  | 'category_asc' | 'category_desc'
  | 'count_asc' | 'count_desc'
  | 'last_bought_asc' | 'last_bought_desc';

export const HISTORY_SORT_KEY = 'purchase_history_sort';

export function readHistorySort(): HistorySort {
  try {
    return (localStorage.getItem(HISTORY_SORT_KEY) as HistorySort) || 'last_bought_desc';
  } catch {
    return 'last_bought_desc';
  }
}

export function writeHistorySort(mode: HistorySort) {
  try {
    localStorage.setItem(HISTORY_SORT_KEY, mode);
  } catch {
    // won't persist
  }
}

export function buildHistoryRows(
  known: Record<string, string>,
  counts: Record<string, number>,
  lastBought: Record<string, string>,
  tags: Record<string, string>,
  now: number = Date.now(),
): HistoryRow[] {
  return Object.entries(known).map(([name, cat]) => {
    const lb = lastBought[name];
    const lbDate = lb ? new Date(lb + 'T12:00:00') : null;
    const daysSince = lbDate ? Math.round((now - lbDate.getTime()) / 86400000) : null;
    return {
      name,
      category: cat || 'other',
      count: counts[name] || 0,
      lastBought: lb || null,
      daysSince,
      safety: tags[name] || '',
    };
  });
}

const SORTERS: Record<HistorySort, (a: HistoryRow, b: HistoryRow) => number> = {
  name_asc: (a, b) => a.name.localeCompare(b.name),
  name_desc: (a, b) => b.name.localeCompare(a.name),
  category_asc: (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  category_desc: (a, b) => b.category.localeCompare(a.category) || a.name.localeCompare(b.name),
  count_desc: (a, b) => (b.count - a.count) || a.name.localeCompare(b.name),
  count_asc: (a, b) => (a.count - b.count) || a.name.localeCompare(b.name),
  last_bought_desc: (a, b) => {
    if (a.lastBought && !b.lastBought) return -1;
    if (!a.lastBought && b.lastBought) return 1;
    if (a.lastBought && b.lastBought) return b.lastBought.localeCompare(a.lastBought);
    return a.name.localeCompare(b.name);
  },
  last_bought_asc: (a, b) => {
    if (a.lastBought && !b.lastBought) return 1;
    if (!a.lastBought && b.lastBought) return -1;
    if (a.lastBought && b.lastBought) return a.lastBought.localeCompare(b.lastBought);
    return a.name.localeCompare(b.name);
  },
};

export function sortHistoryRows(rows: HistoryRow[], mode: HistorySort): HistoryRow[] {
  return rows.slice().sort(SORTERS[mode] || SORTERS.last_bought_desc);
}

/** Tapping the current column flips its direction; a new column starts _desc. */
export function nextHistorySort(current: HistorySort, col: 'name' | 'category' | 'count' | 'last_bought'): HistorySort {
  if (current.startsWith(col + '_')) {
    return (current.endsWith('_desc') ? `${col}_asc` : `${col}_desc`) as HistorySort;
  }
  return `${col}_desc` as HistorySort;
}

/** "today" / "yesterday" / "12d ago" / "5w ago" / "1.2y ago" / "—". */
export function daysAgoLabel(daysSince: number | null): string {
  if (daysSince == null) return '—';
  if (daysSince === 0) return 'today';
  if (daysSince === 1) return 'yesterday';
  if (daysSince < 30) return `${daysSince}d ago`;
  if (daysSince < 365) return `${Math.round(daysSince / 7)}w ago`;
  return `${Math.round((daysSince / 365) * 10) / 10}y ago`;
}

// --- Spend trend ---

export interface SpendStats {
  lastTotal: number;
  lastDate: string;
  last5Avg: number;
  last30Total: number;
  tripCount: number;
  /** last 8 trip totals, oldest → newest, for the sparkline */
  sparkData: number[];
}

export function computeSpendStats(trips: KitchenTrip[], now: Date = new Date()): SpendStats | null {
  const valid = (trips || []).filter((t) => typeof t.total === 'number' && (t.total as number) > 0);
  if (!valid.length) return null;
  const sorted = valid.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const totals = sorted.map((t) => t.total as number);
  const last = sorted[sorted.length - 1];
  const last5 = totals.slice(-5);
  const last5Avg = last5.reduce((s, x) => s + x, 0) / last5.length;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const last30Total = sorted
    .filter((t) => (t.date || '') >= cutoffStr)
    .reduce((s, t) => s + (t.total as number), 0);
  return {
    lastTotal: last.total as number,
    lastDate: last.date || '',
    last5Avg,
    last30Total,
    tripCount: valid.length,
    sparkData: totals.slice(-8),
  };
}
