/**
 * Pure archivals catalog logic ported from static/js/archivals.js —
 * search/filter/sort (itself a port of the standalone inventory-app's
 * useInventoryData.js), the seeded shuffle for stable Random order, and the
 * small formatting helpers. No DOM, no fetch.
 */
import type { ArchivalItem } from './types';

export const ARCH_SECONDHAND = ['new', 'secondhand', 'handmade', 'unknown'] as const;

export const ARCH_DEFAULT_CATEGORIES = ['clothing', 'jewelry', 'sentimental', 'bedding', 'other'];

export type ArchSort = 'newest' | 'oldest' | 'az' | 'random';
export type ArchViewMode = 'cloud' | 'cards' | 'table';

export const ARCH_VIEW_MODE_STORAGE_KEY = 'archViewMode';

export interface ArchFilters {
  categories: string[];
  subcategories: string[];
  sources: string[];
  gifted: boolean | null;
  materials: string[];
}

/** The one filter group to skip when computing chip counts ("how many items
 * would match if this group's own filter weren't applied"). */
export type ArchFilterExclude = 'category' | 'subcategory' | 'source' | 'gifted' | 'materials' | null;

export function emptyFilters(): ArchFilters {
  return { categories: [], subcategories: [], sources: [], gifted: null, materials: [] };
}

export function matchesSearch(item: ArchivalItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.name, item.description, item.origin, item.category, item.subcategory].some((v) =>
    (v || '').toLowerCase().includes(q),
  );
}

export function matchesFilters(
  item: ArchivalItem,
  filters: ArchFilters,
  exclude: ArchFilterExclude = null,
): boolean {
  const cat = (item.category || '').trim();

  if (exclude !== 'category' && filters.categories.length && !filters.categories.includes(cat)) {
    return false;
  }

  if (exclude !== 'subcategory' && cat === 'clothing' && filters.subcategories.length) {
    const sub = (item.subcategory || '').trim();
    const isUncat = !sub;
    if (filters.subcategories.includes('uncategorized') && isUncat) {
      // passes
    } else if (!filters.subcategories.includes(sub)) {
      return false;
    }
  }

  if (exclude !== 'source' && filters.sources.length && !filters.sources.includes(item.secondhand || '')) {
    return false;
  }

  if (exclude !== 'gifted' && filters.gifted !== null) {
    const isGifted = item.gifted === 'yes';
    if (filters.gifted && !isGifted) return false;
    if (!filters.gifted && isGifted) return false;
  }

  if (exclude !== 'materials' && filters.materials.length) {
    const names = (item.materials || []).map((m) => m.material);
    if (!filters.materials.some((m) => names.includes(m))) return false;
  }

  return true;
}

export function getFilteredItems(
  items: ArchivalItem[],
  query: string,
  filters: ArchFilters,
  exclude: ArchFilterExclude = null,
): ArchivalItem[] {
  return items.filter((item) => matchesSearch(item, query) && matchesFilters(item, filters, exclude));
}

export function activeFilterCount(filters: ArchFilters): number {
  return (
    filters.categories.length +
    filters.subcategories.length +
    filters.sources.length +
    (filters.gifted !== null ? 1 : 0) +
    filters.materials.length
  );
}

/** Seeded shuffle (mulberry32) — same seed always produces the same order, so
 * re-renders triggered by polling don't reshuffle Random view underfoot. */
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = (seed >>> 0) || 1;
  function rand(): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sortArchivals(items: ArchivalItem[], sort: ArchSort, randomSeed: number): ArchivalItem[] {
  if (sort === 'oldest') {
    return [...items].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  }
  if (sort === 'az') {
    return [...items].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  if (sort === 'random') return seededShuffle(items, randomSeed);
  // newest
  return [...items].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

export function emptyMessage(totalCount: number): string {
  return totalCount === 0 ? 'Nothing catalogued yet — add your first thing' : 'Nothing matches';
}

export function allCategories(items: ArchivalItem[]): string[] {
  return [...new Set(items.map((i) => (i.category || '').trim()).filter(Boolean))].sort();
}

export function allMaterials(items: ArchivalItem[]): string[] {
  return [
    ...new Set(items.flatMap((i) => (i.materials || []).map((m) => m.material).filter(Boolean))),
  ].sort();
}

/** Distinct non-empty subcategories among clothing items, A-Z. */
export function clothingSubcategories(items: ArchivalItem[]): string[] {
  return [
    ...new Set(
      items
        .filter((i) => (i.category || '').trim() === 'clothing' && (i.subcategory || '').trim())
        .map((i) => (i.subcategory || '').trim()),
    ),
  ].sort();
}

/** Modal datalist: seed categories plus anything already in use, A-Z. */
export function knownArchCategories(items: ArchivalItem[]): string[] {
  const cats = new Set(ARCH_DEFAULT_CATEGORIES);
  items.forEach((i) => {
    if (i.category) cats.add(i.category);
  });
  return [...cats].sort();
}

/** materials list → 'Cotton 80, Polyester 20' (the modal's freeform field). */
export function materialsText(item: Pick<ArchivalItem, 'materials'>): string {
  return (item.materials || [])
    .map((m) => (m.percentage != null ? `${m.material} ${m.percentage}` : m.material))
    .join(', ');
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** '2025-12-17T21:18:18.683397' → 'Dec 17, 2025' (with time for the modal meta). */
export function formatArchDate(ts: string | undefined, withTime = false): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts.slice(0, 10);
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleString(undefined, opts);
}

/** Main-photo URL ('' when the item has no photos). */
export function archPhotoUrl(item: Pick<ArchivalItem, 'photos'>): string {
  const p = (item.photos || [])[0];
  return p ? `/archivals/photo/${encodeURIComponent(p.filename)}` : '';
}
