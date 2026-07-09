import { describe, expect, it } from 'vitest';
import {
  allKnownCategories,
  breakdownColorFor,
  BREAKDOWN_PALETTE,
  daysUntil,
  dollars,
  drillTransactions,
  expensesInMonth,
  formatMoney,
  grandTotals,
  groupByMonth,
  incomeGauge,
  monthBars,
  monthLabel,
  ordinal,
  recentExpenses,
  recentTaxLog,
  renewalUrgency,
  setAsideSummary,
  sortSubscriptions,
  spentByCategory,
  subscriptionsMonthlyTotal,
  thisMonthKey,
  thisMonthSummary,
} from './moneyMath';
import type { Expense, Subscription } from './types';

function exp(partial: Partial<Expense>): Expense {
  return { id: 'x', amount: 0, ...partial };
}

describe('formatMoney', () => {
  it('formats to two decimals with a dollar sign', () => {
    expect(formatMoney(12.5, false)).toBe('$12.50');
    expect(formatMoney('3', false)).toBe('$3.00');
  });

  it('coerces junk to $0.00', () => {
    expect(formatMoney(undefined, false)).toBe('$0.00');
    expect(formatMoney('nope', false)).toBe('$0.00');
  });

  it('masks every amount in public mode', () => {
    expect(formatMoney(1234.56, true)).toBe('$•••');
    expect(dollars(1234.56)).toBe('$1234.56');
  });
});

describe('month helpers', () => {
  it('builds YYYY-MM with zero padding', () => {
    expect(thisMonthKey(new Date(2026, 0, 15))).toBe('2026-01');
    expect(thisMonthKey(new Date(2026, 10, 1))).toBe('2026-11');
  });

  it('filters expenses by month prefix', () => {
    const items = [exp({ date: '2026-07-01' }), exp({ date: '2026-06-30' }), exp({})];
    expect(expensesInMonth(items, '2026-07')).toHaveLength(1);
  });

  it('labels a month key in English', () => {
    expect(monthLabel('2026-07')).toBe('July 2026');
  });
});

describe('spentByCategory', () => {
  it('tallies by category with Uncategorized fallback', () => {
    const tally = spentByCategory([
      exp({ amount: 10, category: 'Groceries' }),
      exp({ amount: 5, category: 'Groceries' }),
      exp({ amount: 2 }),
    ]);
    expect(tally).toEqual({ Groceries: 15, Uncategorized: 2 });
  });
});

describe('thisMonthSummary', () => {
  const budget = {
    income_monthly: 3000,
    categories: [
      { name: 'Groceries', planned: 100, type: 'variable' },
      { name: 'Rent', planned: 1000, type: 'fixed' },
      { name: 'Emergency', planned: 200, type: 'savings' },
    ],
  };

  it('excludes savings categories and totals the rest', () => {
    const s = thisMonthSummary(budget, [exp({ amount: 90, category: 'Groceries' })]);
    expect(s.rows.map((r) => r.name)).toEqual(['Groceries', 'Rent']);
    expect(s.totalSpent).toBe(90);
    expect(s.totalPlanned).toBe(1100);
  });

  it('colors bars green → yellow past 80% → red when over', () => {
    const green = thisMonthSummary(budget, [exp({ amount: 50, category: 'Groceries' })]).rows[0];
    const yellow = thisMonthSummary(budget, [exp({ amount: 90, category: 'Groceries' })]).rows[0];
    const red = thisMonthSummary(budget, [exp({ amount: 150, category: 'Groceries' })]).rows[0];
    expect(green.barColor).toBe('var(--green)');
    expect(yellow.barColor).toBe('var(--yellow)');
    expect(red.over).toBe(true);
    expect(red.barColor).toBe('var(--red)');
    expect(red.pct).toBe(100); // capped
  });
});

describe('subscriptions', () => {
  const today = new Date('2026-07-09T10:00:00');

  it('daysUntil matches the legacy noon-vs-midnight rounding', () => {
    // The old _daysUntil measured target-at-noon minus today-at-midnight and
    // Math.round()ed — so "today" reads as 1, tomorrow as 2. Kept as-is for
    // exact parity with what the old table displayed.
    expect(daysUntil('2026-07-09', today)).toBe(1);
    expect(daysUntil('2026-07-10', today)).toBe(2);
    expect(daysUntil(undefined, today)).toBeNull();
  });

  it('sorts by soonest renewal, undated last', () => {
    const subs: Subscription[] = [
      { name: 'NoDate', amount: 1 },
      { name: 'Far', amount: 1, next_renewal: '2026-09-01' },
      { name: 'Soon', amount: 1, next_renewal: '2026-07-11' },
    ];
    expect(sortSubscriptions(subs, today).map((s) => s.name)).toEqual(['Soon', 'Far', 'NoDate']);
  });

  it('computes monthly-equivalent total (yearly /12)', () => {
    const subs: Subscription[] = [
      { name: 'A', amount: 12, frequency: 'yearly' },
      { name: 'B', amount: 5, frequency: 'monthly' },
      { name: 'C', amount: 3 },
    ];
    expect(subscriptionsMonthlyTotal(subs)).toBe(9);
  });

  it('flags renewal urgency at 7 and 30 days', () => {
    expect(renewalUrgency(null)).toBe('none');
    expect(renewalUrgency(7)).toBe('soon');
    expect(renewalUrgency(8)).toBe('upcoming');
    expect(renewalUrgency(30)).toBe('upcoming');
    expect(renewalUrgency(31)).toBe('far');
  });

  it('ordinal renders English suffixes', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(21)).toBe('21st');
    expect(ordinal('')).toBe('');
  });
});

describe('breakdown aggregation', () => {
  it('breakdownColorFor is stable and stays in the palette', () => {
    const c = breakdownColorFor('Groceries');
    expect(c).toBe(breakdownColorFor('Groceries'));
    expect(BREAKDOWN_PALETTE).toContain(c);
  });

  it('monthBars sorts biggest first, pct relative to max, sharePct of total', () => {
    const bars = monthBars([
      exp({ amount: 30, category: 'Rent' }),
      exp({ amount: 10, category: 'Fun' }),
      exp({ amount: 10, category: 'Fun' }),
    ]);
    expect(bars.map((b) => b.category)).toEqual(['Rent', 'Fun']);
    expect(bars[0].pct).toBe(100);
    expect(bars[1].pct).toBeCloseTo((20 / 30) * 100);
    expect(bars[0].sharePct).toBeCloseTo(60);
    expect(bars[1].sharePct).toBeCloseTo(40);
  });

  it('groupByMonth returns newest month first and splits income from spending', () => {
    const groups = groupByMonth([
      exp({ date: '2026-06-02', amount: 50, category: 'Rent' }),
      exp({ date: '2026-07-01', amount: 100, category: 'Income' }),
      exp({ date: '2026-07-03', amount: 20, category: 'Fun' }),
      exp({ date: '2026-07-04', amount: 5, category: 'Savings/Transfer' }),
      exp({ amount: 999 }), // dateless rows are dropped
    ]);
    expect(groups.map((g) => g.monthKey)).toEqual(['2026-07', '2026-06']);
    expect(groups[0].totalIncome).toBe(100);
    expect(groups[0].totalSpent).toBe(20); // income + transfers excluded
    expect(groups[0].spendingOnly).toHaveLength(1);
  });

  it('grandTotals excludes income and transfers from spending', () => {
    const t = grandTotals([
      exp({ amount: 100, category: 'Income' }),
      exp({ amount: 30, category: 'Rent' }),
      exp({ amount: 10, category: 'Transfer (in)' }),
    ]);
    expect(t.grandSpent).toBe(30);
    expect(t.grandIncome).toBe(100);
  });

  it('drillTransactions matches Uncategorized fallback and sorts newest first', () => {
    const rows = drillTransactions(
      [exp({ id: 'a', date: '2026-07-01' }), exp({ id: 'b', date: '2026-07-05' }), exp({ id: 'c', date: '2026-07-03', category: 'Fun' })],
      'Uncategorized',
    );
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('incomeGauge', () => {
  it('is empty with no income and no spending', () => {
    expect(incomeGauge([exp({ amount: 10, category: 'Transfer (in)' })]).empty).toBe(true);
  });

  it('shows unspent tail when under income, no marker', () => {
    const g = incomeGauge([
      exp({ amount: 100, category: 'Income' }),
      exp({ amount: 60, category: 'Rent' }),
    ]);
    expect(g.leftover).toBe(40);
    expect(g.unspentPct).toBeCloseTo(40);
    expect(g.incomeMarkerPct).toBeNull();
    expect(g.segments[0].pct).toBeCloseTo(60);
  });

  it('marks the income line when overspent', () => {
    const g = incomeGauge([
      exp({ amount: 100, category: 'Income' }),
      exp({ amount: 150, category: 'Rent' }),
    ]);
    expect(g.leftover).toBe(-50);
    expect(g.unspentPct).toBe(0);
    expect(g.incomeMarkerPct).toBeCloseTo((100 / 150) * 100);
  });
});

describe('allKnownCategories', () => {
  it('merges budget + expense categories, deduped and sorted', () => {
    const cats = allKnownCategories(
      [{ name: 'Rent', planned: 0 }],
      [exp({ category: 'Fun' }), exp({ category: 'Rent' }), exp({})],
    );
    expect(cats).toEqual(['Fun', 'Rent']);
  });
});

describe('setAsideSummary (tax math)', () => {
  const expenses = [
    exp({ amount: 1000, category: 'Income', comments: 'VIDALA DES:PAYROLL' }),
    exp({ amount: 500, category: 'Income', comments: 'Vidala payroll' }),
    exp({ amount: 200, category: 'Income', comments: 'venmo cashout' }),
    exp({ amount: 300, category: 'Savings/Transfer', comments: 'transfer to savings' }),
  ];

  it('owes 25% of Vidala income minus what was set aside', () => {
    const s = setAsideSummary(expenses, [
      { id: 't1', date: '2026-07-01', amount: 100 },
      { id: 't2', date: '2026-06-01', amount: 50 },
    ]);
    expect(s.vidalaPaychecks).toHaveLength(2);
    expect(s.vidalaTotal).toBe(1500);
    expect(s.taxOwed).toBe(375);
    expect(s.taxAside).toBe(150);
    expect(s.taxBalance).toBe(225); // still owes
    expect(s.savingsTotal).toBe(300);
    expect(s.savings).toHaveLength(1);
  });

  it('goes negative (ahead) when set-aside exceeds the obligation', () => {
    const s = setAsideSummary(expenses, [{ id: 't', amount: 400 }]);
    expect(s.taxBalance).toBe(-25);
  });

  it('recentTaxLog sorts newest first, capped at 8', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      amount: 1,
    }));
    const log = recentTaxLog(entries);
    expect(log).toHaveLength(8);
    expect(log[0].date).toBe('2026-01-10');
  });
});

describe('recentExpenses', () => {
  it('sorts newest first and caps at 30 with a total count', () => {
    const items = Array.from({ length: 35 }, (_, i) =>
      exp({ id: String(i), date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}` }),
    );
    const { recent, total } = recentExpenses(items);
    expect(total).toBe(35);
    expect(recent).toHaveLength(30);
    expect(recent[0].date! >= recent[29].date!).toBe(true);
  });
});
