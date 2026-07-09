import { describe, expect, it } from 'vitest';
import {
  addKnownCategory,
  buildSelections,
  deriveLearnRules,
  isUncategorized,
  merchantKey,
  setRowCategory,
  setRowInclude,
  summarizeCsvRows,
  truncateDesc,
} from './csvImport';
import type { CsvRow } from './types';

function row(partial: Partial<CsvRow>): CsvRow {
  return { date: '2026-07-01', desc: 'SHELL SERVICE 123', amount: -10, category: '', include: true, ...partial };
}

describe('merchantKey', () => {
  it('takes the first two lowercased words, punctuation stripped', () => {
    expect(merchantKey('SHELL SERVICE STATION AUSTIN TX')).toBe('shell service');
    expect(merchantKey('H-E-B #476 AUSTIN')).toBe('h-e-b 476');
  });

  it('keeps * and - like the old regex', () => {
    expect(merchantKey('SQ *COFFEE SHOP')).toBe('sq *coffee');
  });

  it('returns empty for empty descriptions', () => {
    expect(merchantKey('')).toBe('');
  });
});

describe('summarizeCsvRows', () => {
  it('counts and totals included rows by absolute amount', () => {
    const rows = [
      row({ amount: -10, category: 'Gas' }),
      row({ amount: 20, category: 'Income' }),
      row({ amount: -99, include: false }),
      row({ amount: -5, category: '' }),
      row({ amount: -1, category: 'Uncategorized' }),
    ];
    const s = summarizeCsvRows(rows);
    expect(s.includedCount).toBe(4);
    expect(s.includedTotal).toBe(36);
    expect(s.uncategorizedIncluded).toBe(2);
  });
});

describe('row edits', () => {
  it('setRowCategory / setRowInclude replace one row immutably', () => {
    const rows = [row({}), row({})];
    const next = setRowCategory(rows, 1, 'Fun');
    expect(next[1].category).toBe('Fun');
    expect(next[0]).toBe(rows[0]);
    expect(rows[1].category).toBe('');

    const toggled = setRowInclude(rows, 0, false);
    expect(toggled[0].include).toBe(false);
    expect(rows[0].include).toBe(true);
  });

  it('addKnownCategory inserts sorted without duplicates', () => {
    expect(addKnownCategory(['Fun', 'Rent'], 'Coffee')).toEqual(['Coffee', 'Fun', 'Rent']);
    expect(addKnownCategory(['Fun'], 'Fun')).toEqual(['Fun']);
    expect(addKnownCategory(['Fun'], '  ')).toEqual(['Fun']);
  });
});

describe('buildSelections', () => {
  it('keeps only included rows, defaulting category to Uncategorized', () => {
    const sel = buildSelections([
      row({ desc: 'A', category: 'Gas' }),
      row({ desc: 'B', include: false }),
      row({ desc: 'C', category: '' }),
    ]);
    expect(sel).toHaveLength(2);
    expect(sel[0]).toEqual({ date: '2026-07-01', desc: 'A', amount: -10, category: 'Gas' });
    expect(sel[1].category).toBe('Uncategorized');
  });
});

describe('deriveLearnRules', () => {
  it('emits one rule per merchant key from included categorized rows', () => {
    const rules = deriveLearnRules([
      row({ desc: 'SHELL SERVICE 1', category: 'Gas' }),
      row({ desc: 'SHELL SERVICE 2', category: 'Gas' }), // same key — deduped
      row({ desc: 'HEB GROCERY', category: 'Groceries' }),
      row({ desc: 'MYSTERY SHOP', category: 'Uncategorized' }), // skipped
      row({ desc: 'SKIPPED SHOP', category: 'Fun', include: false }), // skipped
    ]);
    expect(rules).toEqual([
      { match: 'shell service', category: 'Gas' },
      { match: 'heb grocery', category: 'Groceries' },
    ]);
  });
});

describe('display helpers', () => {
  it('isUncategorized treats empty and the literal as uncategorized', () => {
    expect(isUncategorized('')).toBe(true);
    expect(isUncategorized(undefined)).toBe(true);
    expect(isUncategorized('Uncategorized')).toBe(true);
    expect(isUncategorized('Gas')).toBe(false);
  });

  it('truncateDesc cuts at 60 with an ellipsis', () => {
    const long = 'x'.repeat(70);
    expect(truncateDesc(long)).toBe('x'.repeat(60) + '…');
    expect(truncateDesc('short')).toBe('short');
  });
});
