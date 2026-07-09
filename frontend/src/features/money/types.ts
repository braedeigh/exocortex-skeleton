/**
 * Money tab payload types — shape of GET /api/data/money (server.py
 * get_data_money) plus the request/response bodies of routes/money.py.
 * Hand-written to match the JSON the Flask side actually emits.
 */
import type { FrostedStream } from '../todos/types';

export { isFrosted } from '../todos/types';
export type { FrostedStream };

export interface BudgetCategory {
  name: string;
  planned: number;
  /** variable | fixed | savings */
  type?: string;
}

export interface Budget {
  income_monthly: number;
  categories: BudgetCategory[];
  /** Bank deep-link for downloading a fresh CSV. Stripped server-side in public mode. */
  bank_csv_url?: string;
}

export interface Expense {
  id: string;
  date?: string;
  amount: number;
  category?: string;
  comments?: string;
  /** Short human label, editable in the breakdown drill-down. */
  title?: string;
  /** 'receipt_import' rows get merged with bank rows on CSV import. */
  source?: string;
  bank_matched?: boolean;
}

export interface Subscription {
  name: string;
  /** Presentation-only override; `name` stays the transaction-match key. */
  display_name?: string;
  amount: number;
  /** monthly | yearly */
  frequency?: string;
  next_renewal?: string;
  cancel_url?: string;
  notes?: string;
  bill_day?: number | null;
}

export interface TaxSetasideEntry {
  id: string;
  date?: string;
  amount: number;
  notes?: string;
}

export interface ReceiptEntry {
  filename: string;
  uploaded?: string;
  parsed?: boolean;
}

/** To-dos category-tagged 'money' (D.tab_todos) — the strip at the top of the page. */
export interface TabTodo {
  id?: string;
  text: string;
  due_by?: string | null;
}

export interface MoneyData {
  server_date?: string;
  budget?: Budget | FrostedStream;
  expenses?: Expense[] | FrostedStream;
  subscriptions?: Subscription[] | FrostedStream;
  receipts_map?: Record<string, ReceiptEntry>;
  tax_setaside?: TaxSetasideEntry[] | FrostedStream;
  tab_todos?: TabTodo[] | FrostedStream;
  [key: string]: unknown;
}

// --- CSV import (POST /api/csv/parse response rows) ---

export interface CsvRow {
  date: string;
  desc: string;
  /** Signed: negative = expense, positive = income/credit. */
  amount: number;
  category: string;
  include: boolean;
  already_imported?: boolean;
}

export interface CsvParseResponse {
  rows: CsvRow[];
  categories: string[];
}

export interface CsvSelection {
  date: string;
  desc: string;
  amount: number;
  category: string;
}

export interface LearnRule {
  match: string;
  category: string;
}

export interface CsvImportResult {
  ok: true;
  added: number;
  merged_with_receipt: number;
  rules_learned: number;
  categories_added: number;
}

export interface AutoDetectResult {
  added: number;
  skipped: number;
}
