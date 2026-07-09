/**
 * csvImport.ts — pure client-side half of the CSV bank-import flow
 * (money.js _merchantKey / _renderCsvPreview / confirmCsvImport). Parsing and
 * auto-categorization happen server-side (/api/csv/parse); these helpers
 * cover the preview math, row edits, and the learn-rules derivation.
 */
import type { CsvRow, CsvSelection, LearnRule } from './types';

/** Stable merchant key: first 2 lowercased alphanumeric-ish words of the
 * description (e.g. "H-E-B #476 AUSTIN" → "h-e-b #476" → "h-e-b 476"…). */
export function merchantKey(desc: string): string {
  if (!desc) return '';
  const words = desc
    .toLowerCase()
    .replace(/[^a-z0-9 *-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 2).join(' ');
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

/** Immutable row edits (the old code mutated module-scope _csvRows in place). */
export function setRowCategory(rows: CsvRow[], idx: number, category: string): CsvRow[] {
  return rows.map((r, i) => (i === idx ? { ...r, category } : r));
}

export function setRowInclude(rows: CsvRow[], idx: number, include: boolean): CsvRow[] {
  return rows.map((r, i) => (i === idx ? { ...r, include } : r));
}

/** Add a just-typed category to the known list, kept sorted, no dupes. */
export function addKnownCategory(categories: string[], name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed || categories.includes(trimmed)) return categories;
  return [...categories, trimmed].sort();
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
    }));
}

/** One rule per unique merchant key: included, categorized rows only —
 * so future imports auto-categorize (confirmCsvImport learn_rules). */
export function deriveLearnRules(rows: CsvRow[]): LearnRule[] {
  const seen = new Set<string>();
  const rules: LearnRule[] = [];
  for (const r of rows) {
    if (!r.include || !r.category || r.category === 'Uncategorized') continue;
    const key = merchantKey(r.desc);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rules.push({ match: key, category: r.category });
  }
  return rules;
}

/** "desc truncated to 60 chars with ellipsis" from the preview table. */
export function truncateDesc(desc: string, max = 60): string {
  return desc.length > max ? desc.substring(0, max) + '…' : desc;
}
