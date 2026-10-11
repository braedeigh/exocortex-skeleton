/**
 * moneyMath.ts — pure logic ported 1:1 from static/js/money.js: money
 * formatting (incl. the public $••• mask), month tallies, subscription
 * ordering/renewal urgency, the spending-breakdown aggregation (month bars +
 * income gauge), and the tax set-aside math.
 *
 * A refund is an expense with a negative amount in its spending category
 * (routes/money.py import_csv stores it that way), so every tally here nets it
 * off that category's spending; bar widths are floored at zero.
 */
import type { Budget, BudgetCategory, Expense, Subscription, TaxSetasideEntry } from './types';

/** Money figure for display. Public visitors see a masked placeholder ($•••)
 * in place of every dollar amount; the underlying values still power the
 * bars/percentages. (money.js _m) */
export function formatMoney(n: unknown, masked: boolean): string {
  if (masked) return '$•••';
  return dollars(n);
}

/** Plain, never-masked dollar figure — the auth-only Budget setup / Set Aside
 * cards printed raw values even in the old page. */
export function dollars(n: unknown): string {
  const value = Number(n) || 0;
  // A refund (negative) reads "−$16.53", with the minus ahead of the dollar sign.
  return (value < 0 ? '−$' : '$') + Math.abs(value).toFixed(2);
}

/** YYYY-MM for `now` (money.js _thisMonthKey). */
export function thisMonthKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function expensesInMonth(expenses: Expense[], monthKey: string): Expense[] {
  return expenses.filter((e) => (e.date || '').startsWith(monthKey));
}

export function spentByCategory(expenses: Expense[]): Record<string, number> {
  const tally: Record<string, number> = {};
  expenses.forEach((e) => {
    const c = e.category || 'Uncategorized';
    tally[c] = (tally[c] || 0) + (e.amount || 0);
  });
  return tally;
}

// --- This Month budget bars ---

export interface BudgetBarRow {
  name: string;
  spent: number;
  planned: number;
  /** Fill width 0–100 (capped). */
  pct: number;
  over: boolean;
  /** CSS var for the fill: red when over, yellow past 80%, else green. */
  barColor: string;
}

export interface ThisMonthSummary {
  rows: BudgetBarRow[];
  totalSpent: number;
  totalPlanned: number;
}

/** Non-savings budget categories vs this month's spending (renderThisMonth). */
export function thisMonthSummary(budget: Budget, monthExpenses: Expense[]): ThisMonthSummary {
  const cats = (budget.categories || []).filter((c) => c.type !== 'savings');
  const spent = spentByCategory(monthExpenses);
  let totalSpent = 0;
  let totalPlanned = 0;
  const rows = cats.map((c) => {
    const s = spent[c.name] || 0;
    const p = c.planned || 0;
    totalSpent += s;
    totalPlanned += p;
    const pct = p > 0 ? Math.max(0, Math.min(100, (s / p) * 100)) : 0;
    const over = p > 0 && s > p;
    const barColor = over ? 'var(--red)' : pct > 80 ? 'var(--yellow)' : 'var(--green)';
    return { name: c.name, spent: s, planned: p, pct, over, barColor };
  });
  return { rows, totalSpent, totalPlanned };
}

// --- Subscriptions ---

/** Whole days from `today` (midnight) to dateStr; null when unset (money.js _daysUntil). */
export function daysUntil(dateStr: string | undefined, today: Date = new Date()): number | null {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T12:00:00');
  const t = new Date(today);
  t.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - t.getTime()) / (1000 * 60 * 60 * 24));
}

/** 1 -> "1st", 22 -> "22nd" … empty for non-numbers (money.js _ordinal). */
export function ordinal(n: number | string): string {
  const num = parseInt(String(n), 10);
  if (!num) return '';
  const suf = ['th', 'st', 'nd', 'rd'];
  const v = num % 100;
  return num + (suf[(v - 20) % 10] || suf[v] || suf[0]);
}

/** Soonest renewal first; no-renewal-date subs sink to the bottom. */
export function sortSubscriptions(subs: Subscription[], today: Date = new Date()): Subscription[] {
  return [...subs].sort((a, b) => {
    const da = daysUntil(a.next_renewal, today);
    const db = daysUntil(b.next_renewal, today);
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
}

/** Monthly-equivalent total: yearly amounts /12. */
export function subscriptionsMonthlyTotal(subs: Subscription[]): number {
  let total = 0;
  subs.forEach((s) => {
    const amt = s.amount || 0;
    total += s.frequency === 'yearly' ? amt / 12 : amt;
  });
  return total;
}

export type RenewalUrgency = 'none' | 'soon' | 'upcoming' | 'far';

/** Red ≤7d, yellow ≤30d, muted otherwise (renderSubscriptions renewCell). */
export function renewalUrgency(days: number | null): RenewalUrgency {
  if (days === null) return 'none';
  if (days <= 7) return 'soon';
  if (days <= 30) return 'upcoming';
  return 'far';
}

// --- Spending breakdown (per-month bars + income gauge) ---

// Theme-owned hues (sky-theme.js re-skins them per phase) instead of the old
// hardcoded flat-UI hexes, so the bars belong to the same palette as the rest
// of the page in every sky phase. Mixes widen the family without new tokens.
export const BREAKDOWN_PALETTE = [
  'var(--accent)',
  'var(--green)',
  'var(--morning)',
  'var(--evening)',
  'var(--orange)',
  'var(--yellow)',
  'color-mix(in srgb, var(--accent) 55%, var(--green))',
  'var(--todo-3)',
  'color-mix(in srgb, var(--evening) 55%, var(--accent))',
  'color-mix(in srgb, var(--orange) 55%, var(--red))',
  'color-mix(in srgb, var(--accent) 45%, var(--text))',
  'color-mix(in srgb, var(--green) 55%, var(--evening))',
  'color-mix(in srgb, var(--red) 70%, var(--text))',
  'color-mix(in srgb, var(--text) 45%, var(--bg))',
];

/** Stable category → palette color (money.js _breakdownColorFor). */
export function breakdownColorFor(cat: string): string {
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return BREAKDOWN_PALETTE[h % BREAKDOWN_PALETTE.length];
}

/** Categories that don't count as spending (money.js SKIP set). */
export const NON_SPENDING_CATEGORIES = new Set(['income', 'savings/transfer', 'transfer (in)']);

export function isIncomeCategory(e: Expense): boolean {
  return (e.category || '').toLowerCase() === 'income';
}

export function isSpendingExpense(e: Expense): boolean {
  return !NON_SPENDING_CATEGORIES.has((e.category || '').toLowerCase());
}

export interface MonthBar {
  category: string;
  amount: number;
  /** Width relative to the month's biggest category, 0–100. */
  pct: number;
  /** Share of the month's spending, 0–100. */
  sharePct: number;
  color: string;
}

/** Per-category bars for one month, biggest first (money.js _renderMonthBars). */
export function monthBars(items: Expense[]): MonthBar[] {
  const tally = spentByCategory(items);
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  const max = Math.max(sorted[0]?.[1] || 0, 1);
  return sorted.map(([category, amount]) => ({
    category,
    amount,
    pct: Math.max(0, (amount / max) * 100),
    sharePct: total > 0 ? Math.max(0, (amount / total) * 100) : 0,
    color: breakdownColorFor(category),
  }));
}

export interface GaugeSegment {
  category: string;
  amount: number;
  pct: number;
  color: string;
}

export interface IncomeGauge {
  income: number;
  spent: number;
  leftover: number;
  segments: GaugeSegment[];
  /** Grey "unspent" tail, 0 when nothing left. */
  unspentPct: number;
  /** Vertical income line, only when overspent (spent > income > 0). */
  incomeMarkerPct: number | null;
  /** Both zero → old code rendered nothing. */
  empty: boolean;
}

/** Earned-vs-spent stacked bar for one month (money.js _renderIncomeGauge). */
export function incomeGauge(monthItems: Expense[]): IncomeGauge {
  const spendingItems = monthItems.filter(isSpendingExpense);
  const incomeItems = monthItems.filter(isIncomeCategory);
  const spent = spendingItems.reduce((s, e) => s + (e.amount || 0), 0);
  const income = incomeItems.reduce((s, e) => s + (e.amount || 0), 0);

  const tally = spentByCategory(spendingItems);
  const sortedCats = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const denom = Math.max(income, spent, 1);
  const segments = sortedCats.filter(([, amount]) => amount > 0).map(([category, amount]) => ({
    category,
    amount,
    pct: (amount / denom) * 100,
    color: breakdownColorFor(category),
  }));

  const leftover = income - spent;
  const unspentPct = leftover > 0 ? (leftover / denom) * 100 : 0;
  const incomeMarkerPct = spent > income && income > 0 ? (income / denom) * 100 : null;

  return {
    income,
    spent,
    leftover,
    segments,
    unspentPct,
    incomeMarkerPct,
    empty: income === 0 && spent === 0,
  };
}

/** Where one expense sits in the month's split: a one-time thing wins over
 * its category; otherwise the category's kind (a "Not recurring" category
 * lands with the one-time things); otherwise not sorted yet. */
export type SpendingKind = 'recurring' | 'cut_back' | 'one_time' | 'unsorted';

export function spendingKindOf(e: Expense, kindByCategory: Record<string, string>): SpendingKind {
  if (e.one_time) return 'one_time';
  const kind = kindByCategory[e.category || ''];
  return kind === 'recurring' || kind === 'cut_back' || kind === 'one_time' ? kind : 'unsorted';
}

export const SPENDING_KIND_LABELS: Record<SpendingKind, string> = {
  recurring: 'Recurring',
  cut_back: 'Can cut back',
  one_time: 'Not recurring',
  unsorted: 'Not sorted',
};

export interface KindShare {
  kind: SpendingKind;
  label: string;
  amount: number;
  /** Share of the month's spending, 0–100. */
  pct: number;
}

/** The month's spending split by kind — recurring needs, things she could cut
 * back on, one-time purchases, and whatever isn't sorted yet — in that fixed
 * order, skipping empty ones. Refunds net out inside their kind; a kind that
 * nets to zero or below is left out.
 * Prompt: "i want to know it was a 'one time purchase' vs. something that is
 * recurring. vs. coffee which is something i can cut back on". */
export function monthKindSplit(spendingItems: Expense[], categories: BudgetCategory[]): KindShare[] {
  const kindByCategory = kindsByName(categories);
  const totals: Record<SpendingKind, number> = { recurring: 0, cut_back: 0, one_time: 0, unsorted: 0 };
  spendingItems.forEach((e) => {
    totals[spendingKindOf(e, kindByCategory)] += e.amount || 0;
  });
  const order: SpendingKind[] = ['recurring', 'cut_back', 'one_time', 'unsorted'];
  const positive = order.filter((k) => totals[k] > 0);
  const sum = positive.reduce((s, k) => s + totals[k], 0);
  return positive.map((kind) => ({
    kind,
    label: SPENDING_KIND_LABELS[kind],
    amount: totals[kind],
    pct: sum > 0 ? (totals[kind] / sum) * 100 : 0,
  }));
}

/** Each category's kind by name, for spendingKindOf. */
function kindsByName(categories: BudgetCategory[]): Record<string, string> {
  const kindByCategory: Record<string, string> = {};
  categories.forEach((c) => {
    if (c.kind) kindByCategory[c.name] = c.kind;
  });
  return kindByCategory;
}

/** Split expenses into what counts toward the monthly totals and what's left
 * out: spending that won't come back (one-time things, and categories marked
 * "Not recurring"). Income and refunds of recurring spending always count.
 * Prompt: "hide certain things from the monthly total like household items or
 * therapy that will not be recurring". */
export function leaveOutNotRecurring(
  expenses: Expense[],
  categories: BudgetCategory[],
): { counted: Expense[]; leftOut: Expense[] } {
  const kindByCategory = kindsByName(categories);
  const counted: Expense[] = [];
  const leftOut: Expense[] = [];
  expenses.forEach((e) => {
    const out = isSpendingExpense(e) && spendingKindOf(e, kindByCategory) === 'one_time';
    (out ? leftOut : counted).push(e);
  });
  return { counted, leftOut };
}

export interface MonthGroup {
  monthKey: string;
  items: Expense[];
  spendingOnly: Expense[];
  totalSpent: number;
  totalIncome: number;
}

/** Expenses grouped by YYYY-MM, newest month first (renderSpendingBreakdown). */
export function groupByMonth(expenses: Expense[]): MonthGroup[] {
  const byMonth: Record<string, Expense[]> = {};
  expenses.forEach((e) => {
    const key = (e.date || '').substring(0, 7);
    if (!key) return;
    (byMonth[key] ||= []).push(e);
  });
  return Object.keys(byMonth)
    .sort()
    .reverse()
    .map((monthKey) => {
      const items = byMonth[monthKey];
      const spendingOnly = items.filter(isSpendingExpense);
      return {
        monthKey,
        items,
        spendingOnly,
        totalSpent: spendingOnly.reduce((s, e) => s + (e.amount || 0), 0),
        totalIncome: items.filter(isIncomeCategory).reduce((s, e) => s + (e.amount || 0), 0),
      };
    });
}

export interface GrandTotals {
  grandSpent: number;
  grandIncome: number;
}

export function grandTotals(expenses: Expense[]): GrandTotals {
  return {
    grandSpent: expenses.filter(isSpendingExpense).reduce((s, e) => s + (e.amount || 0), 0),
    grandIncome: expenses.filter(isIncomeCategory).reduce((s, e) => s + (e.amount || 0), 0),
  };
}

/** "July 2026" from a YYYY-MM key (noon avoids TZ back-shift). */
export function monthLabel(monthKey: string): string {
  return new Date(monthKey + '-01T12:00:00').toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

/** Transactions in `category` (Uncategorized = no category), newest first (drill-down). */
export function drillTransactions(items: Expense[], category: string): Expense[] {
  return items
    .filter((e) => (e.category || 'Uncategorized') === category)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/** Budget categories + every category observed on an expense, sorted (money.js _allKnownCategories). */
export function allKnownCategories(categories: BudgetCategory[], expenses: Expense[]): string[] {
  const fromBudget = categories.map((c) => c.name);
  const fromExpenses = expenses.map((e) => e.category).filter((c): c is string => !!c);
  return [...new Set([...fromBudget, ...fromExpenses])].sort();
}

// --- Set Aside (savings + tax obligation) ---

export const TAX_RATE = 0.25;

/** Income rows whose comments mention Vidala — paychecks the 25% applies to. */
export function vidalaIncome(expenses: Expense[]): Expense[] {
  return expenses.filter((e) => {
    const c = (e.comments || '').toLowerCase();
    return isIncomeCategory(e) && c.includes('vidala');
  });
}

/** Rows categorized Savings/Transfer (created during CSV import for "transfer to savings"). */
export function savingsTransfers(expenses: Expense[]): Expense[] {
  return expenses.filter((e) => (e.category || '').toLowerCase() === 'savings/transfer');
}

export interface SetAsideSummary {
  vidalaPaychecks: Expense[];
  vidalaTotal: number;
  taxOwed: number;
  taxAside: number;
  /** Positive → still owes; negative/zero → ahead. */
  taxBalance: number;
  savings: Expense[];
  savingsTotal: number;
}

export function setAsideSummary(expenses: Expense[], taxSetaside: TaxSetasideEntry[]): SetAsideSummary {
  const vidalaPaychecks = vidalaIncome(expenses);
  const vidalaTotal = vidalaPaychecks.reduce((s, e) => s + (e.amount || 0), 0);
  const taxOwed = vidalaTotal * TAX_RATE;
  const taxAside = taxSetaside.reduce((s, t) => s + (t.amount || 0), 0);
  const savings = savingsTransfers(expenses);
  return {
    vidalaPaychecks,
    vidalaTotal,
    taxOwed,
    taxAside,
    taxBalance: taxOwed - taxAside,
    savings,
    savingsTotal: savings.reduce((s, e) => s + (e.amount || 0), 0),
  };
}

/** Newest-first tax log, capped at 8 rows like the old table. */
export function recentTaxLog(taxSetaside: TaxSetasideEntry[]): TaxSetasideEntry[] {
  return [...taxSetaside].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 8);
}

/** Recent-expenses table: newest first, capped at 30 (renderRecentExpenses). */
export function recentExpenses(expenses: Expense[]): { recent: Expense[]; total: number } {
  const items = [...expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { recent: items.slice(0, 30), total: items.length };
}
