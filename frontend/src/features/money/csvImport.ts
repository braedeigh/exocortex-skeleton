/**
 * csvImport.ts — pure client-side half of the bank-statement import on the
 * Money page (CsvImportSection.tsx draws it). The server reads the CSV,
 * guesses each row's category, and names rows it has learned (/api/csv/parse
 * in routes/money.py); these helpers cover everything after that:
 *
 *   - identifying rows — each row carries a name ("what is it?") and a
 *     category. Naming or categorizing one row fills in the other rows from the
 *     same merchant that she hasn't touched yet;
 *   - confirming rows — like the receipt scanner (kitchen/ReceiptImportModal),
 *     an included row counts as confirmed once she taps it or changes it;
 *   - splitting the preview into months, with money out / in per month;
 *   - the import payload, plus the rules learned from it: merchant→category
 *     and merchant→name, keyed by statementMerchant.ts so a rule matches the
 *     merchant and not just the first two words of the line.
 * Prompt: "i want to be able to identify things from a statement similar to
 * how i identify objects from the receipt scanner" / "split by month better
 * and … auto fill expense type on each expense entry".
 */
import { readStatementMerchant } from './statementMerchant';
import type { CsvRow, CsvSelection, LabelRule, LearnRule } from './types';

/** Stable merchant key for learned rules — the merchant's stretch of the line
 * ("TST*COSMIC COFFEE - EAS 07/15 …" → "cosmic coffee"). */
export function merchantKey(desc: string): string {
  return readStatementMerchant(desc).key;
}

export function isUncategorized(category: string | undefined): boolean {
  return !category || category === 'Uncategorized';
}

export interface CsvPreviewSummary {
  includedCount: number;
  /** Sum of |amount| over included rows. */
  includedTotal: number;
  uncategorizedIncluded: number;
}

export function summarizeCsvRows(rows: CsvRow[]): CsvPreviewSummary {
  const included = rows.filter((r) => r.include);
  return {
    includedCount: included.length,
    includedTotal: included.reduce((sum, r) => sum + Math.abs(r.amount), 0),
    uncategorizedIncluded: included.filter((r) => isUncategorized(r.category)).length,
  };
}

/** Give every freshly parsed row a name: the learned one when the server had
 * it, else the preview's guess from the raw line. */
export function prepareRows(rows: CsvRow[]): CsvRow[] {
  return rows.map((r) => ({
    ...r,
    title: r.title || readStatementMerchant(r.desc).name,
    learned_title: r.title || '',
  }));
}

/** Identify one row, and fill the same answer into its merchant's other rows.
 * The edited row counts as confirmed; the filled-in rows stay unconfirmed, so
 * she still glances at each (one Amazon order isn't every Amazon order). */
export function identifyRow(rows: CsvRow[], idx: number, patch: { title?: string; category?: string }): CsvRow[] {
  const key = merchantKey(rows[idx]?.desc ?? '');
  return rows.map((r, i) => {
    if (i === idx) return { ...r, ...patch, user_touched: true };
    if (key && !r.user_touched && merchantKey(r.desc) === key) return { ...r, ...patch };
    return r;
  });
}

/** Tick or untick one row; that counts as touching it. */
export function setRowInclude(rows: CsvRow[], idx: number, include: boolean): CsvRow[] {
  return rows.map((r, i) => (i === idx ? { ...r, include, user_touched: true } : r));
}

export function confirmRow(rows: CsvRow[], idx: number): CsvRow[] {
  return rows.map((r, i) => (i === idx && !r.user_touched ? { ...r, user_touched: true } : r));
}

export function confirmAll(rows: CsvRow[]): CsvRow[] {
  return rows.map((r) => (r.user_touched ? r : { ...r, user_touched: true }));
}

/** Rows waiting on her: included and not yet confirmed. Unticked rows (her own
 * transfers, rows already imported) never need confirming. */
export function needsConfirming(r: CsvRow): boolean {
  return r.include && !r.user_touched;
}

export function countConfirmed(rows: CsvRow[]): { confirmed: number; total: number; allConfirmed: boolean } {
  const included = rows.filter((r) => r.include);
  const confirmed = included.filter((r) => r.user_touched).length;
  return { confirmed, total: included.length, allConfirmed: confirmed === included.length };
}

/** Add a just-typed category to the known list, kept sorted, no dupes. */
export function addKnownCategory(categories: string[], name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed || categories.includes(trimmed)) return categories;
  return [...categories, trimmed].sort();
}

export interface MonthGroup {
  /** "2026-07", or "" for rows without a readable date. */
  key: string;
  label: string;
  /** The rows in this month, each with its index in the full list. */
  rows: { row: CsvRow; index: number }[];
  /** Included money out / in this month, as positive dollars. */
  moneyOut: number;
  moneyIn: number;
}

/** Split the preview into calendar months, in the statement's own order. */
export function groupByMonth(rows: CsvRow[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  rows.forEach((row, index) => {
    const key = /^\d{4}-\d{2}/.test(row.date) ? row.date.slice(0, 7) : '';
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, label: monthLabel(key), rows: [], moneyOut: 0, moneyIn: 0 };
      groups.push(group);
    }
    group.rows.push({ row, index });
    if (row.include) {
      if (row.amount < 0) group.moneyOut += -row.amount;
      else group.moneyIn += row.amount;
    }
  });
  return groups;
}

function monthLabel(key: string): string {
  if (!key) return 'No date';
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/** The import payload: every included row, defaulting category to Uncategorized. */
export function buildSelections(rows: CsvRow[]): CsvSelection[] {
  return rows
    .filter((r) => r.include)
    .map((r) => ({
      date: r.date,
      desc: r.desc,
      amount: r.amount,
      category: r.category || 'Uncategorized',
      title: (r.title || '').trim(),
    }));
}

/** One category rule per merchant: included, categorized rows only — so
 * future imports auto-categorize. */
export function deriveLearnRules(rows: CsvRow[]): LearnRule[] {
  const seen = new Set<string>();
  const rules: LearnRule[] = [];
  for (const r of rows) {
    if (!r.include || isUncategorized(r.category)) continue;
    const key = merchantKey(r.desc);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rules.push({ match: key, category: r.category });
  }
  return rules;
}

/** One name label per merchant, only for names she taught: a name that is
 * just the preview's own guess, or the label it already had, teaches nothing. */
export function deriveLearnLabels(rows: CsvRow[]): LabelRule[] {
  const seen = new Set<string>();
  const labels: LabelRule[] = [];
  for (const r of rows) {
    const title = (r.title || '').trim();
    if (!r.include || !title) continue;
    const merchant = readStatementMerchant(r.desc);
    if (!merchant.key || seen.has(merchant.key)) continue;
    if (title === merchant.name || title === r.learned_title) continue;
    seen.add(merchant.key);
    labels.push({ match: merchant.key, title });
  }
  return labels;
}
