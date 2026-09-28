import { describe, expect, it } from 'vitest';
import {
  addKnownCategory,
  buildSelections,
  confirmAll,
  countConfirmed,
  deriveLearnLabels,
  deriveLearnRules,
  groupByMonth,
  identifyRow,
  isRefund,
  setRowOneTime,
  merchantKey,
  prepareRows,
  setRowInclude,
  summarizeCsvRows,
} from './csvImport';
import type { CsvRow } from './types';

function row(partial: Partial<CsvRow>): CsvRow {
  return { date: '2026-07-01', desc: 'SHELL SERVICE 07/01 PURCHASE AUSTIN TX', amount: -10, category: '', include: true, ...partial };
}

describe('merchantKey', () => {
  it('keys on the merchant, not the first two words of the line', () => {
    expect(merchantKey('TST*COSMIC COFFEE - EAS 07/15 MOBILE PURCHASE Austin TX')).toBe('cosmic coffee');
    expect(merchantKey('H-E-B #476 07/01 PURCHASE AUSTIN TX')).toBe('h-e-b');
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

describe('identifying rows', () => {
  it('prepareRows keeps a learned name and guesses the rest', () => {
    const [learned, guessed] = prepareRows([row({ title: 'Gas' }), row({ desc: 'TST*THAI FRESH 03/21 PURCHASE Austin TX' })]);
    expect(learned).toMatchObject({ title: 'Gas', learned_title: 'Gas' });
    expect(guessed).toMatchObject({ title: 'Thai Fresh', learned_title: '' });
  });

  it('identifyRow confirms the edited row and fills its untouched same-merchant rows', () => {
    const rows = [
      row({}),
      row({ date: '2026-07-09', desc: 'SHELL SERVICE 07/09 PURCHASE AUSTIN TX' }),
      row({ desc: 'SHELL SERVICE 07/12 PURCHASE AUSTIN TX', category: 'Car', user_touched: true }),
      row({ desc: 'H-E-B #1 07/02 PURCHASE' }),
    ];
    const next = identifyRow(rows, 0, { category: 'Gas' });
    expect(next[0]).toMatchObject({ category: 'Gas', user_touched: true });
    expect(next[1]).toMatchObject({ category: 'Gas' });
    expect(next[1].user_touched).toBeUndefined(); // filled, still to confirm
    expect(next[2].category).toBe('Car'); // she already decided that one
    expect(next[3]).toBe(rows[3]);
    expect(rows[0].category).toBe(''); // immutable
  });

  it('setRowInclude toggles one row and counts as touching it', () => {
    const next = setRowInclude([row({}), row({})], 0, false);
    expect(next[0]).toMatchObject({ include: false, user_touched: true });
  });

  it('countConfirmed only counts included rows', () => {
    const rows = [row({ user_touched: true }), row({}), row({ include: false })];
    expect(countConfirmed(rows)).toEqual({ confirmed: 1, total: 2, allConfirmed: false });
    expect(countConfirmed(confirmAll(rows)).allConfirmed).toBe(true);
  });

  it('addKnownCategory inserts sorted without duplicates', () => {
    expect(addKnownCategory(['Fun', 'Rent'], 'Coffee')).toEqual(['Coffee', 'Fun', 'Rent']);
    expect(addKnownCategory(['Fun'], 'Fun')).toEqual(['Fun']);
    expect(addKnownCategory(['Fun'], '  ')).toEqual(['Fun']);
  });
});

describe('groupByMonth', () => {
  it('splits rows by month in statement order, totalling included money out and in', () => {
    const groups = groupByMonth([
      row({ date: '2026-07-01', amount: -10 }),
      row({ date: '2026-07-20', amount: 500, category: 'Income' }),
      row({ date: '2026-07-21', amount: -99, include: false }),
      row({ date: '2026-08-02', amount: -5 }),
    ]);
    expect(groups.map((g) => [g.label, g.rows.length, g.moneyOut, g.moneyIn])).toEqual([
      ['July 2026', 3, 10, 500],
      ['August 2026', 1, 5, 0],
    ]);
    expect(groups[1].rows[0].index).toBe(3);
  });
});

describe('buildSelections', () => {
  it('keeps only included rows, defaulting category to Uncategorized and carrying the name', () => {
    const sel = buildSelections([
      row({ desc: 'A', category: 'Gas', title: ' Shell ' }),
      row({ desc: 'B', include: false }),
      row({ desc: 'C', category: '' }),
    ]);
    expect(sel).toHaveLength(2);
    expect(sel[0]).toEqual({ date: '2026-07-01', desc: 'A', amount: -10, category: 'Gas', title: 'Shell' });
    expect(sel[1]).toMatchObject({ category: 'Uncategorized', title: '' });
  });
});

describe('learning', () => {
  it('deriveLearnRules emits one category rule per merchant from included categorized rows', () => {
    const rules = deriveLearnRules([
      row({ category: 'Gas' }),
      row({ desc: 'SHELL SERVICE 07/09 PURCHASE', category: 'Gas' }), // same merchant — deduped
      row({ desc: 'H-E-B #9 07/03 PURCHASE', category: 'Groceries' }),
      row({ desc: 'MYSTERY SHOP 07/04 PURCHASE', category: 'Uncategorized' }), // skipped
      row({ desc: 'SKIPPED SHOP 07/05 PURCHASE', category: 'Fun', include: false }), // skipped
    ]);
    expect(rules).toEqual([
      { match: 'shell service', category: 'Gas' },
      { match: 'h-e-b', category: 'Groceries' },
    ]);
  });

  it('deriveLearnLabels learns only names she taught', () => {
    const labels = deriveLearnLabels([
      row({ title: 'Shell Service' }), // just the guess — nothing taught
      row({ desc: 'TST*THAI FRESH 03/21 PURCHASE', title: 'Thai Fresh', learned_title: 'Thai Fresh' }),
      row({ desc: 'PAYPAL DES:INST XFER ID:UBER INDN:X', title: 'Uber rides' }),
      row({ desc: 'SQ *BOTTEGA 03/23 PURCHASE', title: 'Wine bar', include: false }),
    ]);
    expect(labels).toEqual([{ match: 'id:uber', title: 'Uber rides' }]);
  });
});

describe('refunds', () => {
  it('treats money in under a spending category as a refund, and income or transfers as not', () => {
    expect(isRefund(row({ amount: 290.11, category: 'Recreation' }))).toBe(true);
    expect(isRefund(row({ amount: 4401.6, category: 'Income' }))).toBe(false);
    expect(isRefund(row({ amount: 50, category: 'Transfer (in)' }))).toBe(false);
    expect(isRefund(row({ amount: -12, category: 'Recreation' }))).toBe(false);
  });

  it('takes a refund off the month\'s money out instead of counting it as money in', () => {
    const [july] = groupByMonth([
      row({ amount: -100, category: 'Recreation' }),
      row({ amount: 30, category: 'Recreation' }),
      row({ amount: 500, category: 'Income' }),
    ]);
    expect([july.moneyOut, july.moneyIn]).toEqual([70, 500]);
  });
});

describe('one-time things in the statement preview', () => {
  const rows = [
    { date: '2026-09-02', desc: 'FUTON SHOP 123', amount: -499, category: 'Home', include: true, title: 'Futon Shop' },
    { date: '2026-09-09', desc: 'FUTON SHOP 123', amount: -20, category: 'Home', include: true, title: 'Futon Shop' },
  ];

  it('marks only the row she tapped, not the merchant\'s other rows', () => {
    const next = setRowOneTime(rows, 0, { name: 'Mattress', shelf: 'durables' });
    expect(next[0].one_time).toEqual({ name: 'Mattress', shelf: 'durables' });
    expect(next[0].user_touched).toBe(true);
    expect(next[1].one_time).toBeUndefined();
  });

  it('sends the one-time thing on import, naming it after the row when left blank', () => {
    const marked = setRowOneTime(rows, 0, { name: '  ', shelf: 'consumables' });
    const [first, second] = buildSelections(marked);
    expect(first.one_time).toEqual({ name: 'Futon Shop', shelf: 'consumables' });
    expect(second.one_time).toBeUndefined();
  });
});
