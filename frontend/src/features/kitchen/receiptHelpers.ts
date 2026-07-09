/**
 * receiptHelpers.ts — pure logic for the receipt-import review modal:
 * the unified location <select> (sections + Aisle 1–30), receipt-row parsing
 * (catalog-name suggestion from raw line text), row-confirmation state, and
 * the learn-rules payload built on import. Ports kitchen.js's
 * _locationOptionsHtml/_parseLocationVal/_suggestCatalogName/_rowIsSorted/
 * submitReceiptImport.
 */
import { AISLES_SENTINEL } from './catalogHelpers';
import type { ReceiptRow } from './types';

export const MAX_AISLE = 30;

const LOCATION_LABELS: Record<string, string> = {
  produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
  protein: 'Protein / Meat', dairy: 'Dairy', grains: 'Grains',
  drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert', other: 'Other',
  pharmacy: 'Pharmacy', supplements: 'Supplements', meat: 'Meat',
  household: 'Household',
};

export interface LocationOption {
  value: string;
  label: string;
}

/** Selected-value form: 'section:<name>' | 'aisle:<N>' | '' for unset. */
export function locationValue(category?: string | null, aisle?: number | null): string {
  if (category === AISLES_SENTINEL && aisle != null) return `aisle:${aisle}`;
  return category ? `section:${category}` : '';
}

/** Options for the combined location picker, ordered by category_order with
 * '@aisles' unpacked into Aisle 1–30. */
export function locationOptions(
  categoryOrder: string[],
  opts: { includeNewOpt?: boolean } = {},
): LocationOption[] {
  const order = categoryOrder.slice();
  if (!order.includes('household')) {
    // mirror _ensureHousehold — household is selectable everywhere
    order.push('household');
  }
  const out: LocationOption[] = [];
  order.forEach((slot) => {
    if (slot === AISLES_SENTINEL) {
      for (let n = 1; n <= MAX_AISLE; n++) {
        out.push({ value: `aisle:${n}`, label: `Aisle ${n}` });
      }
    } else {
      out.push({ value: `section:${slot}`, label: LOCATION_LABELS[slot] || slot });
    }
  });
  if (opts.includeNewOpt !== false) out.push({ value: '__new_section__', label: '+ New section…' });
  return out;
}

/** Inverse of locationValue: '' → unset, 'aisle:N' → {'@aisles', N}, 'section:x' → {x, null}. */
export function parseLocationVal(v: string): { category: string; aisle: number | null } {
  if (!v) return { category: '', aisle: null };
  if (v.startsWith('aisle:')) {
    const n = parseInt(v.slice(6), 10) || null;
    return { category: AISLES_SENTINEL, aisle: n };
  }
  if (v.startsWith('section:')) {
    return { category: v.slice(8), aisle: null };
  }
  return { category: '', aisle: null };
}

/** Strip store/brand prefixes + size suffixes from a raw receipt line, keep
 * the core noun (first 2 words). "HEB ORG BROCCOLI 12 OZ" → "broccoli". */
export function suggestCatalogName(rawName: string): string {
  let s = (rawName || '').toLowerCase();
  s = s.replace(/\b(heb|hb|cm|sel|kozy|shack|bnl|bobs?|red mill|quakr|quaker|goodflow|hsy|gv)\b/g, '');
  s = s.replace(/\b(org|organic|cage free|brown|lg|eg|fw|f|w|lb|lbs|oz|ct|pk|pack|bag|jar|can|bottle|whole|raw|natural|fresh)\b/g, '');
  s = s.replace(/\b\d+\s*(oz|lb|lbs|ct|pk|g|kg|ml|l)\b/g, '');
  s = s.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').slice(0, 2).join(' ');
}

/** "Sorted" = the user has touched this row. Algorithm-prefilled rows still
 * need confirmation (tap the row OR change any field). */
export function rowIsSorted(r: ReceiptRow | undefined | null): boolean {
  return !!(r && r.user_touched);
}

export function countConfirmed(rows: ReceiptRow[]): { sorted: number; total: number; allConfirmed: boolean } {
  const sorted = rows.filter(rowIsSorted).length;
  return { sorted, total: rows.length, allConfirmed: sorted === rows.length };
}

export interface LearnRule {
  match: string;
  category: string;
  catalog_name: string;
}

/** Learn a rules-parser hint for every included row with a catalog_name and a
 * unique-ish match key (first word of the raw name, ≥3 chars). */
export function buildLearnRules(rows: ReceiptRow[]): LearnRule[] {
  const out: LearnRule[] = [];
  rows.forEach((r) => {
    if (!r.include || !r.catalog_name) return;
    const firstWord = (r.name || '').toLowerCase().split(/\s+/).filter(Boolean)[0];
    if (firstWord && firstWord.length >= 3) {
      out.push({ match: firstWord, category: r.category, catalog_name: r.catalog_name });
    }
  });
  return out;
}

/** Pre-fill each row's aisle from the catalog's stored aisle map when the
 * parser matched a catalog item but no aisle came back. */
export function prefillAisles(rows: ReceiptRow[], aislesMap: Record<string, number>): ReceiptRow[] {
  return rows.map((r) => {
    if (r.aisle == null && r.catalog_name && aislesMap[r.catalog_name] != null) {
      return { ...r, aisle: aislesMap[r.catalog_name] };
    }
    return r;
  });
}

/** Where a row's location should snap after picking a catalog item: stored
 * aisle wins, else the catalog category, else leave the row untouched. */
export function snapRowToCatalog(
  row: ReceiptRow,
  catalogName: string,
  known: Record<string, string>,
  aislesMap: Record<string, number>,
): ReceiptRow {
  const next: ReceiptRow = { ...row, catalog_name: catalogName, user_touched: true };
  const storedAisle = aislesMap[catalogName];
  const inferredCat = known[catalogName];
  if (storedAisle != null) {
    next.category = AISLES_SENTINEL;
    next.aisle = storedAisle;
  } else if (inferredCat) {
    next.category = inferredCat;
    next.aisle = null;
  }
  return next;
}
