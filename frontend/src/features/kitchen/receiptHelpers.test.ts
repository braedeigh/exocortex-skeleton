import { describe, expect, it } from 'vitest';
import {
  buildLearnRules,
  countConfirmed,
  locationOptions,
  locationValue,
  parseLocationVal,
  prefillAisles,
  rowIsSorted,
  snapRowToCatalog,
  suggestCatalogName,
} from './receiptHelpers';
import type { ReceiptRow } from './types';

function row(over: Partial<ReceiptRow> = {}): ReceiptRow {
  return { name: 'HEB ORG BROCCOLI', qty: 1, price: 2.5, category: '', catalog_name: '', include: true, ...over };
}

describe('locationValue / parseLocationVal', () => {
  it('round-trips a section', () => {
    expect(locationValue('dairy', null)).toBe('section:dairy');
    expect(parseLocationVal('section:dairy')).toEqual({ category: 'dairy', aisle: null });
  });

  it('round-trips an aisle', () => {
    expect(locationValue('@aisles', 7)).toBe('aisle:7');
    expect(parseLocationVal('aisle:7')).toEqual({ category: '@aisles', aisle: 7 });
  });

  it('empty means unset', () => {
    expect(locationValue('', null)).toBe('');
    expect(parseLocationVal('')).toEqual({ category: '', aisle: null });
  });
});

describe('locationOptions', () => {
  it('unpacks @aisles into Aisle 1–30 at its slot and appends + New section', () => {
    const opts = locationOptions(['fruit', '@aisles', 'dairy']);
    expect(opts[0]).toEqual({ value: 'section:fruit', label: 'Fruit' });
    expect(opts[1]).toEqual({ value: 'aisle:1', label: 'Aisle 1' });
    expect(opts[30]).toEqual({ value: 'aisle:30', label: 'Aisle 30' });
    expect(opts[31].value).toBe('section:dairy');
    expect(opts.some((o) => o.value === 'section:household')).toBe(true);
    expect(opts[opts.length - 1].value).toBe('__new_section__');
  });

  it('can omit the + New section option', () => {
    const opts = locationOptions(['fruit'], { includeNewOpt: false });
    expect(opts.some((o) => o.value === '__new_section__')).toBe(false);
  });
});

describe('suggestCatalogName', () => {
  it('strips brand/marketing words down toward the core noun', () => {
    // Parity note: standalone unit words go first, so a trailing bare number
    // survives — this matches the old _suggestCatalogName exactly.
    expect(suggestCatalogName('HEB ORG BROCCOLI 12 OZ')).toBe('broccoli 12');
    expect(suggestCatalogName('HEB ORG BROCCOLI')).toBe('broccoli');
  });

  it('keeps at most the first two significant words', () => {
    expect(suggestCatalogName('QUAKER OLD FASHIONED ROLLED OATS')).toBe('old fashioned');
  });

  it('handles empty input', () => {
    expect(suggestCatalogName('')).toBe('');
  });
});

describe('rowIsSorted / countConfirmed', () => {
  it('only user-touched rows count as sorted', () => {
    expect(rowIsSorted(row())).toBe(false);
    expect(rowIsSorted(row({ user_touched: true }))).toBe(true);
  });

  it('counts confirmed rows and detects all-confirmed', () => {
    const rows = [row({ user_touched: true }), row()];
    expect(countConfirmed(rows)).toEqual({ sorted: 1, total: 2, allConfirmed: false });
    rows[1].user_touched = true;
    expect(countConfirmed(rows).allConfirmed).toBe(true);
  });
});

describe('buildLearnRules', () => {
  it('learns from included rows with a catalog name and a ≥3-char first word', () => {
    const rules = buildLearnRules([
      row({ name: 'HEB BROCCOLI', catalog_name: 'broccoli', category: 'vegetables' }),
      row({ name: 'ab short', catalog_name: 'thing' }), // first word too short
      row({ name: 'MILK', catalog_name: '' }), // no catalog name
      row({ name: 'EGGS LG', catalog_name: 'eggs', include: false }), // excluded
    ]);
    expect(rules).toEqual([{ match: 'heb', category: 'vegetables', catalog_name: 'broccoli' }]);
  });
});

describe('prefillAisles', () => {
  it('fills aisle from the catalog map only when unset and matched', () => {
    const rows = prefillAisles(
      [
        row({ catalog_name: 'chips' }),
        row({ catalog_name: 'chips', aisle: 4 }),
        row({ catalog_name: '' }),
      ],
      { chips: 12 },
    );
    expect(rows[0].aisle).toBe(12);
    expect(rows[1].aisle).toBe(4);
    expect(rows[2].aisle).toBeUndefined();
  });
});

describe('snapRowToCatalog', () => {
  const known = { broccoli: 'vegetables' };
  const aisles = { chips: 12 };

  it('stored aisle wins over the catalog category', () => {
    const r = snapRowToCatalog(row(), 'chips', known, aisles);
    expect(r.category).toBe('@aisles');
    expect(r.aisle).toBe(12);
    expect(r.user_touched).toBe(true);
  });

  it('falls back to the catalog category and clears the aisle', () => {
    const r = snapRowToCatalog(row({ aisle: 3 }), 'broccoli', known, aisles);
    expect(r.category).toBe('vegetables');
    expect(r.aisle).toBeNull();
  });

  it('leaves location untouched for an unknown catalog item', () => {
    const r = snapRowToCatalog(row({ category: 'other' }), 'mystery', known, aisles);
    expect(r.category).toBe('other');
    expect(r.catalog_name).toBe('mystery');
  });
});
